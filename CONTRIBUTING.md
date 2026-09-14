# Contributing to Neo

Thanks for taking a look. This is a small, opinionated app built for project managers and
team leads running several projects at once; the fastest way to get a change merged is to
understand what it is trying to be before you change it.

Start with [`README.md`](README.md) — it explains what every feature is for and why it
exists, and most of those decisions were arrived at deliberately. [`CLAUDE.md`](CLAUDE.md)
is the architecture tour: the typed IPC contract, how the app talks to Neo Cloud, and the
conventions that will break things if you work around them.

## Getting set up

Node.js 22 or newer, and for anything that touches data, the server: Neo keeps everything
in Neo Cloud and nothing on the device, and the server lives in
[`neo-sync-server`](https://github.com/Johannett321/neo-sync-server) (Java 21, Maven,
Docker for its Postgres).

```bash
# the server, in its own checkout
docker compose up -d && mvn spring-boot:run

# the app, pointed at it
git clone https://github.com/Johannett321/neo.git
cd neo
npm install && NEO_CLOUD_URL=http://localhost:8080 npm run dev
```

Without `NEO_CLOUD_URL` a development build signs in to production Neo Cloud. Make an
account on the sign-in screen, then load the sample data from the first-launch panel to
get something realistic to work against.

## Before you open a pull request

```bash
npm run typecheck                                   # both TypeScript projects
NEO_CLOUD_URL=http://localhost:8080 npm run verify  # the main process against a server
```

Both must pass. There is no linter and no test framework: `test/verify.ts` is a single
script of `ok(label, condition)` assertions, run end to end against a running server. You
cannot run one assertion in isolation — run the script.

- **Changed what a channel does?** Add an assertion to `test/verify.ts`.
- **Changed the API or the data?** That is a change to the server: the OpenAPI spec first,
  then its controller and its tests, then `npm run gen:api` here.

## The constraints that are not up for negotiation

These are the product, not implementation details. A pull request that breaks one of them
will be asked to change, however good the code is.

- **No status field the user maintains by hand.** No RAG rating, no percent-complete, no
  health dropdown. Attention is *derived* — from overdue work, deadline proximity and
  staleness — in the server's `work/Attention.java`, and it returns the single most pressing fact
  in plain words, never a level, a badge or a colour. A project manager will not keep a
  status field true across five projects, so a feature that depends on them doing so is
  abandoned in three weeks and takes the rest of the app with it.
- **Workspace isolation is a hard boundary.** Every scoped IPC channel takes an explicit
  `workspaceId`; there is no implicit "all", and no screen may mix two workspaces.
- **Every mutation logs activity**, on the server, via `Activity.log()`. That is what makes
  the re-entry brief work.
- **The assistant asks before every write.** Every tool marked `writes: true` must have a
  `summary()` that returns the confirmation sentence, with ids resolved to names and dates
  validated *before* the question is asked. There is deliberately no allowlist of "safe"
  writes.
- **Nothing phones home beyond what the app is for.** The app talks to Neo Cloud, because
  that is where your work is, and to OpenAI only on a key you gave it. No analytics, no
  telemetry, no crash reporting. Please do not add a dependency that changes that.
- **What an account may use is decided in one place.** Everybody is on the free plan and
  it includes everything. The server's `Entitlements` and the `features` on
  `/v1/account` exist so a feature can later be kept for a paid plan without every screen
  learning a new question — do not check a plan anywhere else.

## Adding an IPC channel

`src/shared/api.ts` is the spine. Add the channel to `ApiMap` first, with its input and
output types; everything else then fails to compile until it is wired up — the main
handler through `handle<C>()`, and the renderer call through `useApi` / `useApiMutation`.

If the channel reads or writes data, it is a request to Neo Cloud: add the endpoint to the
server's OpenAPI spec, implement it there, run `npm run gen:api`, and make the handler the
one or two lines that call it through `api` in `lib/cloud/client.ts`.

If the assistant needs to do something, give it the *channel*, not its own request. Tools
call `invokeChannel()` so that a task the assistant creates goes down the same code path
as one you create by hand, and therefore logs activity and bumps the project clock for
free.

## Style

Match the file you are in. A few house rules worth knowing:

- Icons are hand-rolled paths in `components/Icon.tsx` on a 24px grid — add a path, not a
  dependency.
- Dates use `components/DateField.tsx`, never `<input type="date">`. Calendar dates travel
  as `YYYY-MM-DD` text, never as instants.
- Right-click menus go through `lib/contextMenu.tsx`, including the confirmation step for
  destructive actions. Do not reimplement a confirm at a call site.
- Settings screens are panes in `components/SettingsLayout.tsx`, not sections stacked in a
  scroll.
- Workspace colours are identifiers — a dot or a 2px rule, never a filled block.

## Reporting a bug

Say what you did, what happened, and what you expected. Include your OS and the version
from **Settings → About**. If it involves data, `npm run verify` output against a local
server is useful. Please do not attach an export of your account — it is your actual
work.

## Security

If you find something with security implications, please open a private security advisory
on GitHub rather than a public issue.

By contributing, you agree that your contributions are licensed under the
[MIT Licence](LICENSE).
