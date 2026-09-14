import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountStatus } from '@shared/account'
import { call } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import { Icon } from '@/components/Icon'
import { Logo } from '@/components/Logo'
import { Field } from '@/components/primitives'

/**
 * The door, and there is no way round it.
 *
 * Neo keeps every workspace, note, meeting and recording in Neo Cloud and nothing on
 * the machine, so an account is not a feature to be offered later — it is where the
 * work is. This is the first screen of a new install and the screen a signed-out
 * machine comes back to.
 *
 * Signing in is the common case and the default. Making an account is one click away
 * and asks for one more thing: the password twice. A passkey does both in the
 * person's own browser, where it belongs to them rather than to this Mac, which is why
 * that button says it will open one.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (status: AccountStatus) => void }): React.JSX.Element {
  // Nothing is signed in yet, so this is the default theme; it is still a theme.
  useTheme()
  const client = useQueryClient()
  const [mode, setMode] = useState<'signin' | 'create'>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState<'' | 'password' | 'passkey'>('')
  const [problem, setProblem] = useState('')

  const creating = mode === 'create'

  const done = (status: AccountStatus): void => {
    if (!status.signedIn) return
    // Whatever was cached belonged to nobody, or to somebody else. Start clean.
    client.clear()
    onSignedIn(status)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setProblem('')
    if (!username.trim() || !password) {
      setProblem(creating ? 'Choose a username and a password.' : 'Type your username and password.')
      return
    }
    if (creating && password !== again) {
      setProblem('Those two passwords do not match.')
      return
    }
    setBusy('password')
    try {
      const input = { username: username.trim().toLowerCase(), password }
      done(creating ? await call('account:register', input) : await call('account:signIn', input))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const passkey = async (): Promise<void> => {
    if (busy) return
    setProblem('')
    setBusy('passkey')
    try {
      const status = await call('account:passkey')
      if (status.signedIn) done(status)
      else setProblem('The browser did not finish signing in. Try again when you are ready.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const switchMode = (): void => {
    setMode(creating ? 'signin' : 'create')
    setProblem('')
    setAgain('')
  }

  return (
    <div className="flex h-full items-center justify-center bg-base-200/40 px-6">
      <div className="drag-region absolute inset-x-0 top-0 h-[52px]" />

      <div className="rise w-full max-w-sm">
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <div>
            <div className="text-[17px] font-semibold leading-tight tracking-[-0.015em]">Neo</div>
            <div className="text-[12px] text-base-content/50">A command centre for several working lives</div>
          </div>
        </div>
        <div className="brand-gradient mb-6 mt-4 h-[2px] w-14 rounded-full" />

        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">
          {creating ? 'Make your account' : 'Sign in to Neo'}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-base-content/60">
          {creating
            ? 'Your work lives in Neo Cloud, so it is on every Mac you sign in to and nothing is left behind on this one. It is free, and free includes everything.'
            : 'Everything you have in Neo is in your account. Sign in and it is all here.'}
        </p>

        <form
          className="hairline mt-6 rounded-box border bg-base-100 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Username">
            <input
              autoFocus
              className="input input-bordered w-full"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Password" className="mt-4" hint={creating ? 'At least 10 characters.' : undefined}>
            <input
              type="password"
              className="input input-bordered w-full"
              autoComplete={creating ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {creating && (
            <Field label="The same password again" className="mt-4">
              <input
                type="password"
                className="input input-bordered w-full"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </Field>
          )}

          <button type="submit" className="btn btn-primary mt-6 w-full" disabled={Boolean(busy)}>
            {busy === 'password'
              ? creating ? 'Making your account…' : 'Signing in…'
              : creating ? 'Make account' : 'Sign in'}
          </button>

          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-[0.09em] text-base-content/35">
            <span className="h-px flex-1 bg-base-content/10" />
            or
            <span className="h-px flex-1 bg-base-content/10" />
          </div>

          <button
            type="button"
            className="btn w-full gap-1.5"
            disabled={Boolean(busy)}
            onClick={() => void passkey()}
          >
            <Icon name="external" size={13} />
            {busy === 'passkey' ? 'Finish in your browser…' : 'Use a passkey'}
          </button>
          <p className="mt-2 text-center text-[11.5px] leading-relaxed text-base-content/45">
            Opens your browser, where you can sign in with a passkey or make an account with one.
          </p>

          {problem && (
            <p className="mt-4 text-[12.5px] text-error" role="status">
              {problem}
            </p>
          )}
        </form>

        <div className="mt-5 text-center">
          <button className="btn btn-ghost btn-sm text-base-content/55" onClick={switchMode} disabled={Boolean(busy)}>
            {creating ? 'I already have an account' : 'New to Neo? Make an account'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Signed in, and Neo Cloud cannot be reached.
 *
 * Not the sign-in screen: the account is fine and asking for a password again would be
 * a lie about what went wrong. Nothing is kept on this machine, so there is nothing to
 * show until the connection comes back — this says so, and tries again when asked.
 */
export function Offline({
  username,
  onRetry,
  onSignOut
}: {
  username: string
  onRetry: () => void
  onSignOut: () => void
}): React.JSX.Element {
  useTheme()
  return (
    <div className="flex h-full items-center justify-center bg-base-200/40 px-6">
      <div className="drag-region absolute inset-x-0 top-0 h-[52px]" />
      <div className="rise w-full max-w-sm text-center">
        <div className="flex justify-center">
          <Logo size={34} />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.02em]">Neo Cloud cannot be reached</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-base-content/60">
          Your work is safe in your account{username ? `, ${username}` : ''}. It will be here as soon as this
          machine is back online.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button className="btn btn-primary btn-sm gap-1.5" onClick={onRetry}>
            <Icon name="refresh" size={13} />
            Try again
          </button>
          <button className="btn btn-ghost btn-sm text-base-content/55" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
