import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

/**
 * What to put in the name field before you have typed anything. A filled field is a
 * thing to correct rather than compose, and the machine already knows this: on macOS
 * `id -F` is the full name out of the directory service. Everything about it is
 * allowed to fail — the account name, and then an empty field, are both fine.
 *
 * The profile itself lives in Neo Cloud; this is the one part of it only the machine
 * can answer.
 */
export async function suggestedName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('id', ['-F'], { timeout: 800 })
      const full = stdout.trim()
      if (full) return full
    } catch {
      /* No directory service, or it took too long. The account name will do. */
    }
  }
  try {
    const { username } = userInfo()
    return username ? username.charAt(0).toUpperCase() + username.slice(1) : ''
  } catch {
    return ''
  }
}
