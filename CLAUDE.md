# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Neo is an Electron desktop app: a personal command centre for running several working
lives at once (a day job, your own company, a client). `README.md` explains what each
feature is for and why it exists — read it before designing anything user-facing, because
most of the product decisions here were arrived at deliberately and are worth honouring.

**Everything lives in Neo Cloud; the device keeps only a copy and a queue.** The app is a client of the
server in `../server` (Java / Spring Boot, "Neo Cloud"): every workspace, note,
meeting and recording is stored there, the business logic that used to run in this main
process runs there — the assistant included — and the two talk REST over an OpenAPI
contract. Signing in is not optional — the window is the sign-in screen until there is an
account. What this machine keeps is the device token, a last-known copy of the
window's data and the writes still waiting to be sent — all three sealed with
`safeStorage`, per account, and gone on signing out (see *Cache and queued writes*
below). Using Neo Cloud is free and includes everything, with a daily allowance on
the two things that cost money to run (5 assistant messages, 60 minutes of transcription);
`/v1/account` reports the plan, its features and today's usage so the app can say "3 of 5
left today", and a later paid plan can lift the limits without the app learning a new
question.

## Commands

```bash
npm run dev             # dev-branding.mjs, then electron-vite dev with hot reload
npm run build           # typecheck (node + web) + electron-vite build
npm run typecheck       # both projects; typecheck:node / typecheck:web individually
npm run gen:api         # regenerate src/main/lib/cloud/schema.ts from Neo Cloud's published spec
npm run check:contract  # fail if schema.ts is not what the published spec generates
npm run verify          # the main process's handlers against a running Neo Cloud, headless
npm run verify:team     # the team chart's rules (renderer/lib/team.ts), no server needed
npm run package         # unpacked app into dist/
npm run dist            # packaged, signed-if-possible application
```

There is no linter and no test framework. `test/verify.ts` is a single script of
`ok(label, condition)` assertions run end to end, bundled by esbuild with `electron` aliased
to `test/electron-stub.mjs`, which fakes `app`, `ipcMain`, `dialog`, `shell` and
`safeStorage` so the real main process runs with no window. It needs a Neo Cloud to talk
to: run the server locally (`docker compose up -d && mvn spring-boot:run` in
`../server`) and point the run at it with `NEO_CLOUD_URL`. The assistant's runs need that
server started against its scripted OpenAI stand-in — `python3 test/fake_openai.py 18099`
in `../server`, then `NEO_OPENAI_BASE_URL=http://127.0.0.1:18099/v1 OPENAI_API_KEY=test`
on the server, as CI does. Each run registers a fresh account, so runs do not see each
other, and it spends that account's whole daily allowance of assistant messages on
purpose: the sixth is the one that asserts the limit. The few facts no channel can reach (a
heartbeat gone quiet, a transcript only a speech service could write) are set and read
with `psql` — inside the compose file's `neo-cloud-pg` container, or at
`NEO_VERIFY_DATABASE_URL` when one is given, as CI does.

Development builds reach a local server the same way: `NEO_CLOUD_URL=http://localhost:8080
npm run dev`. Without it the app talks to production Neo Cloud.

Add an assertion to `test/verify.ts` for any behaviour you change. A behaviour of the data
itself — a validation, a side effect, an ordering — lives in the server now, and belongs in
its tests too.

## Architecture

Three processes, one typed contract.

**`src/shared/api.ts`** is the spine. `ApiMap` maps every IPC channel to `{ in, out }`.
Main registers handlers through `handle<C>()` (`src/main/ipc/util.ts`), preload exposes a
single `invoke`, and the renderer calls `useApi` / `useApiMutation` / `call`
(`src/renderer/src/lib/api.ts`). Adding a channel means adding it to `ApiMap` first;
everything else then fails to compile until it is wired up.

**There are two contracts, one behind the other.** The renderer talks IPC (`ApiMap`) and
has not changed shape; almost every handler in `src/main/ipc/` is a line or two that turns
its channel into a request to Neo Cloud through `api` in `lib/cloud/client.ts`, a client
typed from Neo Cloud's OpenAPI spec (`lib/cloud/schema.ts`, committed).

**Neo Cloud is the source of truth, and this app is one of its clients.** The server
publishes its spec at `https://sync.neomoon.io/openapi/neo-cloud.yaml`, and `npm run
gen:api` generates `schema.ts` from there — never from the server's repository checked out
beside this one, and never from another client. `npm run check:contract` fails when the
committed file is not what the published spec generates, and CI runs it. Adding a feature
that touches data therefore means: the spec in the server repository first, its controller,
deploy, `npm run gen:api` here, then the channel. (`NEO_CLOUD_SPEC` points generation at a
local server or file while the API is not deployed yet.)

**Both directions are checked.** The OpenAPI types check what is sent, and `must()` returns
the spec's own response type, so a handler whose channel in `ApiMap` promises something the
server does not send does not compile — `shared/types.ts` cannot drift from the spec
without a red build. The exceptions are documents the server stores without reading
them, a canvas's board, a project's team chart and a message's tool records; the spec calls those open objects, and
`lib/cloud/documents.ts` narrows that one field in one place rather than casting a response. `Args<C>` in the renderer is a
conditional tuple that makes the input *required* for channels that take one — that is
deliberate, and it is what stops a workspace-scoped channel being called with no
workspace and quietly returning everything.

**Main** (`src/main/`) owns the account's token, the filesystem and the shell; none of
them ever reach the renderer. `ipc/` holds handlers grouped by domain, `lib/` what is not a
handler: `cloud/` (the client, the session, the event stream, passkey sign-in, the
assistant's run relay), the notification runner, the updater, the audio tap, the weather.

`handle()` also records every handler in a registry, and `invokeChannel()` calls one from
inside main — start-up and the notification runner read settings and workspaces through
the same channels the renderer uses rather than a second set of requests beside them.

**A write this window did not make still reaches the screen.** A click resolves a
mutation, and `useApiMutation` invalidates the cache on the way back (the common writes
are drawn before that — see *Cache and queued writes*). Anything else — a
write on another device, the assistant's tools, Claude through the remote connector —
happens in Neo Cloud, which says `changed` on the event stream that `lib/cloud/events.ts`
holds open. `lib/changes.ts` coalesces the announcements and sends one `data` message, and
`useLiveData()` at the top of `App.tsx` empties the cache, exactly as a mutation does.
The one gap is this device's own assistant: Neo Cloud tells every device about a write
*except the one that made it*, and the assistant's tools write as this device. So the run
relay announces the change itself when a tool that was asked about (an `approval`)
reports `done` — a read is never asked about, so looking things up never refetches.

**The assistant runs in Neo Cloud; this app relays it.** The loop, the 30 tools, the
system prompt, the confirmations and the OpenAI call (on the operator's key) are the
server's `work/assistant/run/`. `chat:send` in `ipc/chat.ts` hands off to
`lib/cloud/assistant.ts`, which uploads any files to the conversation first, opens
`POST /v1/assistant/runs` with the device token (the token never leaves main), reads its
server-sent events and re-emits each one unchanged on the `ai` IPC channel — the server's
event data *is* the `AiEvent` union, so the panel (`lib/assistant.tsx`, `AssistantPanel`)
did not change shape. `chat:send` resolves as soon as the `started` event arrives and the
rest is relayed detached, because a turn with a question in it can wait for minutes.
`chat:respond` is `POST …/answers`, `chat:cancel` is `DELETE`, and both treat a run that has
already finished as nothing to do. A 429 is not thrown: it comes back as `{ started: false,
limit }` (`ChatSendResult`), because IPC keeps only an error's message and the panel has
to know to draw the "Neo Pro — coming soon" card rather than an error. If the stream drops
mid-turn the relay says so and sends `done`; the turn itself carries on in Neo Cloud and is
in the conversation when the panel refetches. Do not put a tool, a prompt or a model
choice back in this repository — the web and phone clients drive the same endpoint.

**Claude connects to Neo Cloud, not to this app.** Neo Cloud hosts a remote MCP server at
`https://sync.neomoon.io/mcp` (`MCP_URL` in `shared/claude.ts`), signed into with OAuth, so
Claude Desktop, claude.ai and Claude Code reach the account directly and Neo does not have
to be open. The settings pane only shows the address and the steps. `ipc/claude.ts` is
what is left on this side: it finds the stdio `neo` entry Neo 2.0 and earlier wrote into
Claude Desktop's `claude_desktop_config.json` (an entry with a `command`; a `url` entry is
the new way in and is left alone) and removes that one key, touching nothing else in the
file, writing nothing when there is nothing to remove, and refusing outright rather than
rewriting a file it cannot parse.

**Renderer** (`src/renderer/src/`) is React 19 + TanStack Query + React Router in hash
mode. `routes/` are screens, `components/` the shared pieces, `lib/` the app-wide systems
(query wrappers, workspace context, toasts, context menus, formatting).

Aliases: `@shared/*` everywhere, `@/*` → `src/renderer/src/*` in the renderer only.

### Neo Cloud

`src/main/lib/cloud/` and the server in `../server`. Read the server's README
for how a request runs there — row level security by workspace membership, SQL ported
verbatim from the TypeScript this app used to run, other devices (and other members'
devices) told after every write.

**The sign-in gate is the first thing the window draws.** `AccountGate` in `App.tsx` asks
`account:status`; signed out it is `routes/SignIn.tsx`; signed in but unreachable it is
the app drawn from this Mac's copy when there is one, and the `Offline` screen only when
there is none (the account is fine; asking for a password again would be a lie about what
went wrong); and only then the workspace provider and the rest of the app. The query
cache is emptied on signing in and out, because what was in it belonged to nobody or to
somebody else. `account:status` is left out of the invalidate-everything that follows a
mutation: who is signed in does not change because a task did.

**A username and password, or a passkey.** Password sign-in is typed in Neo's own window.
A passkey happens in the person's real browser (`lib/cloud/passkey.ts`, the server's
`/connect.html`): Neo's window is `file://`, so it cannot run a ceremony against the
server's domain, and a passkey Electron made itself would be bound to one Mac's Secure
Enclave, which iCloud Keychain does not sync. The page hands the token back to a loopback
port guarded by a `state` nonce — RFC 8252's arrangement, and `gh auth login`'s. The phone
app (`../mobile`) uses the same page from the system's authentication browser, but has no
loopback port and a custom scheme anyone can claim, so there the page trades the token for a
PKCE-bound code (`/v1/auth/handoff`) and only the code travels. A 401 from
any request means this device was signed out elsewhere: the session is forgotten and the
window hears `account` and goes back to the sign-in screen.

**What the machine keeps: the token, a copy, and a line.** Three sealed files in the
app's user-data folder, each written through `lib/cloud/sealed.ts` (`safeStorage`, or a
`plain`-marked owner-only file where there is no keychain):

- `neo-cloud-session` — the device token and the username (`lib/cloud/session.ts`).
- `neo-cache-<accountId>` — the renderer's TanStack Query cache, dehydrated
  (`lib/cloud/cache.ts`; the renderer half is `lib/persist.ts`). The same answers the
  channels gave, replaced whole a moment after the cache settles, never sent anywhere.
  Who is signed in, conversations, transcripts, search results and the updater's state
  are left out. It is hydrated before the first render, so online it is only a first
  frame and every query refetches at once; offline it is what there is to read.
- `neo-outbox-<accountId>` — writes waiting for Neo Cloud, in order, with the temporary
  ids they were drawn under and the real ids those have since been given
  (`lib/cloud/outbox.ts`).

**All three go on signing out, on a 401 (signed out elsewhere), and the cache and outbox
of any other account go when one signs in** (`forgetLocal()` in `ipc/account.ts`) — a
second account must never be shown, or send, the first one's work. Signing out with
writes still waiting asks first, by count (`AccountPane`). There is still no database
and no Markdown mirror: Neo Cloud is the source of truth and the copy is a cache of its
answers, not a second store anybody edits. Pictures fetched for the window are held in
memory (`lib/recording/media.ts`) and forgotten on sign-out. The one other file the app
writes is the JSON export, and only where the person tells it to.

**Stored files are addressed, never inlined.** An icon, banner, avatar or picture in a
note is a `neo-media://file/<name>` address (`neo-media://image/<name>` in a note's
Markdown, as it always was), and the protocol handler in main fetches it from Neo Cloud
with the token. The renderer never sees a server URL, and a page loaded in it cannot reach
one. Uploads go the other way through main: `icon:pick` reads the chosen file and sends it
to `POST /v1/files`, and the row refers to the name the server gave it. Nothing is copied
anywhere on this machine.

**Cache and queued writes.** Offline is still a state, not a mode — there is no
switch, no second store and no sync engine — but it is no longer a dead end. The decision
(which replaced "there is nothing to read without Neo Cloud") is: *the window keeps a copy
of what it last saw, and the common writes are drawn at once and kept in line until Neo
Cloud takes them.*

- **Drawn before the answer.** `renderer/lib/optimistic.ts` has one entry per channel in
  `SYNCABLE` (`shared/sync.ts`: tasks — save, status, column, delete — people and
  memberships, decisions, log entries, links, notes). `useApiMutation` finds the entry by
  channel, so call sites do nothing special: the entry patches the cached answers the
  screens draw from (`project:get`, `task:list`, `dashboard:today`, `person:list`, …)
  through a `Draft` that records what it replaced, and returns what the channel would
  have returned. `mutate()` returns that guess synchronously, so a dialog closes on Save
  and a new person and their place on the project are one click. Entries must be
  idempotent — insert-if-absent, set rather than toggle — because they are reapplied.
- **One line, in order.** The write then goes to main as `sync:submit`, and the outbox
  sends it behind anything already waiting: a create and the edit made to it a moment
  later can never pass each other, online or not. *Sent* → a create's temporary id is
  swapped for the real one throughout the cache (`reconcile`) and everything is
  invalidated as it always was. *Unheard* (no connection, or 502/503/504) → it stays in
  line on disk, the caller is answered with the guess, and the line is retried with
  backoff and the moment anything gets through (`lib/cloud/reachability.ts`, fed by every
  request and by the event stream). *Refused* → if a click is still waiting on it, the
  `Draft` is restored and a toast says what was not saved and why; if it was made
  offline, it moves to `failed`, the header lists it, and a sticky toast offers Retry and
  Discard (`sync:retry`, `sync:discard`). A refusal never holds up what is behind it.
- **Temporary ids never reach Neo Cloud.** Something created before the server has seen
  it is `tmp-<uuid>`; later writes name it freely. `lib/cloud/ids.ts` holds the pairings
  (persisted with the outbox), `handle()` in `ipc/util.ts` swaps them on the way into
  every handler and refuses one with no real id yet, and the outbox fails a queued write
  that depends on a create that was refused ("It depends on “…”, which was not saved").
  React keys use `stableKey(id)` (`renderer/lib/sync.ts`) so a row keeps its identity
  when its id changes — no flicker, no replayed entrance.
- **Waiting writes survive a refetch.** A refetch while writes are still in line answers
  without them, so `startSync` lays every waiting write back over each fresh answer as it
  lands (and over the whole cache for writes left waiting by the last session). On
  reconnect the full refetch waits for the line to drain; main announces a change when it
  has.
- **Saying so.** `components/SyncStatus.tsx` in the header (floating bottom-left on the
  writing screens) draws nothing while Neo Cloud answers and nothing waits; otherwise
  *Saving N changes…*, *Offline · N waiting*, or *N not saved*, and opens to the list.
  `Pending` says *Not on this Mac yet* offline instead of loading forever. What cannot
  work offline is disabled with a quiet line saying why: the assistant (it runs in Neo
  Cloud), starting a recording, and anything that uploads a picture.
- **Not queued, deliberately:** uploads (the bytes are not kept), the assistant, recording
  control, account business, and the less common writes (projects, folders, columns,
  meetings, settings) — those still fail offline as they always did. Audio keeps its own
  queue: a chunk that cannot be sent is held in memory, in order, and retried until it goes
  (`ipc/recordings.ts`).
- **Known limits:** a create whose response is lost after Neo Cloud stored it is sent
  again on retry and can arrive twice — there is no idempotency key on the API yet.
  Offline writes are applied last-writer-wins on arrival; there is no merge with what
  another device changed meanwhile.

**Deliberately not here any more:** the operation log, the hybrid logical clock, the sync
engine and its encryption, `~/.neo`, the Markdown mirror, the local recording pipeline.
`scripts/import-local-data.mjs` is the one-way door out of all of it: it copies an old
install's database and files into an empty Neo Cloud account.

### Conventions that matter

- **Workspace isolation is a hard boundary.** Every scoped channel takes an explicit
  `workspaceId`; there is no implicit "all". The active workspace is ambient state in
  `lib/workspace.tsx`, persisted in settings. No screen may mix two workspaces.
  **There is exactly one exception, and it is deliberate: `/all`** (`routes/Everywhere.tsx`,
  `dashboard:everywhere`, the server's `GET /v1/today/all`). The boundary's cost is that
  a card going late in the workspace you are not in is silent, and that is the deadline
  you miss — so one screen answers "is anything late or due anywhere" and nothing more.
  It holds to three rules: it is a read of Today's lists only (no attention, stats or
  front block, and each workspace's Today stays pure); every row names its workspace
  (the colour rule and the workspace's name before the project's — `showWorkspace` on
  `TaskRow`); and **every way out of a row goes through `useGoIn()`**, which switches to
  the row's workspace before navigating, so nothing ever draws one workspace's project
  inside another. `TaskDialog` asks for people in the task's own workspace for the same
  reason. Which workspaces "every" means is the server's `AccountWorkspaces`, in one
  place. Do not add a second screen like it; add to this one or fence the new thing.
- **A workspace is shared whole, or not at all.** Members of a shared workspace see and
  edit everything in it; the owner alone invites, removes, renames, archives and deletes
  (`workspace.role`, and the server refuses the rest in words). Nothing in this app
  decides who may see what — Neo Cloud's row level security does, by membership — so
  there is no per-project sharing and no client-side filtering to add. The Members pane
  and the switcher's *Join a workspace* are `components/Sharing.tsx`; an invite link is
  shown once, at creation, because the server keeps only its hash. A workspace nobody
  else is in must look exactly as it did before sharing existed: `AvatarStack` draws
  nothing for it. `person.isMe` now means "the account reading", so in a shared
  workspace every member is a person and each sees themselves as *me*.
- **Attention is derived, never stored.** `work/Attention.java` in Neo Cloud computes it from
  overdue work, deadline proximity and staleness, and returns the single most pressing
  fact in plain words — never a level, a badge or a colour. Thresholds live in one place.
  Do not add a status field the user has to maintain by hand — that is the central product
  constraint. (The graded health level this replaced was removed deliberately: the colour
  had to be decoded and clashed with the workspace palette. Colour on a project now means
  identity only.)
- **A notification is the attention line, delivered.** `work/notifications/Notify.java`
  in Neo Cloud is the pure half — rows and preferences in, sentences out, the way
  `Attention` works — and `lib/notifier.ts` here is the runner that puts them on the
  desktop. Every one of the
  five moments is read off a deadline or a due date, so **there is no reminder object**:
  nothing to create, snooze or tidy up, and nothing that can go stale. Three rules hold
  it up. **One notification per kind, never one per item** — four cards due tomorrow is
  one sentence, because an app with four cards in the notification centre is an app
  whose notifications get switched off. **An exact day, never a window**: a warning
  fires on the morning that is exactly N days out and on no other, because a window
  would fire again every day until the date arrived. And **one delivery a day**, at an
  hour set in app settings — a deadline is a calendar fact and nothing about it happens
  at 14:07. Whether this *machine* may interrupt you, when, and at weekends are app
  settings; *what is worth saying* is per workspace, the same seam the recording
  settings are split along. Being said once is a row and a unique index in Neo Cloud
  (`notification (account_id, workspace_id, kind, on_date)` — each member of a shared
  workspace is told once), claimed with `POST /v1/notifications`
  **before** the notification is shown — never a timer and never a comparison of
  timestamps, so four restarts before lunch interrupt you once, and two Macs signed in to
  the same account do not both say it. `notification:pending` is a channel rather than
  something the runner works out privately so the settings pane can show the real
  sentence; every question about what is *inside* a workspace goes through the scoped
  channel, one workspace at a time.
  **A notification that failed does not throw.** `show()` returns at once and a refusal
  arrives on a `failed` event a moment later, so `showNotification()` awaits `show` or
  `failed` and reports what the desktop actually did — a version that returned as soon
  as it had asked said "Sent" while nothing appeared. There is no API for *may I?*
  either: showing one **is** the request, which is why `notification:test` is both the
  button in settings and what the first-run flow presses to make macOS put its question
  on screen. Only macOS asks — `notification:capability` reports `gated`, and that is
  what decides whether the flow has that panel at all, because a consent screen on a
  platform that never asks is a step that does nothing.
- **Pausing is the one hand-set state, and it only subtracts.** `status = 'paused'` is
  set from the project card's context menu or the Status field, and the whole of what it
  does is fence *being asked something* — `dashboard:today` (tasks, meeting to-dos,
  needs-a-look and the header counts, all through the one `inWorkspace` clause) and
  `notification:pending`, which repeats that clause word for word. A notification is
  Today reaching out to you rather than waiting to be opened, so the two have to answer
  the same way; that is the extent of it, and it is not a licence to add a third.
  It is allowed past the no-hand-kept-
  status rule for the same reason a folder is: nothing *derives* anything from it, and a
  stale one costs you a quiet project rather than a wrong answer. On the projects page it
  only ever changes how loud a card is — the band across its corner, and the whole card
  at half opacity until you point at it — never whether it is there. It must not
  start meaning anything more: not excluded from search, the timeline or the review.
  Archiving is what hides a project; pausing only stops it asking. The band is
  `base-content` as a fill rather than any hue, because every colour in this app is
  already spoken for — see the note at the top of `styles.css`.
- **A folder is filing, and only filing.** `project_folder` (self-referencing, workspace
  scoped) groups project cards and nothing else — no dates, no state, no work of its own,
  and nothing derived reads it. It is the one piece of organisation the user maintains by
  hand, which is allowed precisely because nothing depends on it being right. Deleting one
  lifts its projects and subfolders up a level rather than cascading; `folder:save` refuses
  a parent inside the folder's own branch, and every recursive walk over the tree carries a
  depth guard.
  The projects page navigates them the way a file browser does — a folder is a card, it
  opens, breadcrumbs are the way back, and the open folder is a `?in=` query parameter so
  Back walks up. That model is chosen for the person with no folders at all: with none,
  the page must be exactly the grid of project cards it was before the feature existed.
  Do not add chrome that only makes sense once folders are in use.
  **The breadcrumb trail is the way back *out*.** Every crumb above the open folder is a
  drop target, and the root always is, so unfiling is the same gesture aimed one level
  up rather than a second mechanism. It only works if it can be seen, so while anything
  is in the air each crumb that would accept it draws the same dashed outline a folder
  does — `components/FolderTrail.tsx`, shared by every page that files.
- **Notes and meetings file the same way, one level down.** `content_folder` is the
  project-scoped twin of `project_folder`: same rules, same words on screen, and a
  `kind` of `note` or `meeting` because the two lists are separate trees that must never
  see each other — a folder showing in both would be a place where half of what you
  filed is invisible. One table and one pair of endpoints (`/v1/content-folders`, with the
  fencing in the server's `work/ContentFolders.java` because saving a meeting needs it too)
  rather than two of each that drift.
  There is deliberately **no `contentFolder:list`**: the trees come back on
  `ProjectDetail`, which is the one call every screen that draws them has already made.
  The renderer's half is `components/ContentFolders.tsx` — `useFiling()` holds where you
  are and what is in the air, and both lists compose the same pieces, so a note row and a
  meeting row differ only in what they draw. `lib/folders.ts` in the renderer is written
  against the least a folder can be, so the walking is shared with the projects page.
- **A collapsible is filing that stays on the page.** `project_collapsible` (workspace
  scoped, its `folder_id` naming the level it is drawn at) is a named band under the
  loose cards, and `project.collapsible_id` points into it. It is a second concept rather
  than a flag on a folder because the two answer different questions: a folder is
  somewhere you *go* — clicking it replaces the page — and a collapsible is somewhere
  things *are*, still on screen until you fold it shut. The two therefore compose: a
  project is filed in a folder and grouped in a band on that folder's page. **A band and
  the cards in it are always at the same level**, and that is the one invariant —
  `checkCollapsible()` enforces it on every write, `project:save` clears
  `collapsible_id` whenever `folder_id` changes, `folder:delete` lifts the bands along
  with the cards in them, and `collapsible:save` refuses to move a band to another page
  rather than stranding what is in it. Otherwise it is furniture, exactly like
  `sort_order`: nothing derives from it and it logs no activity. With no band at this level the page draws precisely the grid it drew
  before the feature existed — no rule, no heading, no drop strip.
- **Arranging the cards is filing too.** `project.sort_order` is what a drag between two
  project cards writes, through `project:reorder` — the whole visible set of one folder,
  because a position only means anything among its neighbours. **Zero means "never placed
  by hand"**, which is why `reorder()` numbers from one and why there is no backfill: an
  untouched grid sorts on the clauses behind it and draws exactly as it always did.
  `PROJECT_ORDER` in the server's `work/Queries.java` puts `sort_order` *before* `is_pinned` —
  the other way round and a pinned card would snap back the moment you dropped it
  somewhere else. Filing a project into a different folder resets it to zero, since its
  old number described old neighbours. It logs no activity: where a card sits is not a
  fact about the project.
- **A project's people are its team chart.** There is no People tab: `ProjectTeam.tsx`
  is the one screen for who is on a project, and it opens `CastMemberModal` (search the
  workspace first, then a new person) for adding someone and for editing their details
  on this project. `/projects/:id/people` redirects to `team`. Anything a person-on-a-
  project needs — a new field, a new action — goes on the card, the list's row menu or
  that dialog, not on a list beside the chart.
- **The team chart is furniture too.** `team_canvas` in Neo Cloud is one open JSON
  document per project (`team:get` / `team:save`, `lib/cloud/documents.ts` narrows it),
  and nothing derives anything from it — saving logs no activity. Its meaning is
  `renderer/src/lib/team.ts`: `parentId` is *reports to* (a tree, laid out by
  `layout()`), `boxId` is *sits in* (a table in a labelled box — and a box may sit in a
  box, to any depth), and only nodes that are neither keep an `x`/`y`. A card names a
  `personId` and nothing more; roles stay on the membership, and someone who left the
  project is dropped by `sanitize()` rather than drawn. `routes/project/ProjectTeam.tsx`
  saves with `call()` and `setQueryData`, not a mutation, so dragging cards never
  refetches the rest of the app. Every node's position is a set of motion values the
  layout only *targets*, which is why drops spring rather than jump and the connectors
  (drawn from the same values) never lag. **The rules below are the contract the web
  and phone clients port; `npm run verify:team` (`test/team.ts`) asserts them.**
  - *The document.* `{ version: 1, nodes: TeamNode[] }`, each node `{ id, kind:
    'person' | 'box', personId?, label?, x, y, parentId?, boxId?, order? }`. Boxes in
    boxes added no field and no version: a box simply carries `boxId` the way a card
    always could, so a chart without nesting is read, repaired and drawn exactly as
    before. `order` places a node among its siblings — same `parentId`, or same
    `boxId` — ascending, missing = 0. `x`/`y` are the top-left of a free node, in board
    units, snapped to the 24-unit grid when written.
  - *`sanitize()`*, run on every read, in this order, each step walking the nodes in
    document order: (1) keep a `person` whose `personId` is on the project and every
    `box`; drop any other kind and any repeat of an id (the first wins). (2) `boxId` is
    cleared unless it names a box other than the node itself; a node with a `boxId`
    has its `parentId` cleared; a `parentId` naming no node is cleared. (3) box rings:
    follow `boxId` up from each node in turn (reading the nodes as repaired so far);
    if the chain comes back to that node, clear *its* `boxId` — so the first node the
    document lists on a ring steps out, and the rest stay nested. (4) a `parentId`
    naming a node that sits in a box is replaced by the *outermost* box around that
    node (follow `boxId` to the top): nothing hangs in the tree from inside a box.
    (5) reporting loops: walk `parentId` up from each node in turn (reading nodes as
    repaired so far); if any node is met twice, clear this node's `parentId`.
  - *`layout()`.* Roots (no `parentId`, no `boxId`) stand at their `x`/`y`. The tree
    under each is drawn as before: children by `order`, a row centred under the
    parent, 28 between sibling subtrees (each as wide as its widest row), 64 between a
    node's bottom and its children's top, one edge parent → child. A box lays out its
    direct contents — people and boxes, by `order` — as a table of `cols =
    boxCols(n)` (n ≤ 1 → 1, n ≤ 3 → n, else min(4, ⌈√n⌉)) filled row by row: column
    width = widest item in it, row height = tallest item in it, an empty box counting
    as one 224×64 cell; the box is `14 + Σcolumns + 10·(cols−1) + 14` wide and `38 +
    Σrows + 10·(rows−1) + 14` tall; item (column c, row r) sits at `box.x + 14 +
    Σcolumns before c + 10·c`, `box.y + 38 + Σrows before r + 10·r`, at its own size
    (a card is 224×64; a nested box is sized from its own contents first, recursively).
    Draw boxes outer to inner, cards above all boxes. A box's header counts the people
    inside it at any depth.
  - *Gestures.* Into a box (a card *or* a box): `boxId` set, `parentId` cleared, and
    whatever reported to the dropped node now reports to the outermost box; refused
    if the target is inside what is being dropped. Drop targeting picks the card under
    the pointer first (a card in a box means its own, innermost box), then the
    deepest box under it, then the strip under a card (hang under it). Removing a
    box puts its direct contents in its place — into the box around it at its slot,
    under its parent at its slot, or standing free where they were drawn — and its
    reports go to its parent (or stand free). Several at once: the *roots* of a
    selection (not carried by another selected node, through `boxId` or `parentId`)
    move; onto a card they line up under it in reading order, on open board each
    keeps its offset; into a box the *joiners* go in (every selected node not inside
    a selected box). "Group into box" puts the joiners in a new box that takes the
    first one's place (same box, same parent, or their top-left on open board).
  - *The clipboard.* Text `{ "neo/team-chart": 1, projectId, nodes, people }`: the
    selected nodes plus everything inside each selected box, links kept only inside
    the set, every node carrying the `x`/`y` it was drawn at, and `people` mapping
    each `personId` to a name. A paste gives every node a new id, leaves out people
    not on the target project (naming them; what hung on them stands free where it
    was drawn), and moves the free nodes by a whole number of grid steps — centred on
    the pointer, else a step beside the originals, else in the middle of the view.
    Placing the same person twice is allowed.
- **Every mutation logs activity.** The server's `work/Activity.java` inserts a row and
  bumps `last_activity_at`, which is what makes the re-entry brief possible.
- **Row → model mapping is centralised** in the server's `work/Mapper.java` (snake_case →
  camelCase). Writes go through `Writes.upsert()` with an explicit column allowlist via
  `Fields`, so nothing a client sends can reach a column by accident.
- **Mutations invalidate the whole query cache** on purpose: the dataset is small and
  almost every write moves a derived number somewhere else. The one query left out is
  `account:status`. The common writes are drawn before that (see *Cache and queued
  writes*): add a channel to `SYNCABLE` and an entry to `renderer/lib/optimistic.ts`
  rather than writing an optimistic update at a call site.
- **One right-click system.** `lib/contextMenu.tsx` — call sites describe items;
  positioning, edge-flipping, dismissal and the confirmation step for destructive actions
  are handled centrally. Do not reimplement a confirm at a call site. An item carrying
  `items` opens a submenu beside it, **one level deep and no further** — worth it when
  several entries are obviously one question (*New*), and not worth it the moment you
  have to hunt through a tree. The projects page hangs one off its own background, which
  is why its wrapper has a floor under its height and the dialogs sit outside it.
- **The introduction is shown once, and only to a new account.** It comes after signing
  in (see *Neo Cloud* above). `settings.onboardedAt` is written when the first-run flow
  finishes, and `Gate` in `App.tsx` shows `routes/Welcome.tsx` only when that is empty
  *and* there has never been a workspace, live or archived. An empty account is not on its
  own proof of a new one — deleting your last workspace is the other way to get one — which
  is why the marker exists.
  The decision is latched in state on the first render that has the data, because the
  workspace the flow creates falsifies its own condition: without the latch the screen
  unmounts mid-save and the app appears behind it. Nothing is written until the last
  button, so abandoning the flow leaves nothing behind.
- **A picture in a note is a row and a file, and nothing points at the row.**
  `note_image` is scoped to the *project* — a note being written for the first time has
  no id yet — and holds the name of the file Neo Cloud stored the bytes under. The note's
  Markdown refers to it by `neo-media://image/<file>`, fetched by `recording/media.ts`
  through the account's token. Because the reference lives in prose, the server's
  `FileSweeper` is what deletes: a row no note or meeting in its project mentions, after
  a day's grace, and then the file nothing refers to. `![alt|300](…)` is the width,
  Obsidian's way, and the only size there is.
- **`[[Links]]` between notes resolve by title, inside one project, and are never
  stored.** Backlinks are computed in the renderer from the bodies `project:get` already
  returns (`lib/noteLinks.ts`); there is no link table to keep right. The editor is
  handed the titles it may complete to and a callback for ⌘-click, and knows nothing
  about notes otherwise.
- **Every side panel resizes through one hook.** `lib/resize.tsx` — `useResizablePanel`
  and `PanelResizeHandle` — and the bounds for each one live in `src/shared/panels.ts`,
  never in the component. The panel's own edge is what a drag measures from, not the
  window's: the meeting page's details column has the assistant beside it whenever the
  assistant is open. A width is written to settings on pointer-up, not per pixel, and
  the panel must be `relative` for the handle to sit on its edge.
- **Settings screens are panes, not scrolls.** App, workspace and project settings all
  render through `components/SettingsLayout.tsx`: a short list down the left, one pane at
  a time on the right. Add a pane rather than another section stacked below the last one,
  and if a screen needs more than about five, the screen is doing too much.
  **The app's settings and a workspace's are a layer over the whole window**
  (`components/SettingsOverlay.tsx`), Shopify's arrangement: they cover the sidebar and
  the header, carry a ✕ at the top right, close on Escape, and closing returns to the
  exact screen they were opened from. They stay routes (`/settings`, `/workspace`,
  `?pane=`), so every link and the menu work unchanged; what makes it a layer is that
  the shell draws its page against `usePageLocation()` — the last page — inside a route
  whose location is that page, so every `useMatch` beneath it (sidebar, header, screen)
  answers for the page and nothing behind the layer moves or remounts. Closing goes
  *back* through history to that page when it can, rather than pushing it again, so Back
  afterwards does not reopen settings. The layer's bar is the window's title bar: a drag
  region, indented past the traffic lights, and the sheet is opaque under Liquid Glass
  too (`.settings-sheet`) because the app must not read through a settings pane.
  A project's settings are not in the layer — inside a project the sidebar is the
  project, and its settings are one of its places.
- **The app updates itself, and a big release's changelog ships with it.** Only a
  release with a big new feature in it gets a `changelog/<version>.md`, written in the
  same commit as the version bump; a release of small features and fixes ships without
  one. Do not write one for every change. The release workflow takes the GitHub release
  notes from the file when there is one and a plain sentence when there is not, and the
  app's *What changed* screen stays shut for a version with no file. See *Updating
  itself* below for why there is no `electron-updater` here and what the ad-hoc signature
  costs on every update.
- **Icons are hand-rolled paths** in `components/Icon.tsx` on a 24px grid, single stroke
  weight. Nothing is fetched at runtime; add a path rather than a dependency.
- **Dates use `components/DateField.tsx`**, never `<input type="date">`.
- **The assistant asks before every write**, and that rule now lives in Neo Cloud's
  `work/assistant/run/`: every write tool has a `summary()` that validates and builds the
  sentence *before* the question is asked, the run blocks on the answer, and there is no
  allowlist of "safe" writes. Reads are workspace-fenced there too, and tools call the same
  code a click does. The server's `test/verify.sh` asserts all of it. What this app owes
  the rule is never to answer a question the person did not: `chat:respond` is only ever
  sent from the panel's buttons.
- **Markdown is rendered by `components/Markdown.tsx`** and edited by `MarkdownEditor`;
  both read the one parser in `lib/markdown.ts`. The editor leaves every character in
  place because you are editing it; the renderer takes the syntax off because you are
  not. Add syntax to the parser, not to either one of them.
- **Liquid Glass is a material, not a palette.** Selecting it leaves `data-theme`
  saying `pm` or `pmdark` — it follows the OS the way *System* does — and adds
  `data-glass` to the same element; every glass rule in `styles.css` keys off that and
  nothing else. One number drives all of it: the renderer writes `--glass-set`, the
  stylesheet reads it through a fallback into `--glass-strength` so
  `prefers-reduced-transparency` can still win over an inline style.
  The chrome (`.glass-chrome`), the sheet under the page (`.glass-page`) and floating
  things (`.glass-raised`) thin a lot; the *surface tokens* thin a little, redefined
  on `body` so `bg-base-100`/`200`/`300` carry alpha and ninety-odd call sites follow
  without being touched. The solids are captured on `html` first, as
  `--glass-solid-*`, and every glass surface mixes from those — mixing from a token
  that has already been thinned compounds to nothing. That is why the capture and the
  replacement are on different elements.
  **Three macOS facts hold the rest of it up, all found the hard way:**
  (1) The vibrancy material is fixed at `hud`, set in the `BrowserWindow`
  constructor, in *every* theme, and never changed again. `visualEffectState: 'active'`
  is what stops macOS flattening the glass to grey whenever the window is not key, and
  Electron reads that option **only at construction** — `setVibrancy()` afterwards
  builds a fresh effect view without it. A material that followed the slider cost the
  theme its whole appearance in every window but the front one. So the slider is paint
  only, and the paint has to carry the frosted end by itself.
  (2) **Never `transparent: true`.** Chromium cannot run a `backdrop-filter` in a
  transparent window, and fails silently: menus and dialogs keep their translucency
  and quietly lose their blur. A clear `backgroundColor` is all the vibrancy view
  needs. `html { background-color: var(--color-base-100) }` is what makes the other
  three themes opaque over it.
  (3) An element with a `backdrop-filter` is a **backdrop root**, so a filter inside it
  can only see what that root paints. The modal backdrop's own blur therefore blinded
  every dialog's; `[data-glass] [data-modal-backdrop]` clears it, in *both* spellings,
  because Tailwind emits the `-webkit-` one too and clearing one leaves the root
  standing. Moving the blur down to the backdrop instead does not work — a
  full-window `backdrop-filter` does nothing here, though the panel's own does — so
  what separates a dialog from the page is a darker field (42%, not the other themes'
  25%) plus the thickest paint of any glass surface. A palette you can read a button's
  orange through is the failure this is tuned against.
  `window:glass` still exists for Windows 11's acrylic and to report whether the
  desktop is actually showing through (`window`) or the app is drawing its own
  backdrop (`paint`); on macOS it now reports and nothing more.
- **Today's front block is furniture, and that is the whole licence for it.** The
  banner, the bio, the links and the weather are per workspace (`banner_path`, `bio`,
  `weather_*`, `workspace_link`) and **nothing derives from any of them** — not
  attention, not notifications, not search. That is precisely why the user is allowed to
  arrange it when they are allowed to arrange almost nothing else: a banner that is
  wrong costs a photograph, not an answer. The `today_show_*` columns are discrete
  booleans rather than a JSON blob so `pick()`'s allowlist still means something.
  There is deliberately **no switch for overdue or due today**: a Today page you can
  turn the work off is a wallpaper. Like every stored picture the banner is a
  `neo-media://file/…` address rather than inlined — every mutation invalidates
  `workspace:list`, and a photograph re-sent across the bridge on every keystroke that
  saves is a real cost.
- **How a date, a clock and a temperature read is an app setting, never a workspace
  one.** `clockFormat`, `dateFormat` and `temperatureUnits` in `settings`, all
  defaulting to `system`, resolved for both processes by `shared/formats.ts`. The
  renderer applies them through `applyDisplayPreferences()` — module state in
  `lib/format.ts`, set **during** the shell's render (`lib/display.ts`) rather than
  from an effect, because every screen that draws a date is a child of it and an
  effect would leave one stale frame. Anything that previews a format must use the
  pure `formatDateWith` / `formatTimeWith`: touching the module state to draw a
  preview leaves the whole app formatting dates the way the last hovered option did.
  Temperature is asked for in the unit it will be drawn in, so nothing converts a
  reading afterwards and lands a degree out.
- **The weather is the only outbound request in the app that is not Neo Cloud.**
  `lib/weather.ts` asks Open-Meteo — no account, no key — and sends a latitude and a
  longitude and nothing else. Every path in it returns `null` rather than throwing, so a
  refused connection costs the corner of one screen. Switched off means *no request*,
  not a request whose answer is dropped, and `verify.ts` asserts that — which is also
  what keeps the whole verify run offline. The location comes from the machine's own
  IANA timezone (`Europe/Oslo` is a city, and the geocoder knows what to do with one)
  unless a place is named, so it works on the first morning with nothing configured.
- Workspace colours are identifiers, not surfaces — a dot or a 2px rule, never a filled
  block. Theme tokens for `pm` / `pmdark` live in `styles.css`. This is why the Today
  banner is a photograph or an ordinary panel and never a wash of the workspace's hue.

### Updating itself

`src/main/lib/update.ts` is the pure half and `lib/updater.ts` the runner, split the way
the server's `Notify` and `lib/notifier.ts` are. `lib/changelog.ts` reads the bundled changelog and
`lib/permissions.ts` hands back what an update costs. The design rule is that **nothing
is applied while somebody is using the app**.

A release is found, fetched, unpacked, checked and parked as a complete working copy
beside the application; only then is anything swapped, and the swap happens on the way
out. A crash before it costs a folder the next launch sweeps (`pruneStaged()`); a crash
during it leaves the old version in place, because the
outgoing bundle is **moved aside rather than deleted** and moved back if the new one
cannot land.

**There is no Squirrel and no `electron-updater`, and there cannot be.** Both validate
the incoming bundle against the running one's designated requirement, and an ad-hoc
signature pins that to a per-build hash — they would refuse every release this repository
will ever publish. What stands in for that check is in `prepare()`: the bundle must carry
`com.svartdal.neo`, must be the version it claimed, and must satisfy `codesign --verify
--deep --strict`. Nothing this app downloads is quarantined, so Gatekeeper never sees it
and those three questions are the only ones anybody asks. `ditto`, never `unzip`: an
application bundle is symlinks and extended attributes, and only ditto puts both back.

**The swap is a detached shell script and cannot be anything else** — a process cannot
replace the bundle it is running out of. It is generated as text in the pure module so a
test can read it without a Mac, and it waits on the pid rather than assuming the app has
gone. `applyStagedUpdate()` runs last in `before-quit`, after the audio helper has been
told to let go.

`staged` is held in memory on purpose, and it is the only thing here that is: it means
"the person agreed to this in this session". A preference that survived a restart and
silently installed something would be an app updating itself at a moment nobody chose.

Which copy may do this at all is `updateCapability()` — a development run (checked
through `ELECTRON_RENDERER_URL`, never `app.isPackaged`, which lies), a non-AppImage
Linux build and an unwritable folder all report `unsupported` and offer the downloads
page. `resetsPermissions` is **read from the bundle's own signature** (`codesign -dv`,
which writes to stderr even on success) rather than assumed, so a real Developer ID
retires the whole permissions panel without a line being touched.

**The changelog is a folder in the repository, bundled and never fetched.** `changelog/`
holds one Markdown file per version with its illustrations in `media/`; it ships as
`extraResources` and is found by looking for the file. The screen that reads it appears
on the first launch after an update, which is exactly the launch most likely to have no
network. The release workflow generates the GitHub release notes from the same files, so
a release is described **once**: do not write notes into a tag by hand.

**Not every version has a file, and that is the rule rather than a gap in it.** A
changelog is for a big new feature — a screen that did not exist, a way of working that
changed. Small features and fixes ship without one: written up one by one they become
pages nobody reads, and a screen that opens after every update is a screen people learn
to close unread. A tag with no file releases normally — the workflow falls back to a plain
sentence — and `WhatsNew` draws nothing for that version (`changelog:get` answers `null`,
and with no permissions to ask back there is no dialog at all). `verify.ts` asserts that a
missing entry is an answer, not an error.

Illustrations are relative paths rewritten to `neo-media://changelog/…` by the parser,
because the renderer's CSP allows an image from `self` and a data URL and nothing else,
and because a screenshot re-fetched from the internet defeats the point of bundling it.
`Markdown.tsx` therefore draws an image **only** for that scheme and renders anything
else as its alt text; an image alone on a line becomes a figure, one inside a sentence
stays inline. Add syntax to the parser, not to either renderer — image support went into
`lib/markdown.ts` for that reason.

**An update costs three permissions, every time, and the app says so where it is felt.**
macOS remembers a privacy permission against the code signature, which is rebuilt each
release, so the microphone, the audio tap and notifications are all forgotten. The screen
that says what changed is the screen that asks for them back — one panel, a button each,
no "grant all" (three system sheets at once is a stack nobody reads the wording of). Two
of the three cannot be *read*: macOS has no API for either, so `permission:read` reports
`unknown` rather than guessing and pressing the button **is** the question, exactly as
`notification:test` already is. Do not add a state this cannot establish.

**`off` means no request**, not a request whose answer is dropped — the same rule the
weather is held to, asserted the same way by counting sockets in `verify.ts`. The *Check*
button is still allowed to look, because a button that lied would be worse.

`lastSeenVersion` gates the what's-new screen the way `onboardedAt` gates the
introduction, and for the same reason: empty is indistinguishable from a new install, so
it is written down and nothing is shown until the *next* update. It is written when the
screen is shown rather than when it is closed — the marker is "this version has been
announced", not "this was read to the end".

### Recording a meeting

`src/renderer/src/lib/recorder.tsx`, `src/main/ipc/recordings.ts`, and the server's
`work/recordings/`. The design rule is that **nothing important is ever only in one place
that can die**.

Only a renderer can open a microphone, so the renderer holds one — and nothing else.
Audio is handed over a second at a time; main sends each second to Neo Cloud, which
stores it as a row (`app.recording_chunk`) before the request answers, so the window of
loss is one second. A second that cannot be sent is held in main's queue, in order, and
retried until it goes — the renderer is told the audio is being held rather than lost.
When a segment closes the server joins its seconds into one file. `RecorderProvider` is
mounted above the router precisely so navigating does not stop a recording.

A recording is a **sequence of segments**, five minutes each (`SEGMENT_MS`), not one
file. That one decision buys three things: it bounds what a half-written file can
cost, it gives transcription something to resume at, and it keeps every upload under
the 25 MB the APIs take. A new `MediaRecorder` is started on the same stream *before*
the old one is stopped, so a rollover overlaps by milliseconds rather than dropping a
word. Sleep, an unplugged microphone and a device change all end up in the same place:
close the segment, open a new one.

**The pipeline runs in Neo Cloud**, so a laptop closed after the meeting still gets its
recap. It is a runner over rows, not a queue. Every step — transcribe one segment,
attribute one batch of lines, summarise one slice — writes its result down before the
next begins, and every recording carries its own state, error, attempt count and
`next_attempt_at`. A step is claimed with a lease (`lease_until`), and a lease that runs
out belonged to a worker that died: that is the whole of crash recovery, and it is also
what stops two server instances working the same step. A capture whose heartbeat goes
quiet is marked `interrupted` by the server. Progress reaches the window as a
`recording` event on the event stream.

`interrupted` is deliberately not `stopped`. Audio captured before a power cut may be
half of a meeting that is still going on, and only the person in the room knows; the
screen asks rather than guessing. Sleep, where the app is still alive, resumes by
itself — no question needed.

Errors are split into permanent and transient. A refusal that waiting will not fix fails
once and says so; a refused connection or a rate limit backs off and comes round again.
A segment that cannot be transcribed does not condemn the rest — the transcript finishes
without it and says how many parts are missing.

**A spent allowance is waiting, not failing.** A free account transcribes 60 minutes a
day. Past that the server leaves `transcriptState` at `pending`, sets
`waitingForAllowance`, and puts the sentence in `transcriptError`; the next day it carries
on by itself. The meeting page (`PipelineLine` in `RecorderRail.tsx`, the Recap block in
`RecordingPane.tsx`) and the meetings list show that sentence and an hourglass rather than
an alert and a *Try again* — there is nothing to retry.

**System audio comes from native code.** Electron 44's `loopback` display-media audio
is Windows-only — its own typings say so — and no Chromium API on macOS lets one app
hear another. `native/audiotap/main.swift` is a Swift command-line tool that opens a
**Core Audio process tap** (public, macOS 14.4+, driver-free), mixes to mono and
writes raw s16le PCM on stdout with JSON status lines on stderr.
`lib/recording/systemAudio.ts` spawns it and forwards the bytes to the renderer, where
`lib/systemAudioNode.ts` schedules them as short `AudioBufferSourceNode`s on the same
bus as the microphone.

**Not an `AudioWorkletNode`, and this is load-bearing:** a worklet is loaded as a
*script*, and `index.html` sets `script-src 'self'`, so one built from a blob is
blocked — silently, in dev and packaged alike, surfacing only as "could not be mixed
in". Allowing `blob:` would trade a real property of the whole renderer for one node.
Buffers need no script. Do not reintroduce a worklet here without changing the policy
on purpose. Built by `scripts/build-audiotap.mjs` (universal, best-effort, skipped
without a Swift toolchain) and shipped as `extraResources`, found by looking for the
file — never by `app.isPackaged`, which lies in development.

**An unsigned bundle silently breaks this.** macOS only reads a privacy usage string
whose Info.plist is covered by the signature, and a build with signing skipped keeps
Electron's own linker-signed one — `Identifier=Electron`, plist not bound — so
`NSAudioCaptureUsageDescription` is never read and the tap is refused with no prompt.
`scripts/sign-adhoc.mjs` runs as electron-builder's `afterPack` and re-signs ad-hoc
with `com.svartdal.neo` to bind it. Check with `codesign -dv` that the identifier is
the app's and `Info.plist entries=` appears. A real Developer ID signs afterwards and
replaces it.

A **child process, not a native module**, deliberately: a module is compiled against
one Electron's headers and a crash in it takes the app down. Stopping is done by
closing its stdin, never by killing it, because it has to hand the private aggregate
device back to Core Audio — verify asserts nothing is left behind.

**The microphone is opened before the tap, and the order is load-bearing.** A
Bluetooth headset is one device in two modes — playback at 48 kHz, and a 24 kHz
headset link that is the only mode with a microphone — and opening the microphone
is what makes it switch. It cannot switch while the tap's aggregate device holds its
output side at the playback rate: started tap-first, the AirPods' microphone track
ended the instant it opened, the `AudioContext` clock stood still, and the recorder
wrote nothing until another application played sound and shook the device loose. So
a meeting recorded fine and a note dictated alone was empty. Two consequences. The
helper labels its bytes with the *aggregate's* rate read after it has started, not
the tap's format, and emits a `format` line when that rate moves under it (the
switch finishes a beat after the aggregate is made); `onSystemAudioFormat` carries
it to the feed, which stamps each buffer with the rate it arrived at and lets the
graph resample. And the watchdog checks that `currentTime` has moved since its last
look, because a stalled graph is the one failure the track states cannot show: the
mixed track is generated and always "live", and a `MediaRecorder` over it sits at
`recording` producing nothing.

Two clocks meet in the schedule (the tap runs on the output device, the mic on its
own), so it is allowed to slip: behind the clock it restarts just ahead of now, and
more than `SYSTEM_AUDIO_BUFFER_MS` ahead it drops a chunk. Nothing is scheduled while
nothing is playing, which is most of a meeting — a tap produces no audio then. The
context runs at the *tap's* rate so its samples are not resampled; the mic is, and of
the two it is the one that can afford it.

The virtual-device path (BlackHole, an aggregate) is still there as the fallback for
macOS before 14.4 or a refused permission. Echo cancellation stays on for the
microphone (it kills the speaker bleed) and off for a loopback device (it mangles
already-clean audio). The mixed stream's track is generated and therefore always
"live", so the watchdog checks `mic`/`system` and never `stream`. Failing is allowed
and always visible: `capturing` says what was actually got, never what was asked for.

**Which service transcribes and recaps is Neo Cloud's to decide**, on its own operator
key: there is no engine, model, base URL or key on a workspace any more. What workspace
settings keep is the transcription language and the recap prompt. One more thing is an
honest limit rather than a bug: **speakers are attributed, not diarised** — a language model reads the transcript
and works out the turns, because there is no voice-print model on a stock Mac. The UI
says so. Do not present it as a measurement.

**Delete means the audio.** `recording:deleteAudio` frees the megabytes and keeps the
transcript, the speakers and the recap; it is the only delete on the meeting page, and
it is refused while there are no cues yet, because then the audio is the only copy.
`recording:delete` — the whole thing — is demoted to the bottom of the Recording pane.
Neither deletes a file directly: the segment stops referring to it, and the server's
`FileSweeper` removes what nothing refers to.

**The recap folds itself into the meeting.** `recording:applyRecap` appends it to the
write-up, names an untitled meeting from `suggested_title`, and turns every commitment
into a `meeting_todo` — all through the server's `MeetingWrites`, the same code the meeting endpoints run, so what
arrives is indistinguishable from what you would have typed. It runs once, guarded by
`recap_written_at` for the write-up and `recap_todos_at` for the to-do items —
**two markers, because the halves can fail apart**: a retry after a failed to-do
write must not append the recap to the write-up a second time. There is
deliberately no button: a recap behind a button on a second screen is a recap nobody
reads, and the meetings list already shows the top of the write-up.

It is a **step in the pipeline**, not something storing the recap does on its way past —
the runner looks for `summary_state = 'done' AND recap_written_at IS NULL`. That is what
makes it recoverable: a recap written by an older build, or one whose meeting was
unreachable, is just a row the runner finds waiting. `recapWrittenAt` is on
`RecordingView` so the screen can say "in the write-up" only once it is true.

`meeting:suggestName` is the one thing here behind a button — the stars in the Name
field. It only returns a name; nothing is written, and the page's own autosave keeps it.

Because the body can therefore change under an open editor, `MeetingWriter` *merges*
rather than reloading: what arrives is always an append, so it takes the tail and adds
it to the draft. Reloading would throw away the sentence being typed; ignoring it
would write a stale copy back over the recap on the next autosave.

The recap prompt in workspace settings is the *instructions* only; the server appends the
output schema, which is not editable, because the screen reads decisions and commitments
as data. Playback is served over the `neo-media://segment/<id>` scheme (`media.ts`), which
passes `Range` through to Neo Cloud and the `206` back — the renderer never learns a URL.

### Where the data is not

There is no database in this app. The schema, the migrations, calendar dates as `text`
rather than `date`, and every rule about writing a row now live in the server — see
`../server`, whose migration `V4__neo_cloud.sql` carries this app's last local
schema across with an `account_id` on every table. What used to be here (PGlite in
`~/.neo`, the `.lock` file, catalog repair, the moves from `~/Documents`) is gone, and
`scripts/import-local-data.mjs` is how an old install's folder gets into an account.

The single-instance lock stays: there is no folder to protect, but two copies would each
run the notification loop and each hold the meeting's microphone.

**`native/audiotap/`** is the fourth process, and the only one that is not JavaScript: a Swift
command-line tool that reads a Core Audio process tap so a recorded meeting captures
the other side of the call. See *Recording a meeting* below for why it is a process
rather than a module. It is optional at every level — no Swift toolchain, no helper,
and every path that wants it already copes with it being absent.

## macOS naming

In development the app runs inside `node_modules`' Electron bundle, and macOS reads its
name from four independent places: `CFBundleName` (menu bar), the executable name (dock
label), `CFBundleIdentifier` (LaunchServices' cached name) and the **bundle's filename**
(dock tooltip). `scripts/dev-branding.mjs` sets all four — including renaming
`Electron.app` → `Neo.app` and rewriting `node_modules/electron/path.txt` — and drops the
stale LaunchServices entry. It runs on `npm run dev` and after every install. If the dock
starts saying "Electron" again, that script is where to look.

**Rewriting that plist invalidates the signature, and the dev bundle has to be re-signed
after it.** Electron ships with its own linker-signed one — `Identifier=Electron`,
`Info.plist=not bound` — and once the keys and the executable name have been changed it
describes a bundle that no longer exists; `codesign --verify` fails outright. macOS then
refuses everything it gates on a signed bundle, **silently**: a notification comes back
`UNErrorDomain error 1` (*not allowed*) with no prompt ever shown, which looks exactly
like the feature not having been written, and the `NS*UsageDescription` strings the same
script just set are never read either. So `dev-branding.mjs` ends by ad-hoc signing with
`com.svartdal.neo.dev`, which is `scripts/sign-adhoc.mjs` doing the same job for a
packaged build. It skips when the signature is already ours — and reads `codesign -dv`
off **stderr**, which is where it writes even on success. The signature is content
derived, so re-signing unchanged bytes keeps whatever macOS remembered; a new Electron
changes the bytes and the permissions are asked for again.

One consequence of renaming the executable: Electron derives `app.isPackaged` from that
name, so a development run reports itself as **packaged**. Anything choosing a behaviour
by `isPackaged` will pick the production one under `npm run dev` — which is how the
window came to load the stale build in `out/renderer` instead of the dev server, with no
hot reload and no error. `createWindow()` now switches on `ELECTRON_RENDERER_URL`, which
exists exactly when a dev server does. Do not reintroduce `isPackaged` as a dev check.

`scripts/make-icon.mjs` generates `icon.png`, the iconset and the `.icns` from signed
distance fields, drawing each size natively rather than downscaling one master. There is no
SVG rasteriser on a stock macOS, which is why it is written that way.
