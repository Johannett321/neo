import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { open as openFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, net } from 'electron'
import type { UpdateCapability, UpdatePreference, UpdateStatus } from '@shared/update'
import { RELEASES_PAGE, UPDATE_FEED } from '@shared/update'
import { appImageSwapScript, isNewer, macSwapScript, parseRelease, pickAsset } from './update'

const run = promisify(execFile)

/**
 * Neo replacing itself.
 *
 * A runner, like the notifier and the recording pipeline, and held up by the same
 * rule: **the thing that matters is on disk before it is needed**. An update is not
 * a download held in memory and applied at the end — it is unpacked, checked and
 * parked beside the application as a complete, working copy, and only then is
 * anything swapped. A crash at any point before the swap costs a folder that the
 * next launch sweeps up; a crash during it leaves the old version in place, because
 * the old bundle is moved aside rather than deleted and put back if the move fails.
 *
 * The swap itself is a detached shell script and cannot be anything else. A process
 * cannot replace the bundle it is running out of and then start it again — so what
 * the app does at the end is write the script, ask to quit, and let the script wait
 * for it to go.
 *
 * There is no Squirrel here and no `electron-updater`, for one reason: both validate
 * the incoming bundle against the running one's code signature, and this app is
 * ad-hoc signed, which pins that requirement to a hash that changes with every build.
 * They would refuse every update this repository will ever publish. What stands in
 * for that check is below — the bundle must be Neo's own identifier, the version it
 * claimed to be, and a bundle macOS itself agrees is intact.
 */

/** Every six hours, and once shortly after launch. A release is not an emergency. */
const CHECK_MS = 6 * 60 * 60 * 1000

/** Long enough after launch that it is never competing with the first screen. */
const FIRST_CHECK_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null
let preference: UpdatePreference = 'automatic'
let busy = false

/**
 * The staged install, once there is one: what to run on the way out.
 *
 * Held in memory on purpose, and it is the one thing here that is. It means "the
 * person agreed to this update in this session" — a setting that survived a restart
 * and silently installed something on the next quit would be an app that updates
 * itself at a moment nobody chose.
 */
let staged: { version: string; install: () => void } | null = null

let status: UpdateStatus = {
  phase: 'idle',
  current: app.getVersion(),
  version: '',
  notes: '',
  progress: 0,
  bytes: 0,
  reason: '',
  checkedAt: ''
}

export const updateStatus = (): UpdateStatus => status

/** Whether something is waiting to be applied the next time the app closes. */
export const updateStaged = (): boolean => staged !== null

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('update', status)
  }
}

/* ------------------------------------------------------------------ what this copy is */

/**
 * The dev server's own URL, and the only honest signal that this is a development
 * run. `app.isPackaged` cannot do it — dev-branding renames the executable, so a
 * development run calls itself packaged — and a development run replacing the
 * Electron bundle inside `node_modules` with a release would be a memorable bug.
 */
const isDev = (): boolean => Boolean(process.env.ELECTRON_RENDERER_URL)

/** The `.app` this copy is running out of, or empty when it is not in one. */
function macBundle(): string {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(app.getPath('exe'))
  return match ? match[1] : ''
}

let capability: UpdateCapability | null = null

/**
 * Whether this copy can replace itself, and what it will cost when it does.
 *
 * Worked out once and remembered: it runs `codesign`, and the answer cannot change
 * while the app is open. `resetsPermissions` is read from the signature rather than
 * assumed from the absence of a certificate, so the day there is a real Developer ID
 * the whole permissions panel retires itself without a line of this being touched.
 */
export async function updateCapability(): Promise<UpdateCapability> {
  if (capability) return capability

  const no = (reason: string): UpdateCapability => ({
    canSelfUpdate: false,
    reason,
    resetsPermissions: false
  })

  if (isDev()) {
    capability = no('This is a development build; it updates when you rebuild it.')
    return capability
  }

  if (process.platform === 'darwin') {
    const bundle = macBundle()
    if (!bundle) {
      capability = no('Neo is not running from an application bundle.')
      return capability
    }
    const writable = await access(dirname(bundle), constants.W_OK).then(
      () => true,
      () => false
    )
    if (!writable) {
      capability = no(`Neo cannot write to ${dirname(bundle)}, so it cannot replace itself there.`)
      return capability
    }
    capability = { canSelfUpdate: true, reason: '', resetsPermissions: await isAdHoc(bundle) }
    return capability
  }

  if (process.platform === 'win32') {
    capability = { canSelfUpdate: true, reason: '', resetsPermissions: false }
    return capability
  }

  if (process.platform === 'linux') {
    capability = process.env.APPIMAGE
      ? { canSelfUpdate: true, reason: '', resetsPermissions: false }
      : no('Only the AppImage build can replace itself.')
    return capability
  }

  capability = no('This platform has no update route.')
  return capability
}

/**
 * Whether the bundle is ad-hoc signed, which is the same question as "will macOS
 * forget the microphone when this updates".
 *
 * `codesign -dv` writes to **stderr** even when it succeeds — the same thing
 * `sign-adhoc.mjs` documents — and an ad-hoc signature is the line `Signature=adhoc`.
 * Anything this cannot answer is answered as "no", because a permissions panel shown
 * to somebody who does not need one is worse than no panel at all.
 */
async function isAdHoc(bundle: string): Promise<boolean> {
  try {
    const { stderr } = await run('codesign', ['-dv', bundle])
    return /Signature=adhoc/.test(stderr)
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    return /Signature=adhoc/.test(stderr)
  }
}

/* --------------------------------------------------------------------- the staging area */

/** Beside the application's own support files, never in the folder holding your work. */
const stageRoot = (): string => join(app.getPath('userData'), 'updates')

/**
 * Old staging folders, from an update that was downloaded and never applied or from
 * one that was. Swept at launch, exactly as orphaned recording folders are: a
 * half-downloaded release is megabytes, and nothing else will ever come back for it.
 *
 * The launch it usually runs on is the one the swap script *started*, and that script
 * is still finishing up in here — clearing the bundle it moved aside. So the two race
 * on purpose, and both are `force` removals that do not mind losing: whichever gets
 * there first is right, and the loser has nothing left to delete. One folder that
 * will not go must not stop the sweep either, which is why the failure is caught
 * around each entry rather than around the loop.
 */
export async function pruneStaged(): Promise<number> {
  const root = stageRoot()
  if (!existsSync(root)) return 0
  let removed = 0
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  for (const entry of entries) {
    try {
      await rm(join(root, entry), { recursive: true, force: true })
      removed++
    } catch {
      /* A staging folder that will not go is not worth a word to anybody. */
    }
  }
  return removed
}

/* ------------------------------------------------------------------------- checking */

/**
 * Ask what the latest release is. Returns quietly on every failure — no network, a
 * rate limit, GitHub having a bad afternoon — because none of them are things the
 * person in front of the app can do anything about, and none of them stop the app
 * being the app.
 */
export async function checkForUpdate(manual = false): Promise<UpdateStatus> {
  if (preference === 'off' && !manual) return status
  if (busy) return status

  const can = await updateCapability()
  busy = true
  set({ phase: 'checking', reason: '' })
  try {
    const response = await net.fetch(UPDATE_FEED, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Neo/${app.getVersion()}` }
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
    const release = parseRelease(await response.json())
    if (!release) throw new Error('That release could not be read.')

    const checkedAt = new Date().toISOString()
    if (!isNewer(release.version, app.getVersion())) {
      set({ phase: 'current', version: '', notes: '', progress: 0, bytes: 0, checkedAt, reason: '' })
      return status
    }

    // There is a newer version, and this copy cannot take it. Saying so is the whole
    // job here: the screen offers the download page instead of pretending.
    if (!can.canSelfUpdate) {
      set({
        phase: 'unsupported',
        version: release.version,
        notes: release.notes,
        checkedAt,
        reason: can.reason
      })
      return status
    }

    const asset = pickAsset(release.assets, process.platform, process.arch)
    if (!asset) {
      set({
        phase: 'unsupported',
        version: release.version,
        notes: release.notes,
        checkedAt,
        reason: `Neo ${release.version} has no build for this machine yet.`
      })
      return status
    }

    set({
      phase: 'available',
      version: release.version,
      notes: release.notes,
      bytes: asset.bytes,
      progress: 0,
      checkedAt,
      reason: ''
    })
  } catch (error) {
    set({
      phase: 'error',
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    })
  } finally {
    busy = false
  }

  // Automatic means automatic. The download starts itself and says so while it runs;
  // nothing is applied until the app is closed, which is the only moment replacing it
  // costs nobody their place.
  if (preference === 'automatic' && status.phase === 'available') void downloadUpdate()
  return status
}

/* ------------------------------------------------------------------------ downloading */

/** Fetch the release for this machine, check it, and park it ready to be applied. */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (busy || status.phase === 'ready' || status.phase === 'downloading') return status
  if (status.phase !== 'available') return status

  const version = status.version
  busy = true
  set({ phase: 'downloading', progress: 0, reason: '' })

  const dir = join(stageRoot(), version)
  try {
    const response = await net.fetch(UPDATE_FEED, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Neo/${app.getVersion()}` }
    })
    const release = parseRelease(await response.json())
    const asset = release && pickAsset(release.assets, process.platform, process.arch)
    if (!release || !asset || release.version !== version) {
      throw new Error('That release changed while it was being fetched.')
    }

    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const file = join(dir, asset.name)
    await downloadTo(asset.url, file, asset.bytes)

    const install = await prepare(version, file, dir)
    staged = { version, install }
    set({ phase: 'ready', progress: 1, reason: '' })
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    set({
      phase: 'error',
      progress: 0,
      reason: error instanceof Error ? error.message : String(error)
    })
  } finally {
    busy = false
  }
  return status
}

/**
 * Stream it to disk, saying how far it has got.
 *
 * Through Electron's own network stack rather than Node's, so a machine behind a
 * corporate proxy — which is exactly the machine a day job runs on — downloads an
 * update through the proxy the rest of the app already uses.
 */
async function downloadTo(url: string, path: string, expected: number): Promise<void> {
  const response = await net.fetch(url, { headers: { 'user-agent': `Neo/${app.getVersion()}` } })
  if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}.`)

  const total = Number(response.headers.get('content-length')) || expected
  const handle = await openFile(path, 'w')
  let written = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await handle.write(value)
      written += value.byteLength
      if (total > 0) set({ progress: Math.min(0.99, written / total) })
    }
  } finally {
    await handle.close()
  }

  // A truncated download is the ordinary failure — a lid closed on a train — and it
  // has to be caught here rather than discovered by whatever tries to unpack it.
  if (expected > 0 && written !== expected) {
    throw new Error(`The download stopped early (${written} of ${expected} bytes).`)
  }
}

/* -------------------------------------------------------------------- unpack and check */

/**
 * Turn a downloaded file into something that can be applied, and refuse if it is not
 * what it said it was.
 *
 * This is the part standing in the place Gatekeeper usually stands. The app is not
 * quarantined — nothing downloaded by an application is, unless it asks to be — so
 * macOS will not check this bundle on anyone's behalf, which means these three
 * questions are the only ones that get asked: is it Neo, is it the version it
 * claimed, and does macOS agree the bundle is intact and unmodified since signing.
 */
async function prepare(version: string, file: string, dir: string): Promise<() => void> {
  if (process.platform === 'darwin') {
    const bundle = macBundle()
    const unpacked = join(dir, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    // `ditto`, never `unzip`: an application bundle is full of symlinks and a signed
    // one carries extended attributes, and only ditto puts both back as they were.
    await run('ditto', ['-x', '-k', file, unpacked])

    const incoming = join(unpacked, 'Neo.app')
    if (!existsSync(incoming)) throw new Error('That download did not contain Neo.app.')

    const plist = join(incoming, 'Contents', 'Info.plist')
    const identifier = await plistValue(plist, 'CFBundleIdentifier')
    if (identifier !== 'com.svartdal.neo') {
      throw new Error(`That download is not Neo (it identifies itself as ${identifier || 'nothing'}).`)
    }
    const shipped = await plistValue(plist, 'CFBundleShortVersionString')
    if (shipped !== version) {
      throw new Error(`That download says it is ${shipped || 'no version'}, not ${version}.`)
    }
    try {
      await run('codesign', ['--verify', '--deep', '--strict', incoming])
    } catch (error) {
      const detail = String((error as { stderr?: string }).stderr ?? error).trim()
      throw new Error(`macOS will not vouch for that download: ${detail}`)
    }

    const script = join(dir, 'swap.sh')
    await writeFile(
      script,
      macSwapScript({
        app: bundle,
        staged: incoming,
        backup: join(dir, 'previous.app'),
        pid: process.pid
      }),
      'utf8'
    )
    await chmod(script, 0o755)
    return () => detach('/bin/sh', [script])
  }

  if (process.platform === 'win32') {
    // The installer is the update. It is the same one a person would double-click,
    // run with the flags that make it silent and bring the app back afterwards.
    return () => detach(file, ['/S', '--force-run'])
  }

  const image = process.env.APPIMAGE ?? ''
  if (!image) throw new Error('Only the AppImage build can replace itself.')
  const script = join(dir, 'swap.sh')
  await writeFile(script, appImageSwapScript({ image, staged: file, pid: process.pid }), 'utf8')
  await chmod(script, 0o755)
  await chmod(file, 0o755)
  return () => detach('/bin/sh', [script])
}

/** One value out of an Info.plist, without parsing XML. `plutil` is on every Mac. */
async function plistValue(plist: string, key: string): Promise<string> {
  try {
    const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', plist])
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Start something that has to outlive this process.
 *
 * Detached, with its output thrown away and its handle released, so the swap script
 * is still running when the app it is replacing has gone. Anything less and the
 * script dies with its parent halfway through moving a bundle.
 */
function detach(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch (error) {
    console.error('Could not start the update:', error)
  }
}

/* ------------------------------------------------------------------------- applying */

/**
 * Apply what is staged, if anything is. Called on the way out and nowhere else — the
 * swap waits for this process to exit, so there is no moment at which it could take
 * the application away from somebody who is using it.
 */
export function applyStagedUpdate(): void {
  const pending = staged
  staged = null
  if (!pending) return
  console.log(`Applying Neo ${pending.version} on the way out.`)
  pending.install()
}

/** "Do it now." Quitting is what applies it; this is only the way to ask for that. */
export function restartForUpdate(): boolean {
  if (!staged) return false
  app.quit()
  return true
}

/** Where somebody is sent when this copy cannot update itself. */
export const releasesPage = (): string => RELEASES_PAGE

/* -------------------------------------------------------------------------- the loop */

export function setUpdatePreference(next: UpdatePreference): void {
  preference = next
  if (next === 'off') return
  // Newly switched on is a reason to look now rather than in six hours.
  if (status.phase === 'idle') void checkForUpdate()
}

export function startUpdates(next: UpdatePreference): void {
  preference = next
  if (timer) return
  const first = setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS)
  first.unref?.()
  timer = setInterval(() => void checkForUpdate(), CHECK_MS)
  // A pending check must never be the reason the process stays awake.
  timer.unref?.()
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
}
