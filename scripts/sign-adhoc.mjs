import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Signs the bundle with an ad-hoc signature when there is no real one to use.
 *
 * This is not about Gatekeeper — an ad-hoc signature satisfies nobody there. It is
 * about the Info.plist.
 *
 * macOS decides whether to *ask* for a privacy permission by reading the usage
 * description out of the bundle, and it only trusts that string if the Info.plist is
 * covered by the signature. A build with signing skipped keeps Electron's own
 * linker-signed adhoc signature, which reports `Identifier=Electron` and
 * `Info.plist=not bound` — so `NSAudioCaptureUsageDescription` is never read, and the
 * request to record the computer's audio is refused without a prompt ever appearing.
 * Which looks, from the outside, exactly like the feature not working.
 *
 * Re-signing with the app's own identifier binds the plist and gets the prompt back.
 * The permission is remembered against the signature, so it is asked for again after
 * a rebuild; that is the price of not having a Developer ID, and it is a far smaller
 * price than the question never being asked at all.
 *
 * A real identity, when there is one, signs afterwards and replaces this.
 */
export default async function signAdHoc(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(app)) return

  const identifier = context.packager.appInfo.id
  const sign = (target, id) =>
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', id, target], {
      stdio: 'pipe'
    })

  try {
    // Nested code first: a bundle is signed from the inside out, and the audio helper
    // is a Mach-O of its own that the app's own signature has to cover.
    const helper = join(app, 'Contents/Resources/native/neo-audiotap')
    if (existsSync(helper)) sign(helper, `${identifier}.audiotap`)

    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', identifier, app], {
      stdio: 'pipe'
    })
    console.log(`  • ad-hoc signed as ${identifier} so macOS reads its privacy usage strings`)
  } catch (error) {
    console.warn('  • could not ad-hoc sign; the audio permission prompt may not appear')
    console.warn(String(error.stderr ?? error).trim())
  }
}
