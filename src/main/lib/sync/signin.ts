import { shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * The passkey ceremony, in the user's own browser.
 *
 * Two things rule out doing this inside Neo, and the second is the one that matters.
 *
 * Neo's own window is loaded from `file://`, so a ceremony against the sync server's
 * domain is impossible there — the origin will not match the relying party id. That
 * much a `BrowserWindow` pointed at the server would fix, and Electron 44 can even
 * service the request once `app.configureWebAuthn()` has been called.
 *
 * But it would service it with **Touch ID credentials bound to this Mac's Secure
 * Enclave, which iCloud Keychain does not sync**. A passkey created that way exists
 * on the machine that made it and nowhere else — so the second Mac could never sign
 * in, which is the whole reason any of this is being built. (It also needs an Apple
 * entitlement, which an ad-hoc signature cannot carry.)
 *
 * Safari and Chrome store passkeys in iCloud Keychain, where they belong to the
 * person rather than to the laptop. So the ceremony happens there, and the token
 * comes back to a server this process opens on the loopback interface for as long as
 * it takes — the arrangement RFC 8252 recommends for exactly this, and the one
 * `gh auth login` uses.
 *
 * A token is all that crosses back. Key material never does: the passphrase is typed
 * in Neo's own window and the master key is unwrapped in this process, where a page
 * the server wrote can never reach it.
 */

export interface SignedIn {
  token: string
  accountId: string
  handle: string
}

/** Long enough to find your phone and answer a prompt; short enough to give up. */
const PATIENCE_MS = 3 * 60_000

const DONE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Connected</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
         background:#fff; color:#23262e; }
  @media (prefers-color-scheme: dark) { body { background:#17191f; color:#e7e8ec } }
  p { opacity:.7 }
</style>
<main style="text-align:center">
  <h1 style="font-size:19px;margin:0 0 6px">Neo is connected</h1>
  <p>You can close this tab and go back to the app.</p>
</main>`

export async function signInWithPasskey(serverUrl: string): Promise<SignedIn | null> {
  const base = serverUrl.replace(/\/+$/, '')
  const state = randomBytes(24).toString('base64url')

  return new Promise<SignedIn | null>((resolve) => {
    let settled = false

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }

      /*
       * The nonce is what stops anything else on this machine posting a token of its
       * own choosing to a port it found open. Compared in constant time because it is
       * compared against a secret.
       */
      const given = Buffer.from(url.searchParams.get('state') ?? '')
      const wanted = Buffer.from(state)
      const matches = given.length === wanted.length && timingSafeEqual(given, wanted)

      const token = url.searchParams.get('token')
      const accountId = url.searchParams.get('accountId')

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
      finish(matches && token && accountId
        ? { token, accountId, handle: url.searchParams.get('handle') ?? '' }
        : null)
    })

    const finish = (result: SignedIn | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), PATIENCE_MS)

    server.on('error', () => finish(null))

    // 127.0.0.1 rather than 0.0.0.0, and a port the operating system picks. Nothing
    // off this machine can reach it, and nothing has to be reserved in advance.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const target = new URL(`${base}/connect.html`)
      target.searchParams.set('redirect', `http://127.0.0.1:${port}/callback`)
      target.searchParams.set('state', state)
      void shell.openExternal(target.toString()).catch(() => finish(null))
    })
  })
}
