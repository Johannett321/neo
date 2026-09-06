import { useState } from 'react'
import { useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { DEFAULT_SYNC_SERVER, type SyncBilling, type SyncStatus } from '@shared/sync'

/**
 * Sync, and the only place it is offered.
 *
 * Deliberately not in onboarding. Asking somebody to price syncing before they have
 * made a workspace is asking them to value something they have not used, and it is
 * only safe to defer because the device is the source of truth: turning this on
 * attaches a transport to a log that was already being written, so there is nothing
 * to migrate and no decision to regret.
 *
 * The pane has three states and each one asks exactly one question. Nothing off — one
 * button. Signed in but locked — the passphrase, and whether this machine is choosing
 * it or typing one that exists is answered by the *server*, not guessed from whether
 * this Mac happens to have workspaces on it. Connected — what is happening, what it
 * costs, and how to add the second Mac, which is the thing somebody who has just
 * turned this on is about to want and used to have to work out.
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
    if (status.firstDevice && passphrase !== again) {
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

  /* ---------------------------------------------------------------- off */

  if (status.phase === 'off') {
    return (
      <div className="flex flex-col gap-5 max-w-lg">
        <p className="text-sm opacity-75">
          Neo keeps everything on this Mac. Connecting it to a sync server keeps your
          other machines in step and gives your work an off-site backup that is
          encrypted before it leaves this app — the server holds bytes it cannot read.
        </p>

        {/*
          What is about to happen, before it happens. Pressing the button opens the
          browser, which is a surprise worth spending three lines to avoid: somebody
          who does not expect it reads a new tab as having been sent somewhere.
        */}
        <ol className="flex flex-col gap-2 text-sm opacity-75">
          <Step n={1}>Your browser opens, and you sign in with a passkey — Touch ID,
            or your phone. There is no password to choose.</Step>
          <Step n={2}>Back here, you pick a passphrase. That is what encrypts your
            work, and it never reaches the server.</Step>
          <Step n={3}>Everything already on this Mac goes up, encrypted, and stays in
            step from then on.</Step>
        </ol>

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
          {signIn.isPending ? (
            <span className="text-xs opacity-55">Finish in the browser, then come back.</span>
          ) : null}
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
          {status.firstDevice
            ? ' Now choose a passphrase. It encrypts everything before it leaves this Mac, and it never reaches the sync server.'
            : ' Type the passphrase you chose when you set this account up. It never reaches the sync server, which is why it has to be typed on each machine.'}
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs opacity-60">
            {status.firstDevice ? 'Choose a passphrase' : 'Passphrase'}
          </span>
          <input
            className="input input-bordered input-sm"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
          />
        </label>

        {status.firstDevice ? (
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
          {status.firstDevice
            ? 'Nobody can reset this. If it is lost, so is everything the server holds — which is the same sentence as “the server cannot read it”, said from the other side. Your own Macs keep their copies either way.'
            : 'If it does not work, it is the passphrase rather than the passkey: the passkey has already been accepted.'}
        </p>

        {problem ? <p className="text-sm text-error">{problem}</p> : null}

        <div className="flex gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void open()}
            disabled={unlock.isPending || passphrase.length === 0}
          >
            {unlock.isPending ? 'Unlocking…' : status.firstDevice ? 'Set it and start syncing' : 'Unlock'}
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
        {status.quotaBytes > 0 ? (
          <Row
            label="Files"
            value={`${size(status.usedBytes)} of ${size(status.quotaBytes)}`}
          />
        ) : null}
      </div>

      {status.filesOverQuota > 0 ? (
        <p className="text-sm text-warning">
          {status.filesOverQuota} file{status.filesOverQuota === 1 ? '' : 's'} could not
          be sent — this account is out of space. Everything written stays here and keeps
          syncing; only the files are waiting.
        </p>
      ) : null}

      <Plan billing={status.billing} onChanged={() => void refetch()} />

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

      {/*
        The next thing somebody wants, said once and where they are. Every step is a
        thing they have already done here, so it is a reminder rather than a manual.
      */}
      <details className="text-sm">
        <summary className="cursor-pointer opacity-75">Add another Mac</summary>
        <ol className="mt-2 flex flex-col gap-2 opacity-75">
          <Step n={1}>Install Neo there and let it finish setting itself up.</Step>
          <Step n={2}>Open app settings, Sync, and press Connect with a passkey — the
            same passkey, offered by the browser. There is nothing to type.</Step>
          <Step n={3}>Type this account&rsquo;s passphrase. Everything arrives on its
            own from there.</Step>
        </ol>
      </details>

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

/**
 * What this costs, and it is drawn at all only when the server charges for anything.
 *
 * A self-hosted server answers `billed: false` and this is simply absent — no plan, no
 * trial, no greyed-out upgrade button advertising something that does not exist there.
 */
function Plan({
  billing, onChanged
}: { billing: SyncBilling; onChanged: () => void }): React.JSX.Element | null {
  const pay = useApiMutation('sync:pay')
  // Only the two prices need Stripe, so they are the only thing fetched here — and
  // only once the pane is actually open on a server that charges.
  const { data: prices } = useApi('sync:prices', undefined, { enabled: billing.billed })
  const monthly = prices?.monthly || billing.monthly
  const yearly = prices?.yearly || billing.yearly

  if (!billing.billed) return null

  const go = (kind: 'monthly' | 'yearly' | 'manage'): void => {
    void pay.mutateAsync({ kind }).then(onChanged)
  }

  const buy = (
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn btn-primary btn-sm" disabled={pay.isPending}
              onClick={() => go('monthly')}>
        {monthly ? `${monthly} a month` : 'Subscribe monthly'}
      </button>
      <button className="btn btn-sm" disabled={pay.isPending} onClick={() => go('yearly')}>
        {yearly ? `${yearly} a year` : 'Subscribe yearly'}
      </button>
      {billing.hasCustomer ? (
        <button className="link link-hover text-sm opacity-70" onClick={() => go('manage')}>
          Billing
        </button>
      ) : null}
    </div>
  )

  const manage = (
    <button className="btn btn-ghost btn-sm self-start" disabled={pay.isPending}
            onClick={() => go('manage')}>
      Manage billing
    </button>
  )

  if (billing.plan === 'active') {
    return (
      <Block>
        <Row
          label="Plan"
          value={billing.endingAt
            ? `Ends ${date(billing.renewsAt)}`
            : billing.renewsAt ? `Subscribed, renews ${date(billing.renewsAt)}` : 'Subscribed'}
        />
        {billing.endingAt ? (
          <p className="text-sm opacity-70">
            Syncing carries on until then. After that your work stays on your own Macs
            and everything on the server can still be downloaded.
          </p>
        ) : null}
        {manage}
      </Block>
    )
  }

  if (billing.plan === 'past_due') {
    return (
      <Block>
        <p className="text-sm text-warning">
          The last payment did not go through. Syncing carries on while it is retried —
          nothing has stopped and nothing has been lost.
        </p>
        {manage}
      </Block>
    )
  }

  if (billing.plan === 'trial' && billing.mayWrite) {
    return (
      <Block>
        <Row label="Plan" value={`Trial, ${remaining(billing.trialEndsAt)}`} />
        <p className="text-sm opacity-70">
          Everything works during the trial. Afterwards your work stays on this Mac
          either way — a subscription is what keeps your machines in step.
        </p>
        {buy}
      </Block>
    )
  }

  /* Lapsed. Read only, and the wording has to make clear that is not the same as gone. */
  return (
    <Block>
      <p className="text-sm text-warning">
        This account is not subscribed. Everything already on the server can still be
        downloaded, on every machine, and nothing on this Mac has changed — but new
        work is not going out until a subscription picks it up.
      </p>
      {buy}
    </Block>
  )
}

function Block({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="hairline flex flex-col gap-2 rounded-box border p-3">{children}</div>
}

function Step({ n, children }: { n: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px w-4 shrink-0 text-right tabular-nums opacity-45">{n}</span>
      <span>{children}</span>
    </li>
  )
}

/** One sentence about what is happening, in the same register as an attention line. */
function Line({ status }: { status: SyncStatus }): React.JSX.Element {
  const [icon, words] =
    !status.billing.mayWrite
      ? (['alert', 'Receiving, but not sending — this account is not subscribed.'] as const)
      : status.phase === 'error'
        ? (['alert', status.error || 'Something went wrong.'] as const)
        : status.phase === 'syncing'
          ? (['refresh', 'Syncing now.'] as const)
          : status.pending > 0
            ? (['clock', 'Some changes are still to go out.'] as const)
            : status.live
              ? (['check', 'Up to date. Changes on your other Macs appear here in seconds.'] as const)
              : (['check', 'Up to date.'] as const)

  const bad = status.phase === 'error' || !status.billing.mayWrite
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon name={icon} className={bad ? 'text-error' : 'opacity-60'} />
      <span className={bad ? 'text-error' : ''}>{words}</span>
    </div>
  )
}

/** Bytes, said the way a person would say them. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const date = (iso: string): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : ''

/**
 * How long is left, in whole days, and never a negative one — a trial that ran out
 * yesterday is handled by the branch above this, so this only ever counts down.
 */
function remaining(iso: string): string {
  if (!iso) return 'in progress'
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
  if (days <= 0) return 'ending today'
  return days === 1 ? '1 day left' : `${days} days left`
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="opacity-60">{label}</span>
      <span>{value}</span>
    </div>
  )
}
