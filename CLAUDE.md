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
- **Pausing is the one hand-set state, and it only subtracts.** `status = 'paused'` is
  set from the project card's context menu or the Status field, and the whole of what it
  does is fence `dashboard:today` — tasks, meeting to-dos, needs-a-look and the header
  counts, all through the one `inWorkspace` clause. It is allowed past the no-hand-kept-
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
  are handled centrally. Do not reimplement a confirm at a call site.
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
- Workspace colours are identifiers, not surfaces — a dot or a 2px rule, never a filled
  block. Theme tokens for `pm` / `pmdark` live in `styles.css`.

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

PGlite (real PostgreSQL compiled to WebAssembly, in-process) writing to `~/Documents/Neo`.
No server, no Docker, nothing to start.

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

One consequence of renaming the executable: Electron derives `app.isPackaged` from that
name, so a development run reports itself as **packaged**. Anything choosing a behaviour
by `isPackaged` will pick the production one under `npm run dev` — which is how the
window came to load the stale build in `out/renderer` instead of the dev server, with no
hot reload and no error. `createWindow()` now switches on `ELECTRON_RENDERER_URL`, which
exists exactly when a dev server does. Do not reintroduce `isPackaged` as a dev check.

`scripts/make-icon.mjs` generates `icon.png`, the iconset and the `.icns` from signed
distance fields, drawing each size natively rather than downscaling one master. There is no
SVG rasteriser on a stock macOS, which is why it is written that way.
