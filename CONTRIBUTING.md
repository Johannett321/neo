# Contributing to Neo

Thanks for taking a look. This is a small, opinionated app built for project managers and
team leads running several projects at once; the fastest way to get a change merged is to
understand what it is trying to be before you change it.

Start with [`README.md`](README.md) — it explains what every feature is for and why it
exists, and most of those decisions were arrived at deliberately. [`CLAUDE.md`](CLAUDE.md)
is the architecture tour: the typed IPC contract, the database rules, and the conventions
that will break things if you work around them.

## Getting set up

Node.js 22 or newer. Nothing else — the database is embedded, so there is no server to
start.

```bash
git clone https://github.com/Johannett321/neo.git
cd neo
npm install && npm run dev
```

Your data lives in `~/.neo`. Development and a packaged build **share that
folder**, and PGlite has no lock of its own, so do not run two copies at once — the app
takes a single-instance lock, but a dev build and an installed build have different bundle
identifiers, which is why there is also a `.lock` file holding the owning pid.

Load the sample data from the first-launch panel to get something realistic to work
against.

## Before you open a pull request

```bash
npm run typecheck       # both TypeScript projects
npm run verify          # the whole backend, headless, in plain Node
npm run verify:upgrade  # opens a database written by an older version
```

All three must pass. There is no linter and no test framework: `test/verify.ts` and
`test/upgrade.ts` are single scripts of `ok(label, condition)` assertions, run end to end
in a few seconds. You cannot run one assertion in isolation — run the script.

- **Changed backend behaviour?** Add an assertion to `test/verify.ts`.
- **Changed the schema?** Add one to `test/upgrade.ts` too, and read the migrations rules
  in `CLAUDE.md` first. PostgreSQL parses every statement in a batch before executing any
  of them, so a statement that mentions a column an `ALTER` is about to add must live
  below it in `MIGRATIONS`, in a later group. That bug has shipped twice.

## The constraints that are not up for negotiation

These are the product, not implementation details. A pull request that breaks one of them
will be asked to change, however good the code is.

- **No status field the user maintains by hand.** No RAG rating, no percent-complete, no
  health dropdown. Attention is *derived* — from overdue work, deadline proximity and
  staleness — in `src/main/lib/attention.ts`, and it returns the single most pressing fact
  in plain words, never a level, a badge or a colour. A project manager will not keep a
  status field true across five projects, so a feature that depends on them doing so is
  abandoned in three weeks and takes the rest of the app with it.
- **Workspace isolation is a hard boundary.** Every scoped IPC channel takes an explicit
  `workspaceId`; there is no implicit "all", and no screen may mix two workspaces.
- **Every mutation logs activity** via `logActivity()`, and handlers that change project
  content also call `mirrorProject()`. That is what makes the re-entry brief and the
  Markdown mirror work.
- **The assistant asks before every write.** Every tool marked `writes: true` must have a
  `summary()` that returns the confirmation sentence, with ids resolved to names and dates
  validated *before* the question is asked. There is deliberately no allowlist of "safe"
  writes.
- **Nothing phones home.** No analytics, no telemetry, no crash reporting, no update
  check. The only outbound request the app ever makes is a question you typed into the
  assistant, on your own OpenAI key. Please do not add a dependency that changes that.
- **The app stays free.** No billing, no licence keys, no paid tier, no "pro" features.

## Adding an IPC channel

`src/shared/api.ts` is the spine. Add the channel to `ApiMap` first, with its input and
output types; everything else then fails to compile until it is wired up — the main
handler through `handle<C>()`, and the renderer call through `useApi` / `useApiMutation`.

If the assistant needs to do something, give it the *channel*, not its own SQL. Tools call
`invokeChannel()` so that a task the assistant creates goes down the same code path as one
you create by hand, and therefore logs activity, bumps the project clock and lands in the
Markdown mirror for free.

## Style

Match the file you are in. A few house rules worth knowing:

- Icons are hand-rolled paths in `components/Icon.tsx` on a 24px grid — add a path, not a
  dependency.
- Dates use `components/DateField.tsx`, never `<input type="date">`. Calendar dates are
  stored as `text` in `YYYY-MM-DD`, never as `date` columns.
- Right-click menus go through `lib/contextMenu.tsx`, including the confirmation step for
  destructive actions. Do not reimplement a confirm at a call site.
- Settings screens are panes in `components/SettingsLayout.tsx`, not sections stacked in a
  scroll.
- Workspace colours are identifiers — a dot or a 2px rule, never a filled block.

## Reporting a bug

Say what you did, what happened, and what you expected. Include your OS and the version
from **Settings → About**. If it involves the database, `npm run verify` and
`npm run verify:upgrade` output is useful. Please do not attach your data folder — it is
your actual work.

## Security

If you find something with security implications, please open a private security advisory
on GitHub rather than a public issue.

By contributing, you agree that your contributions are licensed under the
[MIT Licence](LICENSE).
