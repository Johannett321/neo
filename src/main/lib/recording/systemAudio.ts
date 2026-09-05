import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/**
 * What the computer is playing — the other half of a video call.
 *
 * macOS will not let a renderer hear another application through any API Chromium
 * exposes: `getDisplayMedia` loopback is Windows-only, and no flag changes that. What
 * macOS *does* have, since 14.4, is Core Audio process taps — public, driver-free,
 * and reachable only from native code. So there is a small native helper, and this is
 * the thing that runs it.
 *
 * It is a child process rather than a native module on purpose. A module is compiled
 * against one Electron's headers and has to be rebuilt for the next; worse, a crash
 * inside it takes the app down mid-meeting. This can fail entirely — refused
 * permission, an old macOS, no helper in the bundle — and the recording carries on
 * with the microphone, which is most of a meeting rather than none of it.
 *
 * The audio goes to the renderer rather than to disk, because that is where the
 * microphone is and the two have to be mixed before either is encoded. Everything
 * downstream — segments, transcription, the recap — is then unchanged.
 */

let child: ChildProcessWithoutNullStreams | null = null
/** Every byte the helper has produced this run. Only the test below reads it. */
let captured = 0

export const isSystemAudioRunning = (): boolean => child !== null

/**
 * The helper this copy of the app would run.
 *
 * `app.isPackaged` is deliberately not asked. dev-branding renames the executable, so
 * a development run reports itself as packaged and would look in the wrong place —
 * the same trap the Claude connector documents. Which file exists is the question.
 */
export function helperPath(): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'native', 'neo-audiotap') : '',
    join(app.getAppPath(), 'out', 'native', 'neo-audiotap')
  ]
  return candidates.find((path) => path && existsSync(path)) ?? ''
}

/** Whether capturing the computer's own sound is possible at all on this machine. */
export function systemAudioAvailable(): boolean {
  return process.platform === 'darwin' && helperPath() !== ''
}

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export interface SystemAudioStart {
  ok: boolean
  /** The rate the tap runs at, which the renderer builds its audio graph around. */
  sampleRate: number
  /** Why not, in words a person can act on. Empty when it started. */
  reason: string
}

export function stopSystemAudio(): void {
  if (!child) return
  const stopping = child
  child = null
  // Closing stdin is how the helper is asked to stop: it hands the audio device back
  // to Core Audio before it goes. Killing it outright would leave a private aggregate
  // device behind, outliving the process that made it.
  try {
    stopping.stdin.end()
  } catch {
    /* Already gone. */
  }
  const kill = setTimeout(() => stopping.kill('SIGKILL'), 2000)
  kill.unref?.()
  stopping.once('exit', () => clearTimeout(kill))
}

/**
 * Starts the helper and resolves once it says it is listening — or once it says why
 * it is not. It never rejects: failing to capture the computer's sound is a thing the
 * recording is expected to survive, not an error to be thrown at somebody.
 */
export async function startSystemAudio(): Promise<SystemAudioStart> {
  stopSystemAudio()
  captured = 0

  if (process.platform !== 'darwin') {
    return { ok: false, sampleRate: 0, reason: 'Only macOS records the computer’s own sound this way.' }
  }
  const helper = helperPath()
  if (!helper) {
    return {
      ok: false,
      sampleRate: 0,
      reason: 'This build has no audio helper, so only the microphone can be recorded.'
    }
  }

  return new Promise<SystemAudioStart>((resolve) => {
    let settled = false
    const answer = (result: SystemAudioStart): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.ok) stopSystemAudio()
      resolve(result)
    }

    // A helper that never says anything is a helper that is stuck. Waiting forever
    // would hang the button that is waiting on this.
    const timer = setTimeout(
      () => answer({ ok: false, sampleRate: 0, reason: 'The audio helper did not start.' }),
      5000
    )
    timer.unref?.()

    let started: ChildProcessWithoutNullStreams
    try {
      started = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      answer({ ok: false, sampleRate: 0, reason: (error as Error).message })
      return
    }
    child = started

    // Audio on stdout, straight through to the window that is holding the microphone.
    started.stdout.on('data', (chunk: Buffer) => {
      if (child !== started) return
      captured += chunk.byteLength
      send('system-audio', chunk)
    })

    // One JSON object per line on stderr: ready, dropped, error. Kept apart from the
    // audio so neither has to be parsed out of the other.
    let pending = ''
    started.stderr.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line)
        } catch {
          console.warn('neo-audiotap:', line)
          continue
        }
        if (event.type === 'ready') {
          answer({ ok: true, sampleRate: Number(event.sampleRate) || 48_000, reason: '' })
        } else if (event.type === 'error') {
          answer({ ok: false, sampleRate: 0, reason: String(event.message ?? 'Unknown error.') })
        } else if (event.type === 'dropped') {
          console.warn(`neo-audiotap dropped ${String(event.bytes)} bytes; the window fell behind.`)
        }
      }
    })

    started.on('error', (error) => {
      answer({ ok: false, sampleRate: 0, reason: error.message })
    })

    started.on('exit', (code) => {
      if (child === started) {
        child = null
        // Only worth telling the window about once it was actually running: before
        // that, the promise above is what reports the failure.
        if (settled) send('system-audio-stopped', { code })
      }
      answer({
        ok: false,
        sampleRate: 0,
        reason: 'The audio helper stopped before it started listening.'
      })
    })
  })
}

/**
 * Does this actually work, on this machine, right now?
 *
 * Everything about capturing the computer's audio is decided by macOS at the moment
 * it is first asked, and there is no public API to ask beforehand — no way to request
 * the permission, and no way to read whether it was given. So the only honest answer
 * is to try it and see, which is what this does: open the tap, listen for a couple of
 * seconds, and report how many bytes came out.
 *
 * The byte count is the part that matters. A tap that opened but produced nothing is
 * the failure that would otherwise be discovered at the end of a meeting, and it is
 * indistinguishable from success at every level above this one.
 */
export async function testSystemAudio(): Promise<{
  ok: boolean
  reason: string
  bytes: number
  sampleRate: number
}> {
  if (isSystemAudioRunning()) {
    return { ok: false, reason: 'A recording is using it right now.', bytes: 0, sampleRate: 0 }
  }

  const started = await startSystemAudio()
  if (!started.ok) return { ok: false, reason: started.reason, bytes: 0, sampleRate: 0 }

  await new Promise((resolve) => setTimeout(resolve, 2500))
  const bytes = captured
  stopSystemAudio()

  return {
    ok: bytes > 0,
    bytes,
    sampleRate: started.sampleRate,
    reason: bytes > 0 ? '' : 'The tap opened but no sound came through it.'
  }
}
