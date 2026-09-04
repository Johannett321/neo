# Neo

A personal command centre for running several working lives at once — a day job
managing multiple teams, hands-on development, a company of your own, a consulting
client — without holding all of it in your head.

It is not a replacement for Jira, Linear or Notion. Those are where work gets
executed. This is the layer above them that answers the three questions no single
tool does:

1. **What is on fire today, across every context?**
2. **Who is who on this project again?**
3. **Where the hell were we on this?**

Everything is designed around one constraint: *it must survive neglect*. If keeping
it accurate is work, it gets abandoned in three weeks. So capture is cheap, almost
nothing needs manual upkeep, and every screen stays useful when the data is a month old.

## The features, and why each one exists

### Workspaces are separate areas
A workspace is a working life — a day job, your own company, a client. It has a name,
a colour and an optional uploaded icon, and it is a **hard boundary**: no screen mixes
two of them. Today, Projects, People, Timeline, the weekly review and search are all
fenced to the workspace you are in, and people belong to a workspace rather than
floating above them. Switching happens at the bottom-left of the sidebar, which tints
itself with the workspace colour so it is always obvious where you are.

The app ships with nothing in it; the first thing you do is create a workspace.

A workspace has its **own settings page**, reached from the switcher — its name, colour
and icon, what is inside it, the other workspaces, and archiving or deleting it. That is
kept apart from **Settings** in the sidebar, which is about the app rather than any one
area: your profile, where your data lives, and how to get it out.

### Projects, and focus mode
Projects are either **active or archived** — nothing finer to filter by, and the archived
list is a quiet link beside the count rather than a row of tabs. The page is a grid of
cards carrying what you check before opening anything:
health, the hat you wear, its **deadline**, the one-line summary, your next action, who
is on it, how much is open and when the next date lands.

A project deadline is the date the whole thing has to land, separate from any task. It
shows on the card — neutral while it is far off, amber inside a fortnight, red once it
has passed — in the project header, and it counts against health from two weeks out, so
a project drifting towards its date surfaces on Today by itself.

Opening a project takes over the sidebar. The way out is the button at the top; while
you are in there the navigation is **Today, Kanban, Meetings, Notes, Decisions, People**,
with **Project settings** at the bottom, and nothing else. One thing at a time is the
point.

A project's Today is its front page — the re-entry brief, where-we-are, the links hub
and the log. Project settings is everything *about* the project rather than in it: its
icon, name and one-line summary, the hat you wear, its status, its worklanes, and
archiving or deleting it. That split keeps configuration out of a header you look at
all day.

The swap is animated as a drill-down — the workspace list leaves to the left, the
project's navigation arrives from the right and its items settle in sequence — so
entering and leaving a project reads as movement rather than a jump cut. It respects
`prefers-reduced-motion`.

### Archiving and deleting
Both workspaces and projects can be **archived** or **deleted**. Archiving is the one
you want almost always: an archived project disappears from Today, the timeline, the
weekly review, search and the project grid, but keeps everything and comes back in one
click from the Archived tab. An archived workspace vanishes from the switcher and
reappears under Archived, ready to restore. Deleting is permanent and cascades — a
deleted workspace takes its projects, people, notes, meetings and decisions with it —
so both delete buttons ask before committing.

### Worklanes and the board
Worklanes are optional structure inside a project, created and ordered in project
settings. On the Kanban board the columns are
workflow stages — To do, In progress, Blocked, Done — and worklanes become swimlanes
across them when you turn that on. Ticking a task done anywhere in the app moves its
card to Done, and dropping a card in Done ticks it: one truth, two views of it.

### Today
One screen for the workspace you are in, grouped by urgency rather than by project:
overdue, due today, the next seven days, and the projects the app thinks need a look,
with the reason attached.

### You
You are a person too. One profile — name and photo, edited in Settings — mirrored into
every workspace as a person record, so you can be put on projects, given roles, assigned
tasks and listed as a meeting attendee exactly like anyone else. You appear first in the
People list and first in every project's cast with a "You" badge, and you cannot delete
yourself. You are put on every project you create and cannot be removed from one — the
way to say you are not involved is to leave your roles empty.

That replaces the old fixed "my role" dropdown on a project: the hat you wear is now just
your roles on that project, from the same vocabulary as everyone else's, and it shows on
the project card.

### People and roles
The role lives on the *connection* between a person and a project, not on the person,
so the same person can be a tech lead in one place and a stakeholder in another — and
a person usually has **several roles at once**, entered as badges: comma or Enter after
each, Backspace to take one back. The suggestions are the roles already used elsewhere
in the workspace, so your own vocabulary comes back to you without being enforced.

Adding someone to a project starts by **searching the people already in the workspace**,
because most of the cast of a new project is already somewhere else and retyping them
would create a second, slightly different copy of the same person. Pick them and their
photo, organisation and details come along; their role on *this* project is still yours
to set. Only if nobody matches do you fill in a new person.

People can have **uploaded photos**, which then follow them into the cast panel, meeting
attendees and project cards. Without one, the coloured initials are used.

Each person also carries a free-text "how to work with them" — prefers Slack, no meetings
before ten, is the one who actually approves budget — and a reverse view showing every
project they touch and their role in each.

### Re-entry
Every project has a **Where we are / Next action / Open questions** block: a snapshot,
deliberately overwritten, not a log. When you have genuinely been away, the project
opens with a brief — how long since your last visit, what changed while you were gone,
and the next action you left yourself.

Two timestamps make this work, both maintained automatically: `last_opened_at` (you
looked) and `last_activity_at` (something actually changed). Re-opening within thirty
minutes counts as the same visit, so the brief does not evaporate the moment you click in.

### Meetings
A meeting is a note that knows the things a meeting has: when it happened, who was in
the room, the agenda, what was said and what came out of it. Attendees are real people
from the project, so months later the record answers "who agreed to this" — which a
plain note never can. A new meeting starts with everyone on the project ticked; you
untick whoever was absent.

### Decision log
A first-class record: what was decided, when, by whom, why, and **what was rejected**.
The rejected options are the half everyone forgets and the half that gets re-proposed
six months later.

### Journal, notes, links
The project Home page carries an append-only dated log of how you got here, alongside
the links hub — the board, the repo, the Figma file, the client's Drive folder — which
is the cheapest feature here and kills a surprising amount of the daily hunt. Notes get
their own page for everything that is not a meeting.

### Confirmations
Anything destructive opens a dialog that says what is about to happen and what it will
take with it, rather than a button that quietly turns into "Sure?". It works from inside
other dialogs, and Escape or a click outside cancels.

### Derived health
Never self-reported. A status you have to remember to update is always wrong. Health is
computed from overdue items and how overdue, a deadline approaching with open work under
it, and active projects that have gone quiet for three weeks. The badge always explains itself: *"At risk — 3 overdue tasks, oldest 9
days past due."* Thresholds live in one place, `src/main/lib/health.ts`.

### Capturing something
`⌘N` opens one dialog for the four things worth capturing in a hurry — a **task**, a
**decision**, a **log entry** or a **meeting**. The project comes first and is shaped
differently from the fields under it, because it is the question you answer before any
of them; inside a project it is already answered and is not asked at all. A task takes a
title, a note, an assignee (including yourself) and an optional due date, and always lands
in the board's first column; a meeting takes just a name, which is optional, and a date
that defaults to today — the notes and attendees can come afterwards.

Assigning a task to someone else records it as delegated, so it lands in the right part
of Today without you having to say so. Whatever you create confirms itself with a toast
in the corner that takes you to where it went — a quick capture should not feel like it
vanished.

Editing an item never asks what *kind* it is either: work someone else owns is delegated,
work you own is yours. It follows from the assignee, so the two cannot drift apart.

Dates are picked with the app's own control rather than the platform's: clicking the field
opens a popover with **Today, Tomorrow, Next Monday, In a week, In a month** alongside a
month calendar, because the shortcut is nearly always the answer.

### Right-click
Almost everything has a context menu: a project card (open, board, settings, pin, archive,
delete), a task row or board card (mark done, edit, move to a column, delete), a board
column (rename, move, mark as the done column, delete), a person, a note, a decision, a
meeting, a link. Destructive items say what will happen and ask before doing it, and that
question is asked in one place rather than reimplemented at each call site.

### Command palette
`⌘K` searches projects, people, tasks, notes, decisions and journal entries at once —
within the current workspace only.

## Your data

Everything lives in **`~/Documents/Neo`**:

- `db/` — an embedded PostgreSQL database (PGlite: real Postgres compiled to WebAssembly,
  running inside the app). No server, no Docker, nothing to install or start.
- `markdown/` — a plain-Markdown mirror of every project overview, note, meeting,
  decision and journal entry, rewritten automatically on every change. If this app is
  ever abandoned, the writing that matters survives in a format any editor opens.
- `icons/` — the images you upload for workspaces, projects and people. Files nothing
  references any more are swept on launch.
- `exports/` — JSON dumps of the structured data, on demand.

Nothing leaves the machine. Back it up by copying the folder.

## Calendar

Outlook integration is deliberately absent: the calendar is behind a corporate tenant
and was not available through the local macOS Calendar store either. Rather than fight
an AD policy, the **commitment** item type covers it — a date with no work attached, like
a demo or a board meeting — and it flows through Today, Timeline and health exactly as a
calendar event would. If access ever becomes possible, it drops in behind the same
`commitment` shape without disturbing anything else.

## The name and the icon

Neo, as in new — the app is where a thing that is new to you gets written down, and where
you pick it back up. The icon is three white squares stepping down a diagonal on a
rose-to-amber gradient: separate things, held in one line of sight.

`build/icon.svg` records the design; `scripts/make-icon.mjs` produces `icon.png`, the
iconset and the `.icns`. There is no SVG rasteriser on a stock macOS, so the script draws
the shapes from signed distance fields and renders each size natively rather than
downscaling one master, which is what keeps the 16px version crisp.

The two colours are adjacent on the wheel deliberately. Complementary pairs — blue and
orange, say — cancel to grey-brown where they blend, which is what made earlier attempts
look muddy no matter how vivid the ends were.

`scripts/dev-branding.mjs` puts the name and icon on the development bundle. In
development the app runs inside `node_modules`' `Electron.app`, and macOS takes the
menu-bar title from `CFBundleName`, the dock label from the **executable**, and the
tooltip from LaunchServices' cache keyed on the **bundle identifier** — so all four have
to change, and the stale LaunchServices entry has to be dropped, before the app stops
calling itself Electron. It runs on `npm run dev` and after every install.

## Running it## Running it

```bash
npm install
npm run dev             # development, with hot reload
npm run build           # typecheck + production build
npm run dist            # packaged application
npm run verify          # exercise the whole backend headlessly
npm run verify:upgrade  # open a database written by an older version
```

On first launch the app asks you to create a workspace. If you would rather look around
first, **load the sample data** — from that screen or from Settings — for a realistic set
of three workspaces with projects, people, meetings and history. **Settings → Delete
everything** clears it again.

### The menu, and shortcuts

There is a real application menu: **File** for creating things and reaching your data
folder, **Edit** with the standard roles (so text fields keep undo, redo and the system
emoji picker), **Go** for jumping between screens, plus View, Window and Help. Menu items
drive the same actions the buttons and keyboard do rather than a parallel set of their own.

| Key | |
|---|---|
| `⌘K` | Search everything |
| `⌘N` | New item, from anywhere |
| `⌘⇧N` | New project |
| `⌘1`–`⌘3` | Today, Projects, People |
| `⌘[` / `⌘]` | Back and forward |
| `⌘,` | Settings |
| `⌘⇧O` | Reveal the data folder |
| `⌘↵` | Save and close a dialog |
| `Esc` | Close a dialog |

## How it is built

- **Electron 44**, main process + renderer, with a typed IPC bridge as the only surface
  between them. The database, filesystem and shell never reach the renderer.
- **PGlite** for storage, driven with plain SQL. The DDL in `src/main/db/ddl.ts` is the
  single source of truth and is applied idempotently on launch.
- **React 19 + TanStack Query** in the renderer, with React Router in hash mode and
  Framer Motion for the sidebar transition.
- **Tailwind 4 + daisyUI 5** on a custom theme, light and dark.
- `src/shared/api.ts` maps every IPC channel to its input and output types, so the
  renderer cannot call a channel that main does not handle.

Calendar dates are stored as `text` in `YYYY-MM-DD` rather than as `date` columns —
a desktop app renders dates in local time, and round-tripping a `date` through a driver
that returns UTC-midnight is how you end up showing "due yesterday".

### Looking after the data

PGlite is an in-process engine with no lock of its own, so two copies of the app writing
the same folder will corrupt it. The app therefore takes a single-instance lock and a
second launch focuses the window already open **without ever opening the database**.
Quitting is deferred until the database has been flushed, and Ctrl-C in development gets
the same treatment, because a half-written shutdown is the other way this breaks.

If a b-tree index is damaged anyway — a force quit, a crash — Postgres reports `XX002` on
startup. Rather than refusing to open, the app rebuilds the index and carries on: the row
data is never what is damaged in that failure, only the index over it. That path has been
run against a genuinely corrupted database, not just a simulated one.

### Migrations

The schema is applied idempotently on launch: `DDL` creates tables and indexes in one
batch, then `MIGRATIONS` runs one statement at a time, in four groups — columns, then
constraint changes, then backfills, then indexes. Keep that order: an index or an
`UPDATE` that mentions a column added further down the list will fail on an older
database, which is exactly the bug the grouping prevents. That split is not cosmetic —
PostgreSQL parses *every* statement in a multi-statement batch before executing any of
them, so a statement referencing a column that an `ALTER` in the same batch is about to
add fails to parse. Anything that depends on a migrated column — an `UPDATE`, an index —
must live in `MIGRATIONS`, below the `ALTER` that creates it.

`npm run verify:upgrade` builds a database in an older shape and opens it with the
current code, which is the only way that class of bug gets caught before launch.

### Tests

`npm run verify` stubs Electron and drives the real IPC handlers end to end — sample data,
health derivation, workspace isolation, the Today and review dashboards, the re-entry
brief, board stages, meetings, search, cascade deletes and both exports — in plain Node,
with no window and no display.
