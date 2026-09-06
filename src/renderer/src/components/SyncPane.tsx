import { useState } from 'react'
import { useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { Field, Panel } from '@/components/primitives'
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

  if (!status) return <Panel><p className="text-[12px] text-base-content/55">Looking…</p></Panel>

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
      <Panel>
        <p className="max-w-xl text-[13px] leading-relaxed text-base-content/70">
          Neo keeps everything on this Mac. Connecting it to a sync server keeps your
          other machines in step and gives your work an off-site backup that is
          encrypted before it leaves this app — the server holds bytes it cannot read.
        </p>

        {/*
          What is about to happen, before it happens. Pressing the button opens the
          browser, which is a surprise worth spending three lines to avoid: somebody
          who does not expect it reads a new tab as having been sent somewhere.
        */}
        <ol className="mt-4 flex max-w-xl flex-col gap-2 text-[12.5px] leading-relaxed text-base-content/60">
          <Step n={1}>Your browser opens, and you sign in with a passkey — Touch ID,
            or your phone. There is no password to choose.</Step>
          <Step n={2}>Back here, you pick a passphrase. That is what encrypts your
            work, and it never reaches the server.</Step>
          <Step n={3}>Everything already on this Mac goes up, encrypted, and stays in
            step from then on.</Step>
        </ol>

        {ownServer ? (
          <div className="mt-4 max-w-xs">
            <Field label="Your server&rsquo;s address">
              <input
                className="input input-bordered input-sm w-full"
                placeholder="https://sync.example.com"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
        ) : null}

        <div className="mt-5 flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void connect()}
            disabled={signIn.isPending || (ownServer && !server.trim())}
          >
            {signIn.isPending ? 'Waiting for your passkey…' : 'Connect with a passkey'}
          </button>
          {signIn.isPending ? (
            <span className="text-[11.5px] text-base-content/50">Finish in the browser, then come back.</span>
          ) : null}
        </div>

        {problem ? <div className="mt-3"><Notice tone="error">{problem}</Notice></div> : null}

        {ownServer ? null : (
          <button
            className="mt-4 self-start text-[12px] text-base-content/55 underline decoration-base-content/25 hover:decoration-current"
            onClick={() => setOwnServer(true)}
          >
            Use your own server
          </button>
        )}
      </Panel>
    )
  }

  /* ------------------------------------------------------------- locked */

  if (status.phase === 'locked') {
    return (
      <Panel>
        <p className="max-w-xl text-[13px] leading-relaxed text-base-content/70">
          Signed in as <span className="font-medium text-base-content">{status.accountHandle}</span>.
          {status.firstDevice
            ? ' Now choose a passphrase. It encrypts everything before it leaves this Mac, and it never reaches the sync server.'
            : ' Type the passphrase you chose when you set this account up. It never reaches the sync server, which is why it has to be typed on each machine.'}
        </p>

        <div className="mt-4 max-w-xs">
          <Field label={status.firstDevice ? 'Choose a passphrase' : 'Passphrase'}>
            <input
              className="input input-bordered input-sm w-full"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
            />
          </Field>

          {status.firstDevice ? (
            <div className="mt-3">
              <Field label="And again">
                <input
                  className="input input-bordered input-sm w-full"
                  type="password"
                  value={again}
                  onChange={(e) => setAgain(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </div>

        <p className="mt-3 max-w-lg text-[11.5px] leading-relaxed text-base-content/45">
          {status.firstDevice
            ? 'Nobody can reset this. If it is lost, so is everything the server holds — which is the same sentence as “the server cannot read it”, said from the other side. Your own Macs keep their copies either way.'
            : 'If it does not work, it is the passphrase rather than the passkey: the passkey has already been accepted.'}
        </p>

        {problem ? <div className="mt-3"><Notice tone="error">{problem}</Notice></div> : null}

        <div className="mt-4 flex gap-2">
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
      </Panel>
    )
  }

  /* ---------------------------------------------------------- connected */

  const syncing = status.phase === 'syncing' || syncNow.isPending

  return (
    <div className="flex flex-col gap-4">
      <Plan billing={status.billing} onChanged={() => void refetch()} />

      <Panel>
        <Line status={status} />

        <div className="hairline mt-3.5 flex flex-col gap-2 border-t pt-3.5">
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
            <div>
              <Row
                label="Files"
                value={`${size(status.usedBytes)} of ${size(status.quotaBytes)}`}
              />
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-base-content/10">
                <div
                  className={`h-full rounded-full ${
                    status.usedBytes / status.quotaBytes > 0.9 ? 'bg-warning' : 'bg-primary'
                  }`}
                  style={{
                    width: `${Math.min(
                      100,
                      status.usedBytes > 0
                        ? Math.max(2, (status.usedBytes / status.quotaBytes) * 100)
                        : 0
                    )}%`
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="hairline mt-3.5 flex gap-2 border-t pt-3.5">
          <button
            className="btn btn-sm gap-1.5"
            onClick={() => void syncNow.mutateAsync().then(() => refetch())}
            disabled={syncing}
          >
            <Icon name="refresh" size={12} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void disconnect.mutateAsync().then(() => refetch())}
          >
            Disconnect this Mac
          </button>
        </div>
      </Panel>

      {status.error ? <Notice tone="error">{status.error}</Notice> : null}

      {status.filesOverQuota > 0 ? (
        <Notice>
          {status.filesOverQuota} file{status.filesOverQuota === 1 ? '' : 's'} could not
          be sent — this account is out of space. Everything written stays here and keeps
          syncing; only the files are waiting.
        </Notice>
      ) : null}

      {/*
        The next thing somebody wants, said once and where they are. Every step is a
        thing they have already done here, so it is a reminder rather than a manual.
      */}
      <details className="group px-1">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-base-content/55 hover:text-base-content/80">
          <Icon
            name="chevronRight"
            size={12}
            className="transition-transform group-open:rotate-90"
          />
          Add another Mac
        </summary>
        <ol className="mt-2.5 flex max-w-lg flex-col gap-2 text-[12px] leading-relaxed text-base-content/55">
          <Step n={1}>Install Neo there and let it finish setting itself up.</Step>
          <Step n={2}>Open app settings, Sync, and press Connect with a passkey — the
            same passkey, offered by the browser. There is nothing to type.</Step>
          <Step n={3}>Type this account&rsquo;s passphrase. Everything arrives on its
            own from there.</Step>
        </ol>
      </details>

      <p className="px-1 text-[11.5px] leading-relaxed text-base-content/45">
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

  /*
   * The choice is between two prices, so each is drawn as the price rather than as
   * a button that happens to mention one. The ring marks the better value, and it is
   * only ever drawn when the saving was actually computed — never assumed.
   */
  const saving = savings(monthly, yearly)
  const buy = (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <PriceChoice
          price={monthly}
          per="a month"
          noun="Monthly"
          disabled={pay.isPending}
          onClick={() => go('monthly')}
        />
        <PriceChoice
          price={yearly}
          per="a year"
          noun="Yearly"
          badge={saving}
          recommended={saving !== ''}
          disabled={pay.isPending}
          onClick={() => go('yearly')}
        />
      </div>
      {billing.hasCustomer ? (
        <button
          className="mt-2 text-[12px] text-base-content/55 underline decoration-base-content/25 hover:decoration-current"
          onClick={() => go('manage')}
        >
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
      <Panel>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium">Plan</span>
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
            {billing.endingAt
              ? `Ends ${date(billing.renewsAt)}`
              : billing.renewsAt ? `Renews ${date(billing.renewsAt)}` : 'Subscribed'}
          </span>
        </div>
        {billing.endingAt ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-base-content/55">
            Syncing carries on until then. After that your work stays on your own Macs
            and everything on the server can still be downloaded.
          </p>
        ) : null}
        <div className="mt-3">{manage}</div>
      </Panel>
    )
  }

  if (billing.plan === 'past_due') {
    return (
      <Panel>
        <Notice>
          The last payment did not go through. Syncing carries on while it is retried —
          nothing has stopped and nothing has been lost.
        </Notice>
        <div className="mt-3">{manage}</div>
      </Panel>
    )
  }

  if (billing.plan === 'trial' && billing.mayWrite) {
    return (
      /*
       * The one card on the page that asks for something, so it is the one card
       * allowed a tint: the accent at a whisper, and the days left drawn as a
       * number rather than buried in a sentence. The fallback, for a trial with
       * no date or none left, is the plain pill — a big "0" is a bug report.
       */
      <div className="hairline rounded-box border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-center gap-4">
          <TrialDays iso={billing.trialEndsAt} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Trial</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
              Everything works during the trial. Afterwards your work stays on this Mac
              either way — a subscription is what keeps your machines in step.
            </p>
          </div>
        </div>
        <div className="mt-3.5">{buy}</div>
      </div>
    )
  }

  /* Lapsed. Read only, and the wording has to make clear that is not the same as gone. */
  return (
    <Panel>
      <Notice>
        This account is not subscribed. Everything already on the server can still be
        downloaded, on every machine, and nothing on this Mac has changed — but new
        work is not going out until a subscription picks it up.
      </Notice>
      <div className="mt-3.5">{buy}</div>
    </Panel>
  )
}

/**
 * One price, drawn as a card the way the format choices are: the thing itself large,
 * what it means small. Without a price from the server it falls back to naming the
 * period, so a server that has not said yet still offers the choice.
 */
function PriceChoice({
  price, per, noun, badge, recommended = false, disabled, onClick
}: {
  price: string
  per: string
  /** What the card is called when there is no price to draw. */
  noun: string
  badge?: string
  recommended?: boolean
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-field border bg-base-100 px-3.5 py-2.5 text-left transition ${
        recommended
          ? 'border-primary ring-2 ring-primary/25'
          : 'hairline hover:border-base-content/25'
      }`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[16px] font-semibold tracking-[-0.01em] tabular-nums">
          {price || noun}
        </span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 block text-[11px] text-base-content/45">
        {price ? per : 'Subscribe'}
      </span>
    </button>
  )
}

/**
 * "Save 45%", computed from the two price strings rather than claimed. Prices arrive
 * as display strings ("$9", "59 USD"), so this reads the first number out of each
 * and stays silent — no badge, no ring — the moment either one does not parse.
 */
function savings(monthly: string, yearly: string): string {
  const m = amount(monthly)
  const y = amount(yearly)
  if (m === null || y === null) return ''
  const pct = Math.round((1 - y / (m * 12)) * 100)
  return pct > 0 ? `Save ${pct}%` : ''
}

function amount(price: string): number | null {
  const match = price.replace(',', '.').match(/\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

/**
 * The trial's countdown as the card's anchor: a big number, tinted only when it is
 * nearly out — colour means something here, and "ends soon" is the one fact worth
 * lifting. Without a real date it is a quiet pill instead of a made-up figure.
 */
function TrialDays({ iso }: { iso: string }): React.JSX.Element {
  const days = iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null
  if (days === null || days <= 0) {
    return (
      <span className="shrink-0 rounded-full bg-base-content/8 px-2 py-0.5 text-[11px] font-medium tabular-nums text-base-content/60">
        {remaining(iso)}
      </span>
    )
  }
  const nearlyOut = days <= 3
  return (
    <div className="w-14 shrink-0 text-center">
      <div
        className={`text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${
          nearlyOut ? 'text-warning' : 'text-primary'
        }`}
      >
        {days}
      </div>
      <div className="mt-1 text-[10.5px] leading-tight text-base-content/50">
        {days === 1 ? 'day left' : 'days left'}
      </div>
    </div>
  )
}

/** A small alert strip, in the same shape the recording pane's test result uses. */
function Notice({
  tone = 'warning', children
}: { tone?: 'warning' | 'error'; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className={`hairline flex items-start gap-2 rounded-field border px-3 py-2 text-[12px] leading-relaxed ${
        tone === 'error'
          ? 'border-error/40 bg-error/5 text-error'
          : 'border-warning/40 bg-warning/5 text-warning'
      }`}
    >
      <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px w-4 shrink-0 text-right tabular-nums text-base-content/40">{n}</span>
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
  const tone = bad ? 'text-error' : icon === 'check' ? 'text-success' : 'text-base-content/50'
  return (
    <div className="flex items-center gap-2.5">
      <Icon
        name={icon}
        size={15}
        className={`shrink-0 ${tone} ${icon === 'refresh' ? 'animate-spin' : ''}`}
      />
      <span className={`text-[13px] font-medium ${bad ? 'text-error' : ''}`}>{words}</span>
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
    <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
      <span className="shrink-0 text-base-content/50">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  )
}
