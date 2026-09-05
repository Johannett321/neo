import { contextBridge, ipcRenderer } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import type { AiEvent } from '@shared/types'

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
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
