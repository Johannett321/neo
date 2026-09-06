import { contextBridge, ipcRenderer } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import type { AiEvent, OpenTarget, RecordingEvent } from '@shared/types'
import type { UpdateStatus } from '@shared/update'

/**
 * The only surface the renderer gets. The database connection, the filesystem and
 * the shell all stay in the main process; this passes typed messages and nothing else.
 */
const api = {
  invoke<C extends Channel>(channel: C, input?: Input<C>): Promise<Output<C>> {
    return ipcRenderer.invoke(channel, input)
  },
  /** Menu commands from the application menu. Returns an unsubscribe function. */
  onMenu(callback: (command: string) => void): () => void {
    const listener = (_event: unknown, command: string): void => callback(command)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.off('menu', listener)
    }
  },
  /**
   * The assistant talking while it works: text as it is written, tools as they run,
   * and the confirmations it stops to ask for. Returns an unsubscribe function.
   */
  onAi(callback: (event: AiEvent) => void): () => void {
    const listener = (_event: unknown, payload: AiEvent): void => callback(payload)
    ipcRenderer.on('ai', listener)
    return () => {
      ipcRenderer.off('ai', listener)
    }
  },
  /**
   * A write that did not come from this window: the assistant's tools, or Claude
   * Desktop through the bridge. Both go down the same channels a click does, but from
   * inside the main process, so there is no mutation here to invalidate anything —
   * this is how the screen finds out. Returns an unsubscribe function.
   */
  onData(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('data', listener)
    return () => {
      ipcRenderer.off('data', listener)
    }
  },
  /**
   * "Show them this." Sent when a desktop notification is clicked, and the only
   * message in the app that can name a workspace other than the one on screen — a
   * notification about the day job can arrive while you are looking at a client's
   * area, so the workspace travels with the path and is switched to first.
   */
  onOpen(callback: (target: OpenTarget) => void): () => void {
    const listener = (_event: unknown, payload: OpenTarget): void => callback(payload)
    ipcRenderer.on('open', listener)
    return () => {
      ipcRenderer.off('open', listener)
    }
  },
  /**
   * A recording moving through the pipeline. It runs whether or not anything is on
   * screen, so the screen is told when something changed rather than polling for it.
   */
  onRecording(callback: (event: RecordingEvent) => void): () => void {
    const listener = (_event: unknown, payload: RecordingEvent): void => callback(payload)
    ipcRenderer.on('recording', listener)
    return () => {
      ipcRenderer.off('recording', listener)
    }
  },
  /**
   * The app replacing itself: a release found, a download getting closer, something
   * parked and waiting for the next quit. It runs on a timer whether or not anybody
   * is looking at the settings pane, so the screen is told rather than polling.
   */
  onUpdate(callback: (status: UpdateStatus) => void): () => void {
    const listener = (_event: unknown, payload: UpdateStatus): void => callback(payload)
    ipcRenderer.on('update', listener)
    return () => {
      ipcRenderer.off('update', listener)
    }
  },
  /**
   * The machine going to sleep and coming back. The renderer holds the microphone,
   * and a microphone does not survive a suspend — this is how it finds out at once
   * rather than a few seconds later when its own watchdog notices.
   */
  onPower(callback: (event: 'suspend' | 'resume') => void): () => void {
    const listener = (_event: unknown, payload: 'suspend' | 'resume'): void => callback(payload)
    ipcRenderer.on('power', listener)
    return () => {
      ipcRenderer.off('power', listener)
    }
  },
  /**
   * The computer's own sound, as raw 16-bit mono PCM, straight from the native
   * helper. It comes here rather than going to disk because the microphone is here,
   * and the two have to be mixed before either is encoded.
   */
  onSystemAudio(callback: (chunk: Uint8Array) => void): () => void {
    const listener = (_event: unknown, payload: Uint8Array): void => callback(payload)
    ipcRenderer.on('system-audio', listener)
    return () => {
      ipcRenderer.off('system-audio', listener)
    }
  },
  /** The helper stopped on its own — a device change, a crash. Mic-only from here. */
  onSystemAudioStopped(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('system-audio-stopped', listener)
    return () => {
      ipcRenderer.off('system-audio-stopped', listener)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
