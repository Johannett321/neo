/**
 * Builds `neo-audiotap`, the one piece of this application that is not JavaScript.
 *
 * It exists because macOS will not let an Electron renderer hear what another
 * application is playing — Chromium's loopback capture is Windows-only — while macOS
 * itself has had a public, driver-free way to do it since 14.4: Core Audio process
 * taps. Reaching those needs native code, so there is a little native code, kept to
 * one file and one job.
 *
 * A separate executable rather than a Node addon, and that is the important choice: an
 * addon is compiled against one Electron's headers and breaks on the next, and a crash
 * inside it takes the whole app with it. This is spawned, watched, and allowed to die
 * without the recording stopping.
 *
 * The build is best-effort by design. No Swift toolchain, or not a Mac, and the app
 * builds anyway without it — every path that uses the helper already has to cope with
 * it being missing, because a user can refuse the permission it needs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), 'out', 'native')
const OUT = join(OUT_DIR, 'neo-audiotap')
const SOURCE = join(process.cwd(), 'native', 'audiotap', 'main.swift')

/** Core Audio process taps arrived in macOS 14.4; below that there is nothing to call. */
const DEPLOYMENT_TARGET = '14.4'

const skip = (why) => {
  console.log(`Skipping neo-audiotap: ${why}.`)
  console.log('Recordings will capture the microphone only, unless a virtual audio device is set up.')
  process.exit(0)
}

if (process.platform !== 'darwin') skip('this is not macOS')
if (!existsSync(SOURCE)) skip('no source to build')

// This also runs on every `npm run dev`, and two architectures of Swift take a couple
// of seconds. Nothing has changed most of the time, so nothing is done most of the time.
if (existsSync(OUT) && statSync(OUT).mtimeMs > statSync(SOURCE).mtimeMs) {
  console.log('neo-audiotap is up to date.')
  process.exit(0)
}

try {
  execFileSync('swiftc', ['--version'], { stdio: 'ignore' })
} catch {
  skip('no Swift compiler (install the Xcode command line tools)')
}

mkdirSync(OUT_DIR, { recursive: true })

const compile = (arch, output) =>
  execFileSync(
    'swiftc',
    [
      '-swift-version', '5',
      '-O',
      '-target', `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
      '-framework', 'AudioToolbox',
      '-framework', 'CoreAudio',
      '-o', output,
      SOURCE
    ],
    { stdio: 'pipe' }
  )

/*
 * Both architectures, joined with lipo. A packaged build is downloaded by whoever
 * downloads it, and an Intel Mac that got an arm64-only helper would silently record
 * half of every meeting — which is exactly the failure this whole thing exists to
 * prevent. If the second slice cannot be built, one is still better than none.
 */
const slices = []
for (const arch of ['arm64', 'x86_64']) {
  const slice = `${OUT}.${arch}`
  try {
    compile(arch, slice)
    slices.push(slice)
  } catch (error) {
    console.warn(`Could not build neo-audiotap for ${arch}:`, String(error.stderr ?? error).trim())
  }
}

if (slices.length === 0) skip('the Swift build failed')

if (slices.length === 1) {
  execFileSync('mv', [slices[0], OUT])
} else {
  execFileSync('lipo', ['-create', '-output', OUT, ...slices])
  for (const slice of slices) rmSync(slice, { force: true })
}

execFileSync('chmod', ['+x', OUT])
const kinds = execFileSync('lipo', ['-archs', OUT]).toString().trim()
console.log(`Built out/native/neo-audiotap (${kinds}) for macOS ${DEPLOYMENT_TARGET}+.`)
