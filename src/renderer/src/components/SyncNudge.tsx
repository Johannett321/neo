import { useNavigate } from 'react-router-dom'
import { useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'

/**
 * The one time Neo mentions syncing, to somebody who has never been offered it.
 *
 * Deliberately not in onboarding, and deliberately not a dialog. Onboarding is where
 * somebody would be pricing a thing they have not used; a dialog is a thing to get
 * rid of. This is a line on the page you already land on, with the two answers next
 * to it, and either of them is the last time it is ever shown.
 *
 * It is only safe to leave the offer this late because the device is the source of
 * truth: turning sync on attaches a transport to a log that has been written all
 * along, so nothing is migrated and nothing was missed by waiting.
 */
export function SyncNudge(): React.JSX.Element | null {
  const navigate = useNavigate()
  const { data, refetch } = useApi('sync:nudge')
  const dismiss = useApiMutation('sync:dismissNudge')

  if (!data?.show) return null

  const answer = async (goToSettings: boolean): Promise<void> => {
    await dismiss.mutateAsync()
    await refetch()
    if (goToSettings) navigate('/settings?pane=sync')
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-base-300 px-4 py-3 text-sm">
      <Icon name="refresh" className="opacity-50 shrink-0" />
      <p className="flex-1 opacity-80">
        Neo can keep your Macs in step and hold an encrypted backup of your work.
        Everything is sealed on this machine first — the server cannot read any of it.
      </p>
      <button className="btn btn-sm btn-primary" onClick={() => void answer(true)}>
        Have a look
      </button>
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => void answer(false)}
        aria-label="Not now, and do not ask again"
      >
        Not now
      </button>
    </div>
  )
}
