# Changelog

One Markdown file per released version, named exactly as the version is: `1.2.0.md`.
The folder ships inside the application, so the screen Neo shows on the first launch
after an update reads from here and needs no network. The release notes on GitHub are
generated from the same file when the tag is pushed — see `.github/workflows/release.yml`
— so a release is described once and not twice.

A release with no file here will fail the release workflow on purpose. Saying what
changed is part of shipping it.

## The format

Front matter is optional, and so is every key in it:

```markdown
---
title: Updates that install themselves
date: 2026-09-06
---

Prose. Ordinary Markdown — headings, lists, bold, links, code.
```

With no `title:`, the first `# heading` becomes one and is taken out of the body. With
neither, the version stands in. A one-line file is a perfectly good entry.

## Illustrations

Put images in `media/` and write them as relative paths:

```markdown
![How an update arrives](media/how-an-update-arrives.svg)
```

An image on a line of its own becomes a full-width figure with its alt text as the
caption; an image inside a sentence stays inline and small. Both are drawn by the
app's own Markdown renderer, which turns a relative path into a `neo-media://` URL —
the same scheme the workspace banner uses — because the renderer's CSP allows an image
from nowhere else, and because the point of bundling them is that they work offline.

So **only relative paths draw**. An `https://` image is left as its alt text: it would
be a broken icon on the train, which is where these get read.

PNG, JPEG, WebP, GIF and SVG are all bundled. Keep them narrow — the dialog is about
640px wide — and prefer SVG for anything diagrammatic, since it stays sharp and weighs
nothing. An SVG loaded this way cannot inherit the app's colours, so draw with a
palette that reads on both a light and a dark background.
