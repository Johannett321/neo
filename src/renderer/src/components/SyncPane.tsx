import { useState } from 'react'
import { useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { DEFAULT_SYNC_SERVER, type SyncStatus } from '@shared/sync'

/**
 * Sync, and the only place it is offered.
 *
 * Deliberately not in onboarding. Asking somebody to price syncing before they have
 * made a workspace is asking them to value something they have not used, and it is
 * only safe to defer because the device is the source of truth: turning this on
 * attaches a transport to a log that was already being written, so there is nothing
 * to migrate and no decision to regret.
 *
 * Self-hosting is a plain link at the bottom rather than a third button. Quiet is
 * fine — three equal choices here is a decision nobody wants to make. Grey would not
 * be: grey reads as disabled, and the self-hosted server is the same server.
 */
export function SyncPane(): React.JSX.Element {
  const { data: status, refetch } = useApi('sync:status')
  const [server, setServer] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [problem, setProblem] = useState('')
  const [ownServer, setOwnServer] = useState(false)

  const signIn = useApiMutation('sync:signIn')
  const unlock = useApiMutation('sync:unlock')
  const syncNow = useApiMutation('sync:now')
  const disconnect = useApiMutation('sync:disconnect')

  if (!status) return <div className="text-sm opacity-60">Looking…</div>

  const connect = async (): Promise<void> => {
    setProblem('')
    try {
      const result = await signIn.mutateAsync({
        serverUrl: (ownServer ? server : DEFAULT_SYNC_SERVER).trim()
      })
      if (!result.connected) return
      await refetch()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const open = async (): Promise<void> => {
    setProblem('')
    // Asked twice on the first device only. Everywhere else the account already has
    // a passphrase, and typing it wrong says so rather than silently making a second.
    if (isFirstDevice && passphrase !== again) {
      setProblem('Those two do not match.')
      return
    }
    const result = await unlock.mutateAsync({ passphrase })
    if (!result.ok) {
      setProblem(result.reason)
      return
    }
    setPassphrase('')
    setAgain('')
    await refetch()
  }

  const isFirstDevice = status.workspaces.length > 0 && status.phase === 'locked'

  /* ---------------------------------------------------------------- off */

  if (status.phase === 'off') {
    return (
      <div className="flex flex-col gap-5 max-w-lg">
        <p className="text-sm opacity-75">
          Neo keeps everything on this Mac. Connecting it to a sync server keeps your
          other machines in step and gives your work an off-site backup that is
          encrypted before it leaves this app — the server holds bytes it cannot read.
        </p>

        {ownServer ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs opacity-60">Your server&rsquo;s address</span>
            <input
              className="input input-bordered input-sm"
              placeholder="https://sync.example.com"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              autoFocus
            />
          </label>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void connect()}
            disabled={signIn.isPending || (ownServer && !server.trim())}
          >
            {signIn.isPending ? 'Waiting for your passkey…' : 'Connect with a passkey'}
          </button>
        </div>

        {problem ? <p className="text-sm text-error">{problem}</p> : null}

        {ownServer ? null : (
          <button
            className="link link-hover text-sm self-start opacity-80"
            onClick={() => setOwnServer(true)}
          >
            Use your own server
          </button>
        )}
      </div>
    )
  }

  /* ------------------------------------------------------------- locked */

  if (status.phase === 'locked') {
    return (
      <div className="flex flex-col gap-4 max-w-lg">
        <p className="text-sm opacity-75">
          Signed in as <span className="font-medium opacity-100">{status.accountHandle}</span>.
          Your passphrase is what actually unlocks your work, and it never leaves this
          Mac — not even to the sync server.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs opacity-60">Passphrase</span>
          <input
            className="input input-bordered input-sm"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
          />
        </label>

        {isFirstDevice ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs opacity-60">And again</span>
            <input
              className="input input-bordered input-sm"
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </label>
        ) : null}

        <p className="text-xs opacity-55">
          Nobody can reset this. If it is lost, so is everything the server holds —
          which is the same sentence as &ldquo;the server cannot read it&rdquo;, said
          from the other side.
        </p>

        {problem ? <p className="text-sm text-error">{problem}</p> : null}

        <div className="flex gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void open()}
            disabled={unlock.isPending || passphrase.length === 0}
          >
            {unlock.isPending ? 'Unlocking…' : 'Unlock'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void disconnect.mutateAsync().then(() => refetch())}
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  /* ---------------------------------------------------------- connected */

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <Line status={status} />

      <div className="flex flex-col gap-1 text-sm">
        <Row label="Account" value={status.accountHandle} />
        <Row label="Server" value={status.serverUrl.replace(/^https?:\/\//, '')} />
        <Row
          label="Waiting to send"
          value={status.pending === 0 ? 'Nothing' : `${status.pending} change${status.pending === 1 ? '' : 's'}`}
        />
        <Row
          label="Last synced"
          value={status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleTimeString() : 'Not yet'}
        />
      </div>

      {status.workspaces.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs opacity-60">Workspaces</span>
          {status.workspaces.map((workspace) => (
            <div key={workspace.workspaceId} className="flex justify-between text-sm">
              <span>{workspace.name}</span>
              <span className="opacity-50 tabular-nums">{workspace.remoteSeq}</span>
            </div>
          ))}
        </div>
      ) : null}

      {status.error ? <p className="text-sm text-error">{status.error}</p> : null}

      <div className="flex gap-2">
        <button
          className="btn btn-sm"
          onClick={() => void syncNow.mutateAsync().then(() => refetch())}
          disabled={syncNow.isPending || status.phase === 'syncing'}
        >
          {status.phase === 'syncing' || syncNow.isPending ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void disconnect.mutateAsync().then(() => refetch())}
        >
          Disconnect this Mac
        </button>
      </div>

      <p className="text-xs opacity-55">
        Disconnecting stops syncing here and forgets the account on this Mac. Nothing
        on the server is deleted, and your other machines carry on.
      </p>
    </div>
  )
}

/** One sentence about what is happening, in the same register as an attention line. */
function Line({ status }: { status: SyncStatus }): React.JSX.Element {
  const [icon, words] =
    status.phase === 'error'
      ? (['alert', status.error || 'Something went wrong.'] as const)
      : status.phase === 'syncing'
        ? (['refresh', 'Syncing now.'] as const)
        : status.pending > 0
          ? (['clock', 'Some changes are still to go out.'] as const)
          : status.live
            ? (['check', 'Up to date, and listening for changes.'] as const)
            : (['check', 'Up to date.'] as const)

  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon name={icon} className={status.phase === 'error' ? 'text-error' : 'opacity-60'} />
      <span className={status.phase === 'error' ? 'text-error' : ''}>{words}</span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="opacity-60">{label}</span>
      <span>{value}</span>
    </div>
  )
}
