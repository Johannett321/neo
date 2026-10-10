# Changelog

One Markdown file per release with a big new feature in it, named exactly as the version is:
`1.2.0.md`. Not every version has one — see *When to write one* below.
The folder ships inside the application, so the screen Neo shows on the first launch
after an update reads from here and needs no network. The release notes on GitHub are
generated from the same file when the tag is pushed — see `.github/workflows/release.yml`
— so a release is described once and not twice.

## When to write one

**Only for a release with a big new feature in it.** A screen that did not exist before,
a way of working that changed — that gets a file. A small feature, a fortnight of fixes,
a faster query, a tidier menu: **no file**, and therefore no popup. Writing them up does
not make them arrivals, and a screen that opens after every update is a screen people
learn to close unread. When in doubt, leave it out.

A version with no file here releases perfectly happily. The GitHub release falls back
to a plain sentence, and the app's *What changed* screen stays shut for that version —
so the next time it does open, it is because there is something to see.

## The format

A short list, not a page. **Three to five items**, each one an icon, a title of a few
words and at most one short sentence:

```markdown
---
title: Draw your team, share a workspace, and keep working offline
date: 2026-10-02
---

- [orgchart] **Draw the team** — Each project has a Team tab: drag people onto a board.
- [people] **Share a workspace** — Invite people from Workspace settings → Members.
- [cloudOff] **Keep working offline** — Neo sends your changes when Neo Cloud is back.
```

- `[icon]` is a name from the app's own icon set, `PATHS` in
  `src/renderer/src/components/Icon.tsx` (`orgchart`, `people`, `cloud`, `cloudOff`,
  `sparkle`, `bell`, `mic`, `canvas`, `note`, `link`, `today`, `download`…). `kebab-case`
  works too. A name that is not there draws as a sparkle, so check it in the app. Need
  one that does not exist? Add a path to `Icon.tsx` — there is no icon library to pull from.
- `**Title**` is what arrived, in a few words.
- After the dash (`—`, `–`, `-` or `:`), one sentence at most — or none. Backticks draw
  as a key, for a shortcut: `` `⇧⌘1` ``. Nothing else in the line is Markdown.

Every line of the body has to be an item for the file to be read as a list. Anything
else — a paragraph, a heading — and the whole file is drawn as Markdown instead, which
is how files written before this format still read. Do not write new ones that way.

Front matter is optional, and so is every key in it. With no `title:`, the first
`# heading` becomes one; with neither, the version stands in. The title is the dialog's
heading and the GitHub release's name, so make it say what the release is.

On GitHub the same list becomes the release notes, with the `[icon]` tags taken off.

## Illustrations

Not in the short format. A long-form file can still draw an image from `media/` written
as a relative path — `![How an update arrives](media/how-an-update-arrives.svg)` — which
the app's Markdown renderer turns into a `neo-media://` URL, the only kind of image the
renderer's CSP allows. An `https://` image is left as its alt text, because these are
read offline.
