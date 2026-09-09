import type { RowChange } from '@shared/tables'
import type { SyncBilling } from '@shared/sync'

/**
 * The sync server, as this process sees it.
 *
 * Rows go up and rows come down, in the shape the tables already have. Nothing is
 * transformed on the way through and nothing is sealed: this is a plain JSON API, and
 * the whole of it can be read off the wire — which is most of the reason for the
 * change that produced it.
 */

/** One row as the server hands it back, with the cursor it arrived at. */
export interface RemoteChange {
  rev: number
  table: string
  /** The row's columns, exactly as the server stores them. */
  row: Record<string, unknown>
}

/**
 * A server that cannot be reached, as opposed to one that refused.
 *
 * `fetch` reports every network failure as a `TypeError` with a message that varies
 * by platform, so there is nothing better to key on than "it never got an answer".
 * Keeping this apart from a real error is most of what makes the offline badge
 * honest: a laptop on a train has nothing wrong with it.
 */
export function isOffline(error: unknown): boolean {
  if (error instanceof RelayError) return false
  return error instanceof TypeError || (error as { name?: string })?.name === 'AbortError'
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
    workspaces: { workspaceId: string; head: number }[]
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

  /* ---------------------------------------------------------------- files */

  blobUpload(
    workspaceId: string, key: string, sizeBytes: number, contentType: string
  ): Promise<{ uploadUrl: string }> {
    return this.call(`/v1/workspaces/${workspaceId}/blobs/${key}/upload`, {
      method: 'POST',
      body: JSON.stringify({ sizeBytes, contentType })
    })
  }

  blobDownload(workspaceId: string, key: string): Promise<{ downloadUrl: string }> {
    return this.call(`/v1/workspaces/${workspaceId}/blobs/${key}/download`)
  }

  /**
   * Straight to object storage, never through the sync server.
   *
   * An hour of meeting audio proxied through that process would tie up a connection
   * for minutes for nothing: the bytes are the same bytes either way, and a presigned
   * URL is what object storage is for.
   */
  async putBytes(url: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
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

  /** Hand over what this device has changed. One request, one transaction there. */
  push(workspaceId: string, changes: RowChange[]): Promise<{ applied: number; head: number }> {
    return this.call(`/v1/workspaces/${workspaceId}/rows`, {
      method: 'POST',
      body: JSON.stringify({ changes })
    })
  }

  /**
   * Ask what has moved since this device's cursor.
   *
   * One ordered stream across every table rather than a page per table, which is what
   * makes deletes work: a device applies a project's delete and its own foreign keys
   * take the tasks with it, and that is only correct if the delete cannot arrive
   * before the rows it supersedes.
   */
  pull(workspaceId: string, since: number, limit = 500): Promise<{
    changes: RemoteChange[]
    head: number
    more: boolean
  }> {
    return this.call(`/v1/workspaces/${workspaceId}/rows?since=${since}&limit=${limit}`)
  }

  /**
   * The live stream: one connection for this device, for as long as the app is open.
   *
   * An event names a workspace and how far it has moved — never a row. A client that
   * hears one reads from its own cursor, so the live path and the catch-up path are
   * the same code and a dropped connection is only a slower one.
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
  ): AsyncGenerator<{ workspaceId: string; rev: number }> {
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
              rev?: number
            }
            if (parsed.workspaceId && typeof parsed.rev === 'number') {
              yield { workspaceId: parsed.workspaceId, rev: parsed.rev }
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
