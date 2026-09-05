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
and icon, and archiving or deleting it. It says nothing about the other workspaces:
switching between them is the switcher's job, not a settings screen's. That is kept apart from
**Settings** in the sidebar, which is about the app rather than any one area: your
profile, the theme, where your data lives, and how to get it out.

Every settings screen — the app's, a workspace's, a project's — is the same shape: a
short list of panes down the left, one pane at a time on the right. A long scroll of
sections meant the thing you came to change was never where you left it; a pane is a
place, and it stays put. Which pane is open lives in the address, so anything that knows
what needs changing can send you to the pane itself rather than to the front of the
screen with an instruction to go and find it — which is how the assistant's "no key yet"
panel behaves.

### The first launch
The app opens the first time on an introduction rather than a form: what this is for,
the three questions above, and the one constraint everything else follows from — it has
to survive neglect. Only then does it ask for anything, and it asks for two things:
your name, and one working life to put in it. Nothing is written until the last button,
so leaving halfway through leaves nothing behind.

The name field starts filled in from the machine's own account, the workspace name
offers the three people actually use, and the progress rail starts with a segment
already complete, because installing it and opening it is not nothing.

It is shown **once**, and only to a genuinely new installation — the flow writes down
that it finished. Deleting or archiving your last workspace a year later gets the short
"create a workspace" screen instead, which is also where the archived ones are listed
for restoring. Someone upgrading from an older version never sees the introduction at
all: they already have workspaces, which is the proof they do not need it.

`Look around with sample data` is on that first panel too, for anyone who would rather
see it working than be told about it.

### Projects, and focus mode
Projects are either **active or archived** — nothing finer to filter by, and the archived
list is a quiet link beside the count rather than a row of tabs. The page is a grid of
cards carrying what you check before opening anything:
its **colour**, its **deadline**, the one-line summary, what it is asking for, who is on
it, how much is open and when the next date lands. The hat you wear is on the project
itself, not the card — you do not need reminding which role you hold in a project you
are one click from opening.

A project takes its workspace's colour until you give it one of its own in project
settings. It shows on the project's mark and in the fill of its deadline bar — never as a
stripe down the card or a wash across it, which is decoration rather than information. It
is there to be *found*: the project you keep coming back to is the one you should be able
to pick out of a grid without reading a word of it.

A project deadline is the date the whole thing has to land, separate from any task. On
the card it is a **bar measuring from the day the project was created**, because a date
on its own is arithmetic: "the 12th" tells you nothing until you work out that it is a
fortnight away and you have already had three months. The fill carries the project's own
colour while there is room and gives it up for amber inside a fortnight and red once the
date has passed — for that window, urgency is worth more than identity. It also puts the
project on Today's short list from two weeks out, so a project drifting towards its date
surfaces by itself.

Opening a project takes over the sidebar. The way out is the button at the top; while
you are in there the navigation is **Today, Kanban, Meetings, Notes, Decisions, People**,
with **Project settings** at the bottom, and nothing else. One thing at a time is the
point.

A project's Today is its front page — the re-entry brief, the links hub, what it is
asking for, and the log. Project settings is everything *about* the project rather than in it: its
icon, name and one-line summary, the hat you wear, its status, and archiving or deleting
it. That split keeps configuration out of a header you look at all day.

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

### The board
The Kanban board's columns are the workflow stages — To do, In progress, In review,
Done — renamed, reordered and added to from the board itself. There is no second axis to
file work along: worklanes were exactly that, and keeping them tidy cost more than the
structure was worth. Ticking a task done anywhere in the app moves its card to Done, and
dropping a card in Done ticks it: one truth, two views of it.

A card can be added straight into the column you are looking at — the `+` that appears
on a column's header when the pointer is over it, or the button an empty column shows
in place of the blank space it used to be. The board's own **Add item** still lands in
the first column, because that is what it has always meant.

### Today
One screen for the workspace you are in, grouped by urgency rather than by project:
overdue, due today, the next seven days, and the projects the app thinks need a look,
with the reason attached. Each row carries a rule in **its project's** colour rather
than its workspace's — every row on this screen belongs to the same workspace, so that
colour was the same on all of them and told you nothing.

Having nothing due and having nothing at all are different facts and get opposite
screens. A workspace with projects in it and a clear week says so and sends you off to
work. A workspace with nothing in it yet is not congratulated for being on top of
things: it says the next step is one project, explains what a project is for, and
offers the button — because this is the one screen in the app that has nothing to
derive an answer from.

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
When you have genuinely been away, a project opens with a brief: how long since your last
visit, and what changed while you were gone.

There used to be a **Where we are / Next action / Open questions** block above it — a
snapshot you overwrote by hand. It went, along with its columns, for the same reason the
health level did: it was three fields to maintain, it went stale exactly when you needed
it most (after a long absence), and everything it held is already recorded. The log keeps
what happened, the items keep what is left, and *"needs a look"* works out what is
pressing without being told.

Two timestamps make this work, both maintained automatically: `last_opened_at` (you
looked) and `last_activity_at` (something actually changed). Re-opening within thirty
minutes counts as the same visit, so the brief does not evaporate the moment you click in.

### Meetings
A meeting is a note that knows the things a meeting has: when it happened, who was in
the room, what was said and what came out of it. Attendees are real people from the
project, so months later the record answers "who agreed to this" — which a plain note
never can. A new meeting starts with everyone on the project ticked; you untick whoever
was absent, or untick all of them in one click and tick the two who turned up.

Writing one up is writing, so it gets a page rather than a dialog — the same Markdown
editor a note uses down the middle, and everything a meeting has that a note does not
in a rail down the right: the name, the date, who was there, and the to-do list. There
is no agenda field and no "where": an agenda is a heading in the write-up like any
other, and the room number stopped being interesting the moment the meeting ended.

**What the room left owing** is a list of real items rather than a slab of text, and
this is the part that pays for itself. The meeting list says "3 still to do" on the row
without you opening anything. Most of those items are done and forgotten inside a week
and never belong on the board — but right-click the one that turns out to be real work
and **Add to the board** makes it a card in the first column, carrying a note of which
meeting it came from. The item then says where it went and which column it is sitting
in, and from that moment the card is the one that knows whether it is finished: tick it
on the board and it ticks on the meeting, and the two can never drift apart.

### Decision log
A first-class record: what was decided, when, by whom, why, and **what was rejected**.
The rejected options are the half everyone forgets and the half that gets re-proposed
six months later.

### Journal, notes, links
The project Home page carries an append-only dated log of how you got here, alongside
the links hub — the board, the repo, the Figma file, the client's Drive folder — which
is the cheapest feature here and kills a surprising amount of the daily hunt. Notes get
their own page for everything that is not a meeting.

### Writing a note
A note opens as a page, not a dialog, and it takes the whole window: no project
heading, no tabs, no search bar. The project heading is for moving around and this is
the one screen where you are not, so the note starts at the top of the window and the
only chrome left — the way back, the word count, whether it is saved — floats over it.

It is **Markdown**, which is also how it is stored and how it is mirrored to disk, so
what you type is what survives. It renders itself as you write it, in the line you are
writing: type `## ` and that line becomes a heading with the cursor still in it, type
`- ` and it becomes a bullet. There is no preview and no preview pane, because a
preview is a second copy of the note that you have to look away from the first one to
see.

The syntax that has a visual form of its own — a bullet, a number, a checkbox, a quote
bar — is drawn instead of shown. The rest (`##`, `**`, a link's brackets) hides on every
line except the one the cursor is on, where you need to be able to edit it. Nothing is
rewritten: every character is still in the note, and the file on disk is the file you
typed.

Lists carry themselves on when you press Return and end when you press it on an empty
one, Backspace where the words start unmakes the item rather than chewing through `- `,
`⇥` and `⇧⇥` nest and lift, `⌘B` / `⌘I` / `⌘⇧K` wrap the selection, checkboxes tick when
clicked, and pasting a URL over selected text turns it into a link. Copying takes the
Markdown rather than what happens to be on screen.

Under it, this is a `contenteditable`, because a textarea has one font for the whole
box. Every edit is intercepted before the browser can apply it, applied to the Markdown
string instead, and the document redrawn from that string — so what you can see is
always a rendering of the text and never a source of it. Undo is the app's own for the
same reason: redrawing the document would have thrown the browser's history away.

It saves itself, continuously. A dialog can afford a Save button, because the only ways
out of one are deliberate; a page has a sidebar, a back gesture and `⌘K` next to it, and
losing an afternoon's writing to a stray click is not a trade worth making. Repeated
saves of the same note within half an hour collapse into a single line in the activity
log, so the thing that makes the re-entry brief readable is not drowned by the thing
that makes the writing safe.

### Confirmations
Anything destructive opens a dialog that says what is about to happen and what it will
take with it, rather than a button that quietly turns into "Sure?". It works from inside
other dialogs, and Escape or a click outside cancels.

### Needs a look
Never self-reported. A status you have to remember to update is always wrong, so Today
works out for itself which projects are asking for attention and says why in plain words:
*"2 overdue items, oldest 9 days past due"*, *"deadline in 3 days with 4 items still
open"*, *"standing still for 12 days"*.

Only the most pressing fact is shown, because a list of six projects each with three
caveats is not a short list. A project that is paused, dormant or done is in that state
on purpose and never gets dragged back into view. Thresholds live in one place,
`src/main/lib/attention.ts`.

This used to be a coloured health dot on every project surface — green, amber, red, with
the explanation hidden behind a tooltip. The colour was a thing you had to learn to read,
and it competed with the workspace colours for meaning; the reason itself turned out to be
the only part worth showing. Colour on a project now means identity, nothing more.

### Capturing something
`⌘N` opens one dialog for the four things worth capturing in a hurry — a **task**, a
**decision**, a **log entry** or a **meeting**. The project comes first and is shaped
differently from the fields under it, because it is the question you answer before any
of them; inside a project it is already answered and is not asked at all. Outside one it
arrives **already filled in with the project you had open last**, which is nearly always
the one you mean — and it says so on the row, because a default you cannot see the
reason for is a default you learn to distrust. Any other project is one click away. A task takes a
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
within the current workspace only. Before you have typed anything it is not an empty box
with an instruction in it: it lists the projects you have opened most recently, most
recent first, because that is what you were going to search for.

### The assistant
A panel down the right-hand side, opened with the button beside **New** or with `⌘J`. It
pushes the page rather than covering it, because what you are asking about is usually
what you are looking at.

It runs on **your own OpenAI key**, entered in workspace settings under Assistant, and
the key lives on the workspace rather than on the app — a workspace *is* a separate
working life, and the key a client is billed through should not be the one your day job's
questions go out on. The key is stored in the same folder as everything else and is never
sent back out of the main process; the settings screen is only ever told whether there
is one.

It can **read everything in the workspace it was opened in** — the board, the people and
how to work with them, the notes, the meeting write-ups, the decision log, the journal,
the links, the activity — and nothing outside it. Ask it what needs you this week, where
you got to on something, who to chase and about what.

It can also **change things**, and every change stops and asks first. The confirmation is
a sentence in plain words with the ids resolved out of it — *"Add "Draft the Q3 brief" to
Website relaunch, for Priya, due 2026-10-01"* — because a confirmation you cannot check is
one you learn to click through. Nothing is written until you say yes, and declining is
final: it is told so, and told not to try another way round.

Every write it makes goes through the same channel your own click goes through, so a task
it creates is not a special kind of task. It logs activity, bumps the project's clock and
lands in the Markdown mirror exactly as a hand-made one does, because it is the same code
path rather than a second copy of it.

Replies stream as they are written and render as real Markdown — headings, lists, tables,
code. You can **attach files**: images, PDFs, and text or code files, dropped onto the
panel or picked with the paperclip. Conversations are saved, listed in the panel's header
and switchable; each one names itself from the first exchange rather than being called
"New chat" forever or making you name it before you know what it is about.

## Your data

Everything lives in **`~/Documents/Neo`**:

- `db/` — an embedded PostgreSQL database (PGlite: real Postgres compiled to WebAssembly,
  running inside the app). No server, no Docker, nothing to install or start.
- `markdown/` — a plain-Markdown mirror of every project overview, note, meeting,
  decision and journal entry, rewritten automatically on every change. If this app is
  ever abandoned, the writing that matters survives in a format any editor opens.
- `icons/` — the images you upload for workspaces, projects and people. Files nothing
  references any more are swept on launch.
- `attachments/` — files you have dropped into a conversation with the assistant.
- `exports/` — JSON dumps of the structured data, on demand.

Nothing leaves the machine on its own. The one thing that ever does is a question you
type into the assistant, which goes to OpenAI on your own key along with whatever it
looked up to answer it — and only from the workspace you asked in. With no key saved,
nothing leaves at all.

## Calendar

Outlook integration is deliberately absent: the calendar is behind a corporate tenant
and was not available through the local macOS Calendar store either. Rather than fight
an AD policy, the **commitment** item type covers it — a date with no work attached, like
a demo or a board meeting — and it flows through Today and the Timeline exactly as a
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

Renaming the executable has one consequence worth knowing: `app.isPackaged` is derived
from that name, so a development run reports itself as packaged. The window therefore
decides which renderer to load from `ELECTRON_RENDERER_URL` — the dev server's own
address, which only exists when there is one — rather than from `isPackaged`, which
would send every `npm run dev` to the last production build in `out/` with no hot
reload and no sign that anything was wrong.

## Running it## Running it

```bash
npm install
npm run dev             # development, with hot reload
npm run build           # typecheck + production build
npm run dist            # packaged application
npm run verify          # exercise the whole backend headlessly
npm run verify:upgrade  # open a database written by an older version
```

On first launch the app introduces itself and then asks for your name and one workspace
(see [The first launch](#the-first-launch)). If you would rather look around first,
**load the sample data** from that first panel for a realistic set of three workspaces
with projects, people, meetings and history. Settings has no reset button: emptying the
database is a thing you do to the data folder, not something to leave a click away from
your own work.

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
| `Esc` | Close a dialog, or leave a settings screen |

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
the attention reasons, workspace isolation, the Today and review dashboards, the re-entry
brief, board stages, meetings, search, cascade deletes and both exports — in plain Node,
with no window and no display.
