import { Notification } from 'electron'
import { api, must } from '../lib/cloud/client'
import { showNotification } from '../lib/notifier'
import { handle } from './util'

export function registerNotificationHandlers(): void {
  /**
   * What this workspace would say this morning. Derived by Neo Cloud from the deadlines
   * and due dates on every call, and stored nowhere; the delivery loop in
   * `lib/notifier.ts` decides what is actually said, by claiming it first.
   */
  handle('notification:pending', ({ workspaceId }) =>
    must(api.GET('/v1/notifications/pending', { params: { query: { workspaceId } } })))

  /**
   * One, now, on purpose — and on macOS this is also what makes the operating system
   * ask whether Neo may show them, because there is no way to raise that question
   * except by trying. It claims nothing: a test is not a delivery.
   */
  handle('notification:test', () =>
    showNotification({
      title: 'Neo can reach you here',
      body: 'This is what a deadline will look like.',
      target: null
    })
  )

  /** What this desktop can do, asked before anything is shown on it. */
  handle('notification:capability', () => ({
    supported: Notification.isSupported(),
    /*
     * Only macOS puts a question in front of an application before it may show a
     * notification, so only there does the first-run flow have a panel asking.
     */
    gated: process.platform === 'darwin'
  }))
}
