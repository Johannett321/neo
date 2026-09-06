# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Neo is an Electron desktop app: a personal command centre for running several working
lives at once (a day job, your own company, a client). `README.md` explains what each
feature is for and why it exists — read it before designing anything user-facing, because
most of the product decisions here were arrived at deliberately and are worth honouring.

## Commands

```bash
npm run dev             # dev-branding.mjs, then electron-vite dev with hot reload
npm run build           # typecheck (node + web) + electron-vite build
npm run typecheck       # both projects; typecheck:node / typecheck:web individually
npm run verify          # whole backend, headless, in plain Node
npm run verify:upgrade  # open a database written by an older version of the app
npm run verify:sync     # two data folders, one account, a real sync server
npm run package         # unpacked app into dist/
npm run dist            # packaged, signed-if-possible application
npm run build:mcp       # the Claude Desktop connector into out/mcp/
npm run mcp:pack        # that, packed as dist/neo.mcpb
```

There is no linter and no test framework. `test/verify.ts` and `test/upgrade.ts` are
single scripts of `ok(label, condition)` assertions run end to end — there is no way to
run one assertion in isolation, so run the whole script (a few seconds). Both are bundled
by esbuild with `electron` aliased to `test/electron-stub.mjs`, which fakes `app`,
`ipcMain`, `dialog` and `shell` so the real main process runs with no window and no
display. `PM_TEST_DIR` pins the data directory; otherwise each run gets a fresh temp dir.

Add an assertion to `test/verify.ts` for any backend behaviour you change. Add to
`test/upgrade.ts` when you change the schema.

## Architecture

Three processes, one typed contract.

**`src/shared/api.ts`** is the spine. `ApiMap` maps every IPC channel to `{ in, out }`.
Main registers handlers through `handle<C>()` (`src/main/ipc/util.ts`), preload exposes a
single `invoke`, and the renderer calls `useApi` / `useApiMutation` / `call`
(`src/renderer/src/lib/api.ts`). Adding a channel means adding it to `ApiMap` first;
everything else then fails to compile until it is wired up. `Args<C>` in the renderer is a
conditional tuple that makes the input *required* for channels that take one — that is
deliberate, and it is what stops a workspace-scoped channel being called with no
workspace and quietly returning everything.

**Main** (`src/main/`) owns the database, the filesystem and the shell; none of them ever
reach the renderer. `ipc/` holds handlers grouped by domain, `lib/` the logic that is not
a handler (attention reasons, board columns, profile, markdown mirror, activity log, sample data,
icon storage, attachments, `ai/` the assistant), `db/` the client, schema and row mapping.

`handle()` also records every handler in a registry, and `invokeChannel()` calls one from
inside main. That exists for the assistant: its tools are the app's own channels rather
than a second set of writes beside them, so a task it creates logs activity, bumps the
project clock and lands in the Markdown mirror because it *is* that code path. Do not
give a tool its own SQL — add the channel it needs and call it.

`invokeChannel()` is also where the screen is told. A write made by a click resolves a
mutation, and `useApiMutation` invalidates the cache on the way back; a write made by a
tool has nobody in the renderer waiting on it, so without this the assistant's new task
sat unseen until you navigated away and back. It asks the *database* whether anything
changed — `writeCount()` in `db/client.ts`, which PGlite only moves for a statement that
actually touched a row — rather than consulting a list of "the channels that write",
because such a list would drift and because a read the assistant makes must not refetch
the whole app. `lib/changes.ts` coalesces the announcements and sends one `data` message,
and `useLiveData()` at the top of `App.tsx` empties the cache, exactly as a mutation does.

**`src/mcp/`** is a fourth process, and one of two that are not Electron's: the MCP
connector Claude Desktop runs. It is a proxy and nothing else. It never opens the
database — PGlite has no lock, and Claude Desktop keeps its servers alive for hours, so a
second reader there would take the `.lock` and stop Neo from starting. Instead
`src/main/lib/mcp/bridge.ts` listens on a Unix socket in the app's support folder (a
named pipe on Windows; never a TCP port) and answers with the same `TOOLS`, so a task
created from Claude Desktop is the same task, logged and mirrored, for the same reason an
assistant-made one is. `src/shared/mcp.ts` is that wire's contract, the way `api.ts` is
IPC's. The tool list is baked into the connector at build time by `scripts/build-mcp.mjs`,
generated from `TOOLS` itself, so the tools are advertised before Neo is open without
becoming a second description of them that can drift. Add a tool to `TOOLS` and it appears
on both sides; do not add one to the connector.

`src/main/ipc/mcp.ts` is the setup side of it: it writes one entry into Claude Desktop's
own `claude_desktop_config.json` and never touches anything else in that file, refusing
outright rather than overwriting one it cannot parse. The entry runs the connector on
Neo's own Electron with `ELECTRON_RUN_AS_NODE`, because `"command": "node"` depends on a
PATH that Claude Desktop's launch environment frequently does not have. It finds the
connector by looking for the file, not by asking `app.isPackaged` — which lies in
development, as the section below explains.

Claude Desktop cannot show Neo's confirmation — it has no elicitation, so a connector has
no way to put a question on screen — so what gates a write there is its own approval
prompt, informed by `readOnlyHint` and `destructiveHint`. `summary()` is still built
before the write, because building it is what validates, and it goes back with the result.

**Renderer** (`src/renderer/src/`) is React 19 + TanStack Query + React Router in hash
mode. `routes/` are screens, `components/` the shared pieces, `lib/` the app-wide systems
(query wrappers, workspace context, toasts, context menus, formatting).

Aliases: `@shared/*` everywhere, `@/*` → `src/renderer/src/*` in the renderer only.

### The operation log

`src/shared/ops.ts` is this boundary's contract, the way `api.ts` is IPC's and
`mcp.ts` is the socket's. **Every write in the application is an operation**, and
`db/apply.ts` is the only thing that touches a domain table. A click, an assistant
tool call, a task created from Claude Desktop and a batch arriving from another
device all converge there — that equivalence is the whole correctness argument, and
it is the same move `invokeChannel()` already makes so the assistant's tools are the
app's own channels rather than a second set of writes beside them.

Handlers did not change. `upsert()` still takes what it always took; it now goes via
`putLocal()`, which puts the row down *and* records what it did. `remove()` replaces
every bare `DELETE FROM`, `updateWhere()` / `removeWhere()` replace the bulk
statements, and `reorder()` writes a row at a time — a position only means anything
among its neighbours, so each new number needs its own stamp.

`handle()` wraps every channel in `withBatch()`, so one call is one batch however
many rows it moves. That is what turns *every mutation logs activity* from a
convention each handler has to remember into something structural: the activity row
rides inside the batch and cannot arrive without the change it describes.

**Ordering is a hybrid logical clock (`db/hlc.ts`), never wall time.** Two Macs
disagree about the time and one of them has been asleep. Last-write-wins is resolved
**per field**, and the stamps live in `sync_row` — one table beside the schema rather
than a jsonb column on all twenty-five, so nothing above changes shape and a row's
stamps disappear with it. That table holds the tombstones too.

**A cascade is deterministic, so only the parent delete becomes an op** — every device
performs the same cascade itself. The tombstones still cover everything it takes, read
out of `pg_constraint` rather than from a hand-written copy of the foreign keys that
would drift. Without them a task created on the phone would resurrect a project a Mac
deleted while the phone was offline.

**An insert records the row as it was written, an update only what it changed.** A
column with a volatile default (`started_at`, `now()` inside a CASE) is resolved by
whichever database runs the statement, so an op that left it out would give the row
the day of the *replay*. Taking those off the RETURNING row makes this correct by
construction rather than by remembering to list them.

`applyRun()` retries ops whose parent has not arrived yet, in passes, until nothing
more lands. Streams deliver out of order and an adopted row carries the oldest stamp
there is even when what it references was written later; `PM_TRACE_DROPS=1` names
whatever is left.

**What does not sync is part of the design.** `TABLES` in `ops.ts` carries it:
`recording_segment`, `summary_part` and `setting` produce no ops at all, and the
recording pipeline's own columns — states, attempts, errors, `next_attempt_at` —
are `deviceOnly`, because syncing them means two Macs transcribing the same segment
and both paying for it. Results are content and do sync. `transcript_cue.segment_id`
is `deviceOnly` for a sharper reason: it points at a device table, so on any other
machine that row does not exist and never will.

**`adoptExistingRows()` is the upgrade.** An install that predates the log has years
of work in it and not one operation describing any of it; without this, replay would
produce an empty database and the first sync would offer another device nothing. It
runs once at startup, stamps everything with a genesis stamp older than any real
edit, and finds nothing on every launch after. It is also how `sample.ts` works —
that is a fixture rather than something somebody did, so it is written with plain SQL
and taken into the log afterwards.

**The gate is one assertion**, in both `verify.ts` and `upgrade.ts`: *replaying the
log into an empty database reproduces the state exactly.* If that holds, the log is a
complete account of the work and every device, restore and new phone reading it gets
the same answer. It is what found the join table with no id, the notification sweep
that deleted without a tombstone, and four columns whose defaults were evaluated in
the wrong database. Do not weaken it; when it fails, something is genuinely lost.

Writing before `initOplog()` throws. `index.ts` brings the log up immediately after
`initDb()` and before any housekeeping, and anything else that opens the database has
to do the same — a batch from a device with no identity looks fine and orders wrongly
the moment a second machine appears.

### Syncing

`src/main/lib/sync/` and the Sync pane in app settings. The log is the mechanism;
this is only a transport over it, which is why **Local and synced are the same code
path with this attached or not attached**. There is deliberately no second way to
write anything.

**The device is the source of truth and the server is a relay.** A write made offline
is committed here the moment it happens and is never provisional. `engine.ts` pushes
before it pulls — what this machine has already written is the thing most at risk —
and the cursors only advance behind work that actually landed, so a pass that fails
half way has still moved everything it moved.

**A passkey authenticates; a passphrase decrypts.** This is a change from the design
document and it is not a preference. An Electron renderer is loaded from `file://`,
so it cannot run a WebAuthn ceremony against the sync server's domain — the origin
will not match the relying party id — and the only way to get one is a window loading
a page *the server serves*. A server that serves the JavaScript handling a PRF secret
can take the master key whenever it likes, and the end-to-end claim is then
decoration. So `lib/sync/signin.ts` opens the server's page in a window Neo owns and
takes exactly one thing back: a device token, which is a thing the server issued
itself. The passphrase is typed in Neo's own window, stretched with scrypt in the
main process, and never leaves it.

`crypto.ts` is the whole of it. AES-256-GCM rather than XChaCha20-Poly1305 because
the latter is not in Node and reaching for a dependency to hold the one primitive
everything rests on is a poor trade; scrypt rather than Argon2id because Argon2 is a
native module, and a native module here is a compile against one Electron's headers
plus a crash that takes the main process with it — the same reasoning that keeps the
audio tap a child process.

**A workspace key is derived from the master key, not stored.** HKDF with the
workspace id, so every device holding the master arrives at the same key with nothing
to fetch and no keyring to be out of date on one machine. **This forecloses sharing a
single workspace without re-keying it**: handing somebody one workspace's key means
handing them the account. Shared workspaces will need explicit random keys wrapped
per recipient, and everything that exists by then has to be re-encrypted under one.
That is a real migration and it is the price of not building key distribution before
there is anybody to distribute to.

The master key is cached through `safeStorage`, so the passphrase is asked for once
per install rather than once per launch — a passphrase typed every morning is a
passphrase chosen for speed. A copied `~/.neo` on somebody else's machine opens
nothing, because the cache is behind their login keychain and not in the folder.

**A batch that cannot be opened does not stop the stream.** It means a different
passphrase wrote it, or it is damaged; either way every batch behind it is still
readable and refusing to move past it would strand the whole workspace on one bad
row. It is logged and the cursor advances.

`sync_state` holds only the *pull* cursor, one row per workspace, because a stream
that cannot be reached must not hold up the others. What has been pushed is a single
number in `setting`: batches leave in the order they were written, so one that fails
stops the queue behind it on purpose.

The engine starts **after** `adoptExistingRows()`, never before. A device that pushed
its log before taking its own existing rows into it would hand the other Mac an
account of a working life that begins today.

`npm run verify:sync` is the assertion this exists for: two data folders, one
account, a real server, and the second one has never seen any of it. It cannot run in
one process — a device is a data folder and `initDb()` opens one — so it runs twice
with `PM_TEST_DIR` pointing somewhere different each time. It checks that the board
columns arrive too, because those are made by the project handler rather than sent as
content: their presence is what proves the ops were *applied* and not merely copied.

### Conventions that matter

- **Workspace isolation is a hard boundary.** Every scoped channel takes an explicit
  `workspaceId`; there is no implicit "all". The active workspace is ambient state in
  `lib/workspace.tsx`, persisted in settings. No screen may mix two workspaces.
- **Attention is derived, never stored.** `src/main/lib/attention.ts` computes it from
  overdue work, deadline proximity and staleness, and returns the single most pressing
  fact in plain words — never a level, a badge or a colour. Thresholds live in one place.
  Do not add a status field the user has to maintain by hand — that is the central product
  constraint. (The graded health level this replaced was removed deliberately: the colour
  had to be decoded and clashed with the workspace palette. Colour on a project now means
  identity only.)
- **A notification is the attention line, delivered.** `src/main/lib/notify.ts` is the
  pure half — rows and preferences in, sentences out, the way `attention.ts` works —
  and `lib/notifier.ts` is the runner that puts them on the desktop. Every one of the
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
  settings are split along. Being said once is a row and a unique index
  (`notification (workspace_id, kind, on_date)`), claimed **before** the notification is
  shown — never a timer and never a comparison of timestamps, so four restarts before
  lunch interrupt you once. `notification:pending` is a channel rather than something
  the runner works out privately so the settings pane can show the real sentence; the
  runner reads workspace *ids* straight from SQL because `workspace:list` reads an icon
  off disk per workspace and this ticks every minute, but every question about what is
  *inside* a workspace still goes through the scoped channel, one workspace at a time.
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
  depth guard. Where a project is filed is part of the path it is mirrored to on disk, so
  anything that moves one calls `mirrorProject()`.
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
  filed is invisible. One table and one pair of handlers (`contentFolder:save` /
  `contentFolder:delete`, in `ipc/content.ts`, with the fencing in `lib/folders.ts`
  because `meeting:save` needs it too) rather than two of each that drift.
  There is deliberately **no `contentFolder:list`**: the trees come back on
  `ProjectDetail`, which is the one call every screen that draws them has already made.
  The renderer's half is `components/ContentFolders.tsx` — `useFiling()` holds where you
  are and what is in the air, and both lists compose the same pieces, so a note row and a
  meeting row differ only in what they draw. `lib/folders.ts` in the renderer is written
  against the least a folder can be, so the walking is shared with the projects page.
  A folder's name is part of the mirror path (`notes/Research/Interviews/…`), so anything
  that renames or moves one calls `mirrorProject()`.
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
  `sort_order`: nothing derives from it, it logs no activity, and it never reaches the
  Markdown mirror. With no band at this level the page draws precisely the grid it drew
  before the feature existed — no rule, no heading, no drop strip.
- **Arranging the cards is filing too.** `project.sort_order` is what a drag between two
  project cards writes, through `project:reorder` — the whole visible set of one folder,
  because a position only means anything among its neighbours. **Zero means "never placed
  by hand"**, which is why `reorder()` numbers from one and why there is no backfill: an
  untouched grid sorts on the clauses behind it and draws exactly as it always did.
  `PROJECT_ORDER` in `db/queries.ts` therefore puts `sort_order` *before* `is_pinned` —
  the other way round and a pinned card would snap back the moment you dropped it
  somewhere else. Filing a project into a different folder resets it to zero, since its
  old number described old neighbours. It logs no activity and rewrites no mirror: where
  a card sits is not a fact about the project.
- **Every mutation logs activity.** `logActivity()` inserts a row and bumps
  `last_activity_at`, which is what makes the re-entry brief possible. Handlers that
  change project content also call `mirrorProject()` to rewrite the Markdown mirror.
- **Row → domain mapping is centralised** in `src/main/db/map.ts` (snake_case → camelCase).
  Writes go through `upsert()` with an explicit column allowlist via `pick()`, so nothing
  a renderer sends can reach a column by accident.
- **Mutations invalidate the whole query cache** on purpose: the dataset is small, local,
  and almost every write moves a derived number somewhere else.
- **One right-click system.** `lib/contextMenu.tsx` — call sites describe items;
  positioning, edge-flipping, dismissal and the confirmation step for destructive actions
  are handled centrally. Do not reimplement a confirm at a call site. An item carrying
  `items` opens a submenu beside it, **one level deep and no further** — worth it when
  several entries are obviously one question (*New*), and not worth it the moment you
  have to hunt through a tree. The projects page hangs one off its own background, which
  is why its wrapper has a floor under its height and the dialogs sit outside it.
- **The introduction is shown once, and only to a new install.** `settings.onboardedAt`
  is written when the first-run flow finishes, and `Gate` in `App.tsx` shows
  `routes/Welcome.tsx` only when that is empty *and* there has never been a workspace,
  live or archived. An empty database is not on its own proof of a new install — deleting
  your last workspace is the other way to get one — which is why the marker exists.
  The decision is latched in state on the first render that has the data, because the
  workspace the flow creates falsifies its own condition: without the latch the screen
  unmounts mid-save and the app appears behind it. Nothing is written until the last
  button, so abandoning the flow leaves nothing behind.
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
- **The app updates itself, and the changelog ships with it.** `changelog/<version>.md`
  is written in the same commit as the version bump; the release workflow refuses a tag
  without one and generates the GitHub release notes from it, so a release is described
  once. See *Updating itself* below for why there is no `electron-updater` here and what
  the ad-hoc signature costs on every update.
- **Icons are hand-rolled paths** in `components/Icon.tsx` on a 24px grid, single stroke
  weight. Nothing is fetched at runtime; add a path rather than a dependency.
- **Dates use `components/DateField.tsx`**, never `<input type="date">`.
- **The assistant asks before every write.** `src/main/lib/ai/tools.ts` marks a tool
  `writes: true`, and every one of those must have a `summary()` returning the sentence
  the confirmation shows — ids resolved to names, dates validated, written for someone
  who has not read the arguments. The run loop blocks on it; nothing is written until the
  renderer answers. There is deliberately no allowlist of "safe" writes, and `summary()`
  must fail on bad input *before* the question is asked rather than after it is answered.
  `verify.ts` asserts every write tool has one.
- **Reads are workspace-fenced by construction.** Every tool either filters on
  `workspaceId` or resolves an id through a query joined back to it. A tool that takes a
  bare id must confirm it belongs to this workspace first — see `resolveTask()`.
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
  attention, not the mirror, not search. That is precisely why the user is allowed to
  arrange it when they are allowed to arrange almost nothing else: a banner that is
  wrong costs a photograph, not an answer. The `today_show_*` columns are discrete
  booleans rather than a JSON blob so `pick()`'s allowlist still means something.
  There is deliberately **no switch for overdue or due today**: a Today page you can
  turn the work off is a wallpaper. The banner is served over `neo-media://banner/…`
  rather than inlined as a data URL like an icon — every mutation invalidates
  `workspace:list`, and a photograph re-sent across the bridge on every keystroke that
  saves is a real cost. It is validated against the database, not just against a
  filename pattern, for the same reason a segment is.
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
- **The weather is the only outbound request in the app that is not a key you gave it.**
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
`notify.ts` and `notifier.ts` are. `lib/changelog.ts` reads the bundled changelog and
`lib/permissions.ts` hands back what an update costs. The design rule is that **nothing
is applied while somebody is using the app**.

A release is found, fetched, unpacked, checked and parked as a complete working copy
beside the application; only then is anything swapped, and the swap happens on the way
out. A crash before it costs a folder the next launch sweeps (`pruneStaged()`, beside
`pruneRecordings()`); a crash during it leaves the old version in place, because the
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
gone. `applyStagedUpdate()` runs from `before-quit`, *after* `closeDb()` resolves.

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
a release is described **once**: do not write notes into a tag by hand. A tag with no
changelog file fails the workflow, and `verify.ts` asserts the same thing a step earlier.

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

`src/main/lib/recording/` and `src/renderer/src/lib/recorder.tsx`. The design rule is
that **nothing important is ever only in memory**.

Only a renderer can open a microphone, so the renderer holds one — and nothing else.
Audio is handed over a second at a time and `appendFile`d before the IPC call
resolves, so the window of loss is one second and a process that dies mid-write
leaves a shorter file, never a corrupt one. `RecorderProvider` is mounted above the
router precisely so navigating does not stop a recording.

A recording is a **sequence of segments**, five minutes each (`SEGMENT_MS`), not one
file. That one decision buys three things: it bounds what a half-written file can
cost, it gives transcription something to resume at, and it keeps every upload under
the 25 MB the APIs take. A new `MediaRecorder` is started on the same stream *before*
the old one is stopped, so a rollover overlaps by milliseconds rather than dropping a
word. Sleep, an unplugged microphone and a device change all end up in the same place:
close the segment, open a new one.

The pipeline (`pipeline.ts`) is a runner over rows, not a queue. Every step —
transcribe one segment, attribute one batch of lines, summarise one slice — writes its
result down before the next begins, and every recording carries its own state, error,
attempt count and `next_attempt_at`. So `recoverRecordings()` at startup is the whole
of crash recovery: it turns every `running` back into `pending` and every live capture
into `interrupted`. There is nothing to reconstruct because nothing was only in
memory. `reapDeadCaptures()` does the same for a renderer that died without the app.

`interrupted` is deliberately not `stopped`. Audio captured before a power cut may be
half of a meeting that is still going on, and only the person in the room knows; the
screen asks rather than guessing. Sleep, where the app is still alive, resumes by
itself — no question needed.

Errors are split by `isPermanent()`. A wrong key or a missing model fails once and
says what to fix; a refused connection to a local server backs off and comes round
again. A segment that cannot be transcribed does not condemn the rest — the transcript
finishes without it and says how many parts are missing.

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

Two more things are honest limits rather than bugs. **Ollama cannot transcribe**, so local
transcription means an OpenAI-compatible speech server (`transcribe_base_url`); both
engines go through the same `openai` client, which is why there is one code path.
And **speakers are attributed, not diarised** — a language model reads the transcript
and works out the turns, because there is no voice-print model on a stock Mac. The UI
says so. Do not present it as a measurement.

**Delete means the audio.** `recording:deleteAudio` frees the megabytes and keeps the
transcript, the speakers and the recap; it is the only delete on the meeting page, and
it is refused while there are no cues yet, because then the audio is the only copy.
`recording:delete` — the whole thing — is demoted to the bottom of the Recording pane.
A cascade frees no disk, so `pruneRecordings()` sweeps folders against the rows after
anything that can orphan one, and again at launch.

**The recap folds itself into the meeting.** `recording:applyRecap` appends it to the
write-up, names an untitled meeting from `suggested_title`, and turns every commitment
into a `meeting_todo` — all through `meeting:save` and `meetingTodo:save`, so what
arrives is indistinguishable from what you would have typed. It runs once, guarded by
`recap_written_at` for the write-up and `recap_todos_at` for the to-do items —
**two markers, because the halves can fail apart**: a retry after a failed to-do
write must not append the recap to the write-up a second time. There is
deliberately no button: a recap behind a button on a second screen is a recap nobody
reads, and the meetings list already shows the top of the write-up.

It is a **step in the pipeline**, not something `storeRecap()` does on its way past —
`nextRecording()` matches `summary_state = 'done' AND recap_written_at IS NULL`. That is
what makes it recoverable: a recap written by an older build, or one whose meeting was
unreachable, is just a row the runner finds waiting. `recapWrittenAt` is on
`RecordingView` so the screen can say "in the write-up" only once it is true.

`meeting:suggestName` is the one thing here behind a button — the stars in the Name
field. It only returns a name; nothing is written, and the page's own autosave keeps it.

Because the body can therefore change under an open editor, `MeetingWriter` *merges*
rather than reloading: what arrives is always an append, so it takes the tail and adds
it to the draft. Reloading would throw away the sentence being typed; ignoring it
would write a stale copy back over the recap on the next autosave.

The recap prompt in workspace settings is the *instructions* only; `summarise.ts`
appends the output schema, which is not editable, because the screen reads decisions
and commitments as data. Playback is served over the `neo-media://` scheme
(`media.ts`) with real range support — the renderer asks for a segment by id and main
looks the path up in the database, so the renderer never learns a path.

### The database

PGlite (real PostgreSQL compiled to WebAssembly, in-process) writing to `~/.neo`.
No server, no Docker, nothing to start.

**A dotfolder in the home directory, not Documents**, and `dataRoot()` in `db/client.ts`
carries the reasoning: the database is the application's working state rather than one of
your files, and Documents on a Mac may be an iCloud-synced folder, which is a poor place
for something written to constantly. It is still a plain folder you can copy — the
Markdown mirror is ordinary files and the app opens the folder directly from two places,
so nothing depends on the Finder showing it.

Earlier homes are **moved, never copied and never merged**: `~/Documents/Neo`, and before
the rename `~/Documents/ProjectManager`. An existing `~/.neo` always wins, and a move that
fails leaves the old folder in place and carries on using it — failing to tidy up is not a
reason to fail to open somebody's work. `verify:upgrade` writes its old-schema database in
the *legacy* location precisely so every run exercises the move. Note the consequence:
running an older build after the move gives it a fresh empty folder in Documents, because
nothing tells it where the data went. Do not add a third location.

`src/main/db/ddl.ts` is the single source of truth, applied idempotently on every launch:
`DDL` creates tables and indexes in one batch, then `MIGRATIONS` runs **one statement at a
time**, in four labelled groups — columns, constraint changes, backfills, indexes. Keep
that order. PostgreSQL parses *every* statement in a multi-statement batch before executing
any of them, so anything referencing a column that an `ALTER` is about to add must live in
`MIGRATIONS` below that `ALTER`, in a later group. This bug has shipped twice; it is what
`npm run verify:upgrade` exists to catch.

Calendar dates are `text` in `YYYY-MM-DD`, not `date` — a `date` round-tripped through the
driver comes back as UTC midnight and renders as "due yesterday". Timestamps stay
`timestamptz`.

**Two copies of the app must never open the same folder.** PGlite has no lock of its own.
Three guards, all in place and all load-bearing: Electron's single-instance lock (the
non-primary path calls `app.exit(0)` *without opening the database*), a `.lock` file in the
data folder holding the owning pid (because dev and packaged builds have different bundle
identifiers, so Electron's lock does not span them), and `before-quit` deferring exit until
`closeDb()` resolves. If an index is damaged anyway, Postgres reports `XX002` on startup and
`applySchema()` reindexes and carries on rather than refusing to open — row data is never
what is damaged in that failure.

Postgres does not always notice. A foreign key can lose its `pg_constraint` row while
the triggers enforcing it survive; the table then refuses every insert with `cache lookup
failed for constraint N` from `ri_LoadConstraintInfo`, and keeps refusing.
`orphanedForeignKeys()` looks for exactly that on every launch. It has to be a sequential
scan over `pg_constraint`: `pg_get_constraintdef()` returns null for a constraint it
cannot find instead of raising, so it sails straight past the damage.

The repair turns on one distinction. A stranded trigger whose `tgconstrrelid` names a
relation `pg_class` no longer has is **debris** — the other side of the relationship is
gone, so it cannot be enforcing anything and only breaks inserts; `clearStrandedTriggers()`
deletes it. A stranded trigger whose referenced table still exists was a **real** key, and
modern Postgres keeps a foreign key's shape in `pg_constraint` alone (`tgargs` is empty),
so nothing survives to rebuild it from. Those are reported and left; deleting them would
restore writes while quietly abandoning referential integrity. Do not.

Writing to the catalog directly does not invalidate the relation cache, so `initDb()`
reconnects after a repair — otherwise the connection keeps the trigger list it already
read and every insert goes on failing until the next launch. That reconnect is the
difference between the fix landing now and landing the second time the app is opened.

**`native/audiotap/`** is the fifth, and the only one that is not JavaScript: a Swift
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
