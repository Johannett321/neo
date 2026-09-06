import { BrowserWindow } from 'electron'

/**
 * The passkey ceremony, in a window Neo owns but does not control the contents of.
 *
 * Neo's own window is loaded from `file://`, so a WebAuthn ceremony against the sync
 * server's domain is impossible there — the origin would not match the relying party
 * id, and no amount of configuration changes that. So the server serves a page, this
 * opens it at the right origin, and exactly one thing comes back: a device token.
 *
 * That is a deliberate line. A token is something the server issued itself, so
 * serving the code that obtains it gives nothing away. Key material never crosses
 * this boundary — the passphrase is typed in Neo's own window and the master key is
 * unwrapped in the main process, where a page the server wrote can never reach it.
 */

const CALLBACK = 'neo-sync-callback://'

export interface SignedIn {
  token: string
  accountId: string
  handle: string
}

export async function signInWithPasskey(serverUrl: string): Promise<SignedIn | null> {
  const base = serverUrl.replace(/\/+$/, '')

  const window = new BrowserWindow({
    width: 460,
    height: 620,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Connect Neo',
    webPreferences: {
      // Nothing of Neo's is reachable from this page. It gets a browser and no more.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'persist:neo-sync-signin'
    }
  })

  return new Promise<SignedIn | null>((resolve) => {
    let settled = false

    const finish = (result: SignedIn | null): void => {
      if (settled) return
      settled = true
      resolve(result)
      if (!window.isDestroyed()) window.close()
    }

    /*
     * The scheme never resolves — it is a signal rather than a destination, which is
     * why nothing is registered with the operating system and nothing lands in a
     * history somewhere. Both handlers are needed: a form post that redirects
     * arrives as a redirect, and a location assignment as a navigation.
     */
    const intercept = (event: Electron.Event, url: string): void => {
      if (!url.startsWith(CALLBACK)) return
      event.preventDefault()
      try {
        const parsed = new URL(url)
        const token = parsed.searchParams.get('token')
        const accountId = parsed.searchParams.get('accountId')
        const handle = parsed.searchParams.get('handle') ?? ''
        finish(token && accountId ? { token, accountId, handle } : null)
      } catch {
        finish(null)
      }
    }

    window.webContents.on('will-navigate', intercept)
    window.webContents.on('will-redirect', intercept)

    // Closing the window is a decision, not a failure: it resolves null and the
    // settings pane goes back to where it was rather than showing an error.
    window.on('closed', () => finish(null))

    void window.loadURL(`${base}/connect.html`).catch(() => finish(null))
  })
}
