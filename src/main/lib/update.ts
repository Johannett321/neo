import type { ChangelogEntry } from '@shared/update'

/**
 * The part of updating that is only arithmetic and text.
 *
 * Pure, and separated from the runner beside it for the same reason `notify.ts` is
 * separated from `notifier.ts`: comparing two versions, choosing which file of a
 * release belongs on this machine and turning a Markdown file into something the
 * screen can draw are all questions with one right answer, and a test should be able
 * to ask them without a network, a disk or an app.
 */

/** A release as GitHub describes it, reduced to the parts this app reads. */
export interface Release {
  version: string
  notes: string
  publishedAt: string
  assets: { name: string; url: string; bytes: number }[]
}

export interface Asset {
  name: string
  url: string
  bytes: number
}

const NUMBERS = /^\d+$/

/**
 * Compare two versions the way a person would read them: number by number, and a
 * pre-release before the version it leads to. Negative when `a` is older.
 *
 * Hand-rolled rather than pulled in, like everything else here. It is fifteen lines,
 * it never has to handle a range or a caret, and the two versions it compares are
 * both written by this repository.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const [core, ...rest] = v.replace(/^v/, '').split('-')
    return [core.split('.').map((p) => (NUMBERS.test(p) ? Number(p) : 0)), rest.join('-')]
  }
  const [left, leftPre] = split(a)
  const [right, rightPre] = split(b)

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  // 1.2.0-beta.1 is not 1.2.0, and comes before it. Two pre-releases of the same
  // version fall back to reading them as text, which is right often enough and
  // never wrong in a way that matters: neither is offered as an update.
  if (leftPre === rightPre) return 0
  if (!leftPre) return 1
  if (!rightPre) return -1
  return leftPre < rightPre ? -1 : 1
}

/** Whether `candidate` is a version worth offering to somebody running `current`. */
export const isNewer = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) > 0

/** What GitHub's answer means, with everything this app does not read left behind. */
export function parseRelease(json: unknown): Release | null {
  if (!json || typeof json !== 'object') return null
  const raw = json as Record<string, unknown>
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : ''
  const version = tag.replace(/^v/, '').trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) return null
  // A draft has no business being offered to anybody, and `/latest` should never
  // hand one over — but it costs a line to be sure, and this is the one place in the
  // app that acts on something downloaded from the internet.
  if (raw.draft === true || raw.prerelease === true) return null

  const assets = Array.isArray(raw.assets)
    ? raw.assets.flatMap((entry): Asset[] => {
        if (!entry || typeof entry !== 'object') return []
        const asset = entry as Record<string, unknown>
        const name = typeof asset.name === 'string' ? asset.name : ''
        const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
        // Only ever from the place the release itself lives. A `browser_download_url`
        // is written by GitHub, not by us, and this is what stops a redirect from
        // somewhere else being followed with a shell script waiting at the end of it.
        if (!name || !url.startsWith('https://github.com/')) return []
        return [{ name, url, bytes: typeof asset.size === 'number' ? asset.size : 0 }]
      })
    : []

  return {
    version,
    notes: typeof raw.body === 'string' ? raw.body.trim() : '',
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    assets
  }
}

/**
 * Which file of a release belongs on this machine.
 *
 * macOS takes the **zip** and never the disk image: a `.dmg` is a thing a person
 * mounts and drags out of, and the whole point of this is that nobody does that. The
 * zip holds the same bundle, and `ditto` unpacks one without flattening the symlinks
 * or the signature the way `unzip` does.
 *
 * The architecture is matched exactly rather than nearly. An Apple silicon Mac will
 * happily run the Intel build under Rosetta, which means a loose match here would
 * quietly move somebody onto the wrong build and never say so.
 */
export function pickAsset(assets: Asset[], platform: string, arch: string): Asset | null {
  const has = (name: string, token: string): boolean => name.toLowerCase().includes(token)

  if (platform === 'darwin') {
    const macs = assets.filter((a) => a.name.endsWith('-mac.zip'))
    const exact = macs.find((a) => has(a.name, arch))
    if (exact) return exact
    // electron-builder writes the architecture into every name but x64's, where it
    // leaves it out — `Neo-1.2.0-arm64-mac.zip` beside `Neo-1.2.0-mac.zip`. So the
    // absence of *both* tokens means Intel, and it means that only for Intel.
    if (arch !== 'x64') return null
    return macs.find((a) => !has(a.name, 'arm64') && !has(a.name, 'x64')) ?? null
  }

  if (platform === 'win32') {
    return assets.find((a) => a.name.endsWith('.exe') && has(a.name, 'setup')) ?? null
  }

  if (platform === 'linux') {
    const images = assets.filter((a) => a.name.endsWith('.AppImage'))
    // AppImage names carry the machine's own word for the architecture rather than
    // Node's, so both spellings are looked for before falling back to the only one.
    const token = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
    return images.find((a) => has(a.name, token) || has(a.name, arch)) ?? images[0] ?? null
  }

  return null
}

/* ------------------------------------------------------------------ the changelog */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * One changelog file, as written in the repository.
 *
 * The front matter is optional and so is every key in it, because a release that
 * fixed one thing should cost one sentence in a file and nothing else. A file with
 * no title falls back to its first heading, and then to its version — so the
 * simplest possible entry is a line of prose, and the most elaborate is prose with
 * headings and screenshots. Both draw.
 */
export function parseChangelog(version: string, text: string): ChangelogEntry {
  let title = ''
  let date = ''
  let body = text.replace(/^﻿/, '')

  const front = FRONT_MATTER.exec(body)
  if (front) {
    body = body.slice(front[0].length)
    for (const line of front[1].split(/\r?\n/)) {
      const at = line.indexOf(':')
      if (at < 1) continue
      const key = line.slice(0, at).trim().toLowerCase()
      const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'title') title = value
      else if (key === 'date') date = value
    }
  }

  body = body.trim()
  if (!title) {
    // A leading `# heading` is the title, and is taken *out* of the body: the screen
    // draws it as the dialog's own heading, and having it twice looks like a mistake.
    // `.` stops at a newline, so a greedy match is the whole heading line and no
    // more. A lazy one with an optional newline after it matched a single letter.
    const heading = /^#[ \t]+(.+)(?:\r?\n|$)/.exec(body)
    if (heading) {
      title = heading[1].trim()
      body = body.slice(heading[0].length).trim()
    }
  }

  return { version, title: title || `Version ${version}`, date, body: rewriteMedia(body) }
}

/**
 * Point every illustration at the scheme that can actually serve it.
 *
 * A changelog's screenshots are files bundled beside it, written in the file as the
 * ordinary relative paths a person would type — `![…](media/updates.png)`. The
 * renderer cannot read a path, so they are rewritten here to the same `neo-media://`
 * scheme the workspace banner uses, which is also the only kind of image the
 * Markdown renderer will draw. An absolute URL is left exactly as written, and
 * therefore stays a link rather than becoming a picture: the changelog that ships
 * with the app has to work with no network, and an image from the internet would not.
 */
const rewriteMedia = (body: string): string =>
  body.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (whole, open: string, url: string, close: string) =>
    /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')
      ? whole
      : `${open}neo-media://changelog/${url.replace(/^\.?\//, '')}${close}`
  )

/** The version a changelog file is for, or empty if the name is not one. */
export const changelogVersion = (filename: string): string => {
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.md$/.exec(filename)
  return match ? match[1] : ''
}

/* ------------------------------------------------------------- the swap, as a script */

/**
 * How a Mac replaces its own application.
 *
 * Written out as a shell script and run *detached*, after the app has gone, because
 * nothing else can do this job: a process cannot reliably move the bundle it is
 * running out of the way and put another one there, and Electron's own relaunch
 * would restart a bundle that is halfway through being replaced.
 *
 * It is generated here, as text, so a test can read it without a Mac.
 *
 * Three properties matter and all three are in the ordering. The old bundle is moved
 * aside rather than deleted, so a failed move puts it straight back and the person is
 * left running the version they already had rather than nothing at all. The
 * quarantine flag is cleared, because a bundle this app downloaded itself has none
 * but one moved by hand into the staging folder might. And the app is opened *before*
 * anything is tidied up, so a slow disk cannot cost somebody their application.
 */
export function macSwapScript(input: {
  /** The `.app` this copy is running out of. */
  app: string
  /** The unpacked replacement, already checked. */
  staged: string
  /** Where the outgoing bundle is parked while the new one moves in. */
  backup: string
  pid: number
}): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
# Neo replacing itself. Written by the app; nothing else reads it.
APP=${quote(input.app)}
NEW=${quote(input.staged)}
BACKUP=${quote(input.backup)}

# The app asked for this on its way out, but "asked" is not "gone": a bundle must
# not move out from under a process still reading it. Sixty seconds is far longer
# than a quit takes and still finite, so a wedged process cannot strand an update.
i=0
while kill -0 ${input.pid} 2>/dev/null && [ $i -lt 300 ]; do
  sleep 0.2
  i=$((i + 1))
done

rm -rf "$BACKUP"
mv "$APP" "$BACKUP" || exit 1
if ! mv "$NEW" "$APP"; then
  mv "$BACKUP" "$APP"
  exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null

open "$APP"
rm -rf "$BACKUP"
`
}

/**
 * The same job on Linux, where an application is one file.
 *
 * An AppImage is copied over rather than moved, so that whatever the file's owner,
 * permissions and extended attributes were, they stay what they were — a `mv` from
 * the staging folder would quietly hand the launcher a file with different ones.
 */
export function appImageSwapScript(input: {
  image: string
  staged: string
  pid: number
}): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
# Neo replacing itself. Written by the app; nothing else reads it.
APP=${quote(input.image)}
NEW=${quote(input.staged)}

i=0
while kill -0 ${input.pid} 2>/dev/null && [ $i -lt 300 ]; do
  sleep 0.2
  i=$((i + 1))
done

cp "$NEW" "$APP.incoming" || exit 1
chmod +x "$APP.incoming"
mv "$APP.incoming" "$APP" || exit 1
"$APP" &
`
}
