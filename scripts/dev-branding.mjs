#!/usr/bin/env node
/**
 * In development the app runs inside node_modules' Electron.app, and macOS takes the
 * menu-bar title, the dock tooltip and the icon from that bundle — not from
 * `app.setName()`. Three things have to change, and the executable is the one most
 * people miss: the dock names a running app after its binary.
 *
 * Packaged builds are unaffected; this only rebrands the development bundle, and it
 * re-runs after every npm install.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'node_modules/electron/dist')
const PATH_FILE = join(ROOT, 'node_modules/electron/path.txt')
const NAME = 'Neo'

// The dock's tooltip comes from the bundle's own filename, which is why renaming the
// executable and every plist key still left it saying "Electron". The .app itself has
// to be renamed as well.
const ORIGINAL_APP = join(DIST, 'Electron.app')
const APP = join(DIST, `${NAME}.app`)
if (existsSync(ORIGINAL_APP) && !existsSync(APP)) {
  try {
    renameSync(ORIGINAL_APP, APP)
  } catch (error) {
    console.warn('Could not rename the development bundle:', error.message)
  }
}

const PLIST = join(APP, 'Contents/Info.plist')
if (process.platform !== 'darwin' || !existsSync(PLIST)) process.exit(0)

const plistBuddy = (command) => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, PLIST], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
const setKey = (key, value) => {
  if (!plistBuddy(`Set :${key} ${value}`)) plistBuddy(`Add :${key} string ${value}`)
}

setKey('CFBundleName', NAME)
setKey('CFBundleDisplayName', NAME)
// LaunchServices caches a display name against the bundle identifier, so leaving
// Electron's own id in place means the dock keeps calling this "Electron" however
// the other keys are set.
setKey('CFBundleIdentifier', 'com.svartdal.neo.dev')

// macOS terminates an application that asks for the microphone without declaring why
// — and in development the bundle asking is Electron's own, which declares nothing.
// Without this, pressing record in `npm run dev` kills the app outright. The packaged
// build gets the same key from electron-builder.yml.
setKey(
  'NSMicrophoneUsageDescription',
  "'Neo records the meetings you ask it to, so it can write out what was said.'"
)
// And the same for the computer's own audio, which Core Audio process taps need.
// Without it, opening a tap in `npm run dev` is refused before it starts.
setKey(
  'NSAudioCaptureUsageDescription',
  "'Neo records what your computer is playing, so a recorded meeting captures the whole call.'"
)

// The dock labels a running app after its executable, so rename that too — and keep
// path.txt in step, or the electron launcher will not find the binary.
const oldBinary = join(APP, 'Contents/MacOS/Electron')
const newBinary = join(APP, 'Contents/MacOS', NAME)
if (existsSync(oldBinary) && !existsSync(newBinary)) {
  try {
    renameSync(oldBinary, newBinary)
  } catch (error) {
    console.warn('Could not rename the development binary, leaving it alone:', error.message)
  }
}
if (existsSync(newBinary)) setKey('CFBundleExecutable', NAME)

// Whatever the bundle and binary ended up called, the launcher has to agree.
const binaryName = existsSync(newBinary) ? NAME : 'Electron'
writeFileSync(PATH_FILE, `${NAME}.app/Contents/MacOS/${binaryName}`)

const icon = join(ROOT, 'build/icon.icns')
if (existsSync(icon)) copyFileSync(icon, join(APP, 'Contents/Resources/electron.icns'))

/*
 * Everything above invalidates the signature the bundle arrived with, and that has
 * consequences well beyond Gatekeeper.
 *
 * Electron ships its own linker-signed ad-hoc signature, which reports
 * `Identifier=Electron` and `Info.plist=not bound`. Rewriting the plist and renaming
 * the binary leaves that signature describing a bundle that no longer exists —
 * `codesign --verify` fails outright — and macOS then refuses everything it gates on
 * a signed bundle. **Notifications are refused with `UNErrorDomain error 1` before
 * any prompt is shown**, which from the outside is indistinguishable from the feature
 * not being implemented, and the privacy usage strings set above are never read
 * either, so recording asks for nothing and is refused.
 *
 * Re-signing ad-hoc with the app's own identifier binds the plist and seals the
 * resources, and all of it starts working. This is `scripts/sign-adhoc.mjs` doing the
 * same job for a packaged build, and it is here for the same reason.
 *
 * The signature is content-derived, so re-signing unchanged bytes produces the same
 * hash and whatever macOS remembered is still remembered. Installing a new Electron
 * changes the bytes and the permissions are asked for again — the price of having no
 * Developer ID, and a much smaller one than never being asked.
 */
// `codesign -dv` writes its report to **stderr** and still exits zero, so this reads
// both streams rather than the return value — which is empty, and which is how a
// check like this comes to re-sign on every run while claiming to have skipped.
const inspected = spawnSync('codesign', ['-dv', APP], { encoding: 'utf8' })
const signedAs = `${inspected.stdout ?? ''}${inspected.stderr ?? ''}`
const alreadyOurs =
  signedAs.includes('Identifier=com.svartdal.neo.dev') && signedAs.includes('Info.plist entries=')
if (!alreadyOurs) {
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--identifier', 'com.svartdal.neo.dev', APP],
      { stdio: 'pipe' }
    )
    console.log('Development bundle re-signed, so macOS will show its notifications and prompts.')
  } catch (error) {
    console.warn(
      'Could not re-sign the development bundle; macOS will refuse notifications and the ' +
        'microphone in `npm run dev`:',
      String(error.stderr ?? error).trim()
    )
  }
}

// macOS caches bundle metadata; without re-registering, the old name and icon persist.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
try {
  // Drop the stale entry before adding the new one, or the old name survives.
  execFileSync(lsregister, ['-u', APP], { stdio: 'pipe' })
  execFileSync(lsregister, ['-f', APP], { stdio: 'pipe' })
} catch {
  // Not fatal: the rename still applies on next launch.
}
const now = new Date()
utimesSync(APP, now, now)

console.log(`Development bundle branded as ${NAME}.`)
