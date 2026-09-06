import type { Batch } from '@shared/ops'
import type { SyncBilling } from '@shared/sync'

/**
 * The sync server, as this process sees it.
 *
 * Everything that crosses this boundary is either already sealed or is something the
 * server issued itself. Nothing here has a key.
 */

export interface RemoteBatch {
  seq: number
  batchId: string
  deviceId: string | null
  /** Sealed. Opened by the engine, never here. */
  ciphertext: string
}

export class RelayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RelayError'
  }

  /** A token that has been revoked, or an account that no longer exists. */
  get needsSignIn(): boolean {
    return this.status === 401
  }
}

export class Relay {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {})
      }
    })

    if (!response.ok) {
      // The server answers {"error": "a sentence"} for everything it refuses, and
      // those sentences are written to be shown. Anything else is reported by status
      // rather than by guessing at a body that may be a proxy's HTML error page.
      let message = `The server answered ${response.status}.`
      try {
        const body = (await response.json()) as { error?: string }
        if (body?.error) message = body.error
      } catch {
        // Not JSON. The status is the whole of what is known.
      }
      throw new RelayError(response.status, message)
    }
    return (await response.json()) as T
  }

  account(): Promise<{
    accountId: string
    handle: string
    quotaBytes: number
    usedBytes: number
    billing?: Partial<SyncBilling>
    workspaces: { workspaceId: string; head: number; batches: number }[]
  }> {
    return this.call('/v1/account')
  }

  /* --------------------------------------------------------------- money */

  /**
   * The prices, which are the one thing here the server has to ask Stripe for. Kept
   * off `/v1/account` for that reason: this is read when somebody opens the settings
   * pane, and that is a moment where waiting is allowed.
   */
  billing(): Promise<Partial<SyncBilling>> {
    return this.call('/v1/billing')
  }

  /** A link, opened in the real browser. No card details ever come near this app. */
  checkout(interval: 'monthly' | 'yearly'): Promise<{ url: string }> {
    return this.call('/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ interval })
    })
  }

  portal(): Promise<{ url: string }> {
    return this.call('/v1/billing/portal', { method: 'POST' })
  }

  keyMaterial(): Promise<{ keyMaterial: Record<string, string> }> {
    return this.call('/v1/account/keys')
  }

  putKeyMaterial(wrappedBy: string, ciphertext: string): Promise<{ stored: boolean }> {
    return this.call('/v1/account/keys', {
      method: 'PUT',
      body: JSON.stringify({ wrappedBy, ciphertext })
    })
  }

  /* ---------------------------------------------------------------- files */

  blobUpload(workspaceId: string, key: string, sizeBytes: number): Promise<{
    uploadUrl: string
  }> {
    return this.call(`/v1/workspaces/${workspaceId}/blobs/${key}/upload`, {
      method: 'POST',
      // Always the same type: what goes up is ciphertext, and saying more than that
      // would tell the bucket what kind of file it is holding.
      body: JSON.stringify({ sizeBytes, contentType: 'application/octet-stream' })
    })
  }

  blobDownload(workspaceId: string, key: string): Promise<{ downloadUrl: string }> {
    return this.call(`/v1/workspaces/${workspaceId}/blobs/${key}/download`)
  }

  /**
   * Straight to object storage, never through the sync server.
   *
   * An hour of meeting audio proxied through that process would tie up a connection
   * for minutes and put the one thing it is not allowed to read into its heap.
   */
  async putBytes(url: string, bytes: Buffer): Promise<void> {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes)
    })
    if (!response.ok) {
      throw new RelayError(response.status, `The file could not be uploaded (${response.status}).`)
    }
  }

  async getBytes(url: string): Promise<Buffer> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new RelayError(response.status, `The file could not be fetched (${response.status}).`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  push(workspaceId: string, batchId: string, ciphertext: string): Promise<{ seq: number }> {
    return this.call(`/v1/workspaces/${workspaceId}/ops`, {
      method: 'POST',
      body: JSON.stringify({ batchId, ciphertext })
    })
  }

  pull(workspaceId: string, since: number, limit = 200): Promise<{
    batches: RemoteBatch[]
    head: number
  }> {
    return this.call(`/v1/workspaces/${workspaceId}/ops?since=${since}&limit=${limit}`)
  }

  /**
   * The live stream: one connection for this device, for as long as the app is open.
   *
   * An event names a workspace and how far it has moved — never a batch. A client
   * that hears one reads from its own cursor, so the live path and the catch-up path
   * are the same code and a dropped connection is only a slower one.
   *
   * One connection rather than one per workspace, and that is not only tidiness: a
   * workspace made on the *other* Mac cannot be subscribed to before it is known
   * about, so per-workspace streams left exactly the case that matters most — a new
   * workspace — waiting on the minute poll.
   */
  async *stream(
    signal: AbortSignal,
    /** Called once the connection is actually up, which is not when the first event
     *  arrives — that may be hours away, and the status line should not say the
     *  stream is down for all of them. */
    onOpen: () => void = () => {}
  ): AsyncGenerator<{ workspaceId: string; seq: number }> {
    const response = await fetch(this.url('/v1/stream'), {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      signal
    })
    if (!response.ok || !response.body) {
      throw new RelayError(response.status, 'The live stream could not be opened.')
    }
    onOpen()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line; a comment line is the keep-alive.
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const event = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const data = event.split('\n').find((line) => line.startsWith('data:'))
        if (data) {
          try {
            const parsed = JSON.parse(data.slice(5).trim()) as {
              workspaceId?: string
              seq?: number
            }
            if (parsed.workspaceId && typeof parsed.seq === 'number') {
              yield { workspaceId: parsed.workspaceId, seq: parsed.seq }
            }
          } catch {
            // A malformed event is not worth ending a connection over: the next
            // poll reads from the cursor and catches up regardless.
          }
        }
        cut = buffer.indexOf('\n\n')
      }
    }
  }
}

/** The wire shape of a batch, before it is sealed. */
export const batchToWire = (batch: Batch): string => JSON.stringify(batch)

export function wireToBatch(json: string): Batch {
  const parsed = JSON.parse(json) as Batch
  if (!parsed || !Array.isArray(parsed.ops) || typeof parsed.id !== 'string') {
    throw new Error('That is not a batch.')
  }
  return parsed
}
