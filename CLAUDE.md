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
icon storage), `db/` the client, schema and row mapping.

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
- **Settings screens are panes, not scrolls.** App, workspace and project settings all
  render through `components/SettingsLayout.tsx`: a short list down the left, one pane at
  a time on the right. Add a pane rather than another section stacked below the last one,
  and if a screen needs more than about five, the screen is doing too much.
- **Icons are hand-rolled paths** in `components/Icon.tsx` on a 24px grid, single stroke
  weight. Nothing is fetched at runtime; add a path rather than a dependency.
- **Dates use `components/DateField.tsx`**, never `<input type="date">`.
- Workspace colours are identifiers, not surfaces — a dot or a 2px rule, never a filled
  block. Theme tokens for `pm` / `pmdark` live in `styles.css`.

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

## macOS naming

In development the app runs inside `node_modules`' Electron bundle, and macOS reads its
name from four independent places: `CFBundleName` (menu bar), the executable name (dock
label), `CFBundleIdentifier` (LaunchServices' cached name) and the **bundle's filename**
(dock tooltip). `scripts/dev-branding.mjs` sets all four — including renaming
`Electron.app` → `Neo.app` and rewriting `node_modules/electron/path.txt` — and drops the
stale LaunchServices entry. It runs on `npm run dev` and after every install. If the dock
starts saying "Electron" again, that script is where to look.

`scripts/make-icon.mjs` generates `icon.png`, the iconset and the `.icns` from signed
distance fields, drawing each size natively rather than downscaling one master. There is no
SVG rasteriser on a stock macOS, which is why it is written that way.
