import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SIGNED_OUT } from '@shared/account'
import { call, useApi, useApiMutation } from '@/lib/api'
import { formatBytes, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { Field, Panel } from '@/components/primitives'

/**
 * The account, as this machine is signed in to it.
 *
 * Four things and no more: who you are and what your plan includes, a password, the
 * machines that can reach the account, and signing this one out. Everybody is on the
 * free plan and it includes everything, so the plan is a line that says so rather than
 * a panel of switches that are all on.
 */
export function AccountPane(): React.JSX.Element {
  const client = useQueryClient()
  const { data: status } = useApi('account:status')
  const [leaving, setLeaving] = useState(false)

  if (!status) {
    return (
      <Panel>
        <p className="text-[12px] text-base-content/55">Looking…</p>
      </Panel>
    )
  }

  const signOut = async (): Promise<void> => {
    setLeaving(true)
    const signedOut = await call('account:signOut').catch(() => SIGNED_OUT)
    // What is cached is this account's; the next person to sign in must not see it.
    client.clear()
    client.setQueryData(['account:status', null], signedOut)
  }

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-base-200 text-base-content/60">
            <Icon name="people" size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium">{status.username}</div>
            <div className="text-[12px] text-base-content/50">
              {status.plan.name} plan · everything included
            </div>
          </div>
          <button className="btn btn-sm" disabled={leaving} onClick={() => void signOut()}>
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        <p className="mt-4 text-[12px] leading-relaxed text-base-content/55">
          Your work is kept in Neo Cloud and nowhere else, so it is on every machine you sign in to.
          Signing out leaves it exactly where it is.
          {status.storage.usedBytes > 0 && (
            <> Files and recordings are using {formatBytes(status.storage.usedBytes)}.</>
          )}
        </p>
      </Panel>

      <PasswordPanel hasPassword={status.hasPassword} />
      <DevicesPanel />
    </div>
  )
}

function PasswordPanel({ hasPassword }: { hasPassword: boolean }): React.JSX.Element {
  const change = useApiMutation('account:changePassword')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (): Promise<void> => {
    setMessage(null)
    if (next !== again) {
      setMessage({ ok: false, text: 'Those two passwords do not match.' })
      return
    }
    try {
      await change.mutateAsync({ currentPassword: hasPassword ? current : undefined, newPassword: next })
      setCurrent('')
      setNext('')
      setAgain('')
      setMessage({
        ok: true,
        text: hasPassword
          ? 'Changed. Every other machine has been signed out and will ask for the new one.'
          : 'Set. You can sign in with it as well as with your passkey.'
      })
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <Panel>
      <div className="mb-3 text-[13px] font-medium">{hasPassword ? 'Change your password' : 'Add a password'}</div>
      {!hasPassword && (
        <p className="mb-3 text-[12px] leading-relaxed text-base-content/55">
          This account signs in with a passkey. A password as well lets you sign in on a machine whose browser
          does not have it.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {hasPassword && (
          <Field label="Current password">
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
        )}
        <div className={`grid gap-3 sm:grid-cols-2 ${hasPassword ? 'mt-3' : ''}`}>
          <Field label="New password" hint="At least 10 characters.">
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Again">
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="submit" className="btn btn-sm" disabled={!next || change.isPending}>
            {hasPassword ? 'Change password' : 'Add password'}
          </button>
          {message && (
            <span className={`text-[12px] ${message.ok ? 'text-success' : 'text-error'}`}>{message.text}</span>
          )}
        </div>
      </form>
    </Panel>
  )
}

/** Every machine that has signed in, and the button for the one that is lost. */
function DevicesPanel(): React.JSX.Element {
  const devices = useApi('account:devices')
  const revoke = useApiMutation('account:revokeDevice')
  const live = (devices.data ?? []).filter((device) => !device.revoked)

  return (
    <Panel>
      <div className="mb-3 text-[13px] font-medium">Signed in on</div>
      {live.length === 0 && <p className="text-[12px] text-base-content/50">Looking…</p>}
      <div className="divide-y divide-base-content/5">
        {live.map((device) => (
          <div key={device.deviceId} className="flex items-center gap-3 py-2">
            <Icon name="monitor" size={14} className="text-base-content/45" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">
                {device.name || 'A device'}
                {device.thisOne && <span className="ml-2 text-[11px] text-base-content/45">this one</span>}
              </div>
              <div className="text-[11.5px] text-base-content/45">Last seen {relativeFromIso(device.lastSeenAt)}</div>
            </div>
            {!device.thisOne && (
              <button
                className="btn btn-ghost btn-xs text-base-content/60"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate({ deviceId: device.deviceId })}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
    </Panel>
  )
}
