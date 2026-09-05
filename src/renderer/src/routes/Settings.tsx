import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { openExternal, useApi, useApiMutation } from '@/lib/api'
import { useTheme, THEMES } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { Logo } from '@/components/Logo'
import { IconPicker } from '@/components/IconPicker'
import { SettingsLayout } from '@/components/SettingsLayout'
import { Field, Kbd, Panel } from '@/components/primitives'

export function SettingsPage(): React.JSX.Element {
  const workspace = useWorkspace()

  return (
    <SettingsLayout
      title="Settings"
      exitTo="/"
      subtitle={
        <>
          You and your data. Anything about {workspace.name} itself lives in{' '}
          <Link to="/workspace" className="underline decoration-base-content/25 hover:decoration-current">
            workspace settings
          </Link>
          .
        </>
      }
      panes={[
        {
          id: 'profile',
          label: 'Profile',
          icon: 'people',
          description: 'One profile, mirrored into every workspace as a person.',
          render: () => <ProfilePane />
        },
        {
          id: 'appearance',
          label: 'Appearance',
          icon: 'sun',
          description: 'How the app looks on this machine.',
          render: () => <AppearancePane />
        },
        {
          id: 'data',
          label: 'Data',
          icon: 'folder',
          description: 'Where everything is kept, and how to get it out again.',
          render: () => <DataPane />
        },
        {
          id: 'claude',
          label: 'Claude',
          icon: 'chat',
          description: 'Let the Claude desktop app read and change what is in Neo.',
          render: () => <ClaudePane />
        },
        {
          id: 'shortcuts',
          label: 'Shortcuts',
          icon: 'command',
          render: () => <ShortcutsPane />
        },
        {
          id: 'about',
          label: 'About',
          icon: 'sparkle',
          render: () => <AboutPane />
        }
      ]}
    />
  )
}

/**
 * One profile, mirrored into every workspace as a person. Editing it here renames and
 * re-photographs you everywhere you appear — cast panels, meeting attendees, task
 * assignees — without you having to touch each workspace.
 */
function ProfilePane(): React.JSX.Element {
  const profile = useApi('profile:get')
  const save = useApiMutation('profile:save')
  const [name, setName] = useState('')

  useEffect(() => {
    if (profile.data) setName(profile.data.name)
  }, [profile.data?.name])

  if (!profile.data) return <></>

  return (
    <Panel className="px-6 py-8">
      {/* The photo is the subject here rather than a field beside one, so it sits on
          its own above the name instead of pushing it into a narrow column. */}
      <div className="mx-auto flex max-w-xs flex-col items-center">
        <IconPicker
          name={name}
          color="var(--color-primary)"
          icon={profile.data.avatar}
          size={88}
          layout="column"
          noun="photo"
          hint="Shown wherever you appear on a project."
          onChange={({ iconPath }) => save.mutate({ avatarPath: iconPath })}
        />

        <div className="mt-6 w-full">
          <Field label="Your name">
            <input
              className="input input-bordered w-full text-center"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== profile.data?.name && save.mutate({ name: name.trim() })}
            />
          </Field>
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-base-content/45">
          You appear as a person in every workspace, so you can be put on projects and given roles
          like anyone else. Changing this updates all of them.
        </p>
      </div>
    </Panel>
  )
}

/** The theme lives here rather than in the top bar: you set it once and forget it. */
function AppearancePane(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <Panel>
      <Field label="Theme" hint="System follows macOS, and changes with it while the app is open.">
        <div className="flex flex-wrap gap-2 pt-1">
          {THEMES.map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={`hairline flex items-center gap-2 rounded-field border px-3 py-2 text-[13px] transition ${
                theme === option.value
                  ? 'border-primary/50 bg-primary/[0.06] font-medium'
                  : 'text-base-content/65 hover:bg-base-200'
              }`}
            >
              <Icon name={option.icon} size={15} className="opacity-70" />
              {option.label}
              {theme === option.value && <Icon name="check" size={13} className="text-primary" />}
            </button>
          ))}
        </div>
      </Field>
    </Panel>
  )
}

function DataPane(): React.JSX.Element {
  const settings = useApi('settings:get')
  const reveal = useApiMutation('settings:revealData')
  const exportMarkdown = useApiMutation('settings:exportMarkdown')
  const exportJson = useApiMutation('settings:exportJson')
  const [message, setMessage] = useState('')

  return (
    <Panel>
      <Field label="Folder">
        <div className="flex items-center gap-2">
          <code className="hairline flex-1 truncate rounded-field border bg-base-200/50 px-3 py-2 font-mono text-[11px]">
            {settings.data?.dataDir ?? '…'}
          </code>
          <button className="btn btn-sm gap-1.5" onClick={() => reveal.mutate()}>
            <Icon name="folder" size={13} />
            Reveal
          </button>
        </div>
      </Field>

      <p className="mt-4 text-[12px] leading-relaxed text-base-content/55">
        Everything is in that folder: an embedded Postgres database in <code className="font-mono">db/</code>,
        a Markdown mirror of every note, decision and journal entry in{' '}
        <code className="font-mono">markdown/</code>, uploaded icons in{' '}
        <code className="font-mono">icons/</code>, and exports in{' '}
        <code className="font-mono">exports/</code>. Nothing leaves this machine. Back it up by copying
        the folder.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn btn-sm gap-1.5"
          onClick={async () => {
            const result = await exportMarkdown.mutateAsync()
            setMessage(`Rebuilt ${result.files} Markdown files.`)
          }}
        >
          <Icon name="note" size={13} />
          Rebuild Markdown mirror
        </button>
        <button
          className="btn btn-sm gap-1.5"
          onClick={async () => {
            const result = await exportJson.mutateAsync()
            setMessage(`Wrote ${result.path}`)
          }}
        >
          <Icon name="external" size={13} />
          Export JSON
        </button>
      </div>

      {message && <p className="mt-3 text-[12px] text-success">{message}</p>}
    </Panel>
  )
}

/**
 * Setting the Claude desktop app up to talk to Neo.
 *
 * The assistant panel is one way in; this is the other, and the difference is worth
 * saying out loud rather than leaving to be discovered. The panel runs on your own
 * OpenAI key and asks before every change. Claude Desktop runs on your Claude
 * subscription and does its own asking — it has no way to show Neo's confirmation,
 * so what you approve is its prompt rather than ours.
 *
 * The button writes one entry into Claude Desktop's own configuration and leaves the
 * rest of that file alone. Doing it by hand means two absolute paths typed into a
 * file in a library folder, which is a poor introduction to a feature whose point is
 * not thinking about plumbing.
 */
function ClaudePane(): React.JSX.Element {
  const status = useApi('mcp:status')
  const connect = useApiMutation('mcp:connect')
  const disconnect = useApiMutation('mcp:disconnect')
  const reveal = useApiMutation('mcp:revealConfig')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [justChanged, setJustChanged] = useState(false)

  const state = status.data
  const snippet = state
    ? JSON.stringify({ mcpServers: { neo: state.entry } }, null, 2)
    : ''

  const run = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setError('')
    try {
      await (action === 'connect' ? connect.mutateAsync() : disconnect.mutateAsync())
      setJustChanged(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!state) return <Panel><p className="text-[12px] text-base-content/55">…</p></Panel>

  return (
    <Panel>
      <p className="text-[13px] leading-relaxed text-base-content/70">
        Neo can hand its tools to the <strong>Claude desktop app</strong>, so you can ask about your
        projects, meetings and people — and have things written down, moved or ticked off — in a
        conversation that started somewhere else.
      </p>

      {!state.claudeInstalled ? (
        <div className="hairline mt-4 rounded-box border bg-base-200/40 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-base-content/70">
            Claude Desktop is not installed on this machine. Install it from{' '}
            <button
              className="underline decoration-base-content/25 hover:decoration-current"
              onClick={() => openExternal('https://claude.ai/download')}
            >
              claude.ai/download
            </button>{' '}
            and come back — this pane will do the rest.
          </p>
        </div>
      ) : (
        <>
          <div className="hairline mt-4 flex flex-wrap items-center gap-3 rounded-box border bg-base-200/40 px-4 py-3">
            <span
              className={`inline-flex size-2 shrink-0 rounded-full ${
                state.connected ? 'bg-success' : state.stale ? 'bg-warning' : 'bg-base-content/25'
              }`}
              aria-hidden="true"
            />
            <span className="flex-1 text-[12.5px] text-base-content/75">
              {state.connected
                ? 'Claude Desktop is set up to talk to Neo.'
                : state.stale
                  ? 'Claude Desktop is pointing at a different copy of Neo. Connect again to point it here.'
                  : 'Claude Desktop does not know about Neo yet.'}
            </span>
            {state.connected ? (
              <button className="btn btn-sm" onClick={() => void run('disconnect')}>
                Disconnect
              </button>
            ) : (
              <button className="btn btn-sm btn-primary gap-1.5" onClick={() => void run('connect')}>
                <Icon name="check" size={13} />
                {state.stale ? 'Point it here' : 'Connect Claude Desktop'}
              </button>
            )}
          </div>

          {justChanged && (
            <p className="mt-3 flex items-center gap-1.5 text-[12px] text-warning">
              <Icon name="refresh" size={13} />
              Quit Claude Desktop and open it again — it only reads that file at startup.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-3 text-[12px] text-error">{error}</p>}

      <p className="mt-5 text-[12px] leading-relaxed text-base-content/55">
        <strong className="font-medium text-base-content/70">Neo has to be open.</strong> The
        connector holds no copy of your data — it passes every question through to this app, which
        answers it the same way the assistant panel does. With Neo shut, Claude says so and does
        nothing. Everything it writes is logged and mirrored to Markdown exactly as if you had
        clicked it yourself.
      </p>

      <p className="mt-3 text-[12px] leading-relaxed text-base-content/55">
        It can change things, and the confirmation you get is <em>Claude Desktop&rsquo;s</em>, not
        Neo&rsquo;s — reading is marked as reading, and deleting is marked as deleting, but the
        assistant panel is the one that stops and shows you a sentence first.
      </p>

      <details className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-base-content/55 hover:text-base-content/80">
          <Icon
            name="chevronRight"
            size={12}
            className="transition-transform group-open:rotate-90"
          />
          Set it up by hand instead
        </summary>
        <div className="mt-3">
          <p className="text-[12px] leading-relaxed text-base-content/55">
            Put this in{' '}
            <button
              className="underline decoration-base-content/25 hover:decoration-current"
              onClick={() => reveal.mutate()}
            >
              claude_desktop_config.json
            </button>
            , merging it with anything already there.
          </p>
          <pre className="hairline mt-2 overflow-x-auto rounded-field border bg-base-200/50 px-3 py-2 font-mono text-[11px] leading-relaxed">
            {snippet}
          </pre>
          <button
            className="btn btn-xs mt-2 gap-1.5"
            onClick={async () => {
              await navigator.clipboard.writeText(snippet)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }}
          >
            <Icon name={copied ? 'check' : 'note'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </details>
    </Panel>
  )
}

function ShortcutsPane(): React.JSX.Element {
  return (
    <Panel>
      <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
        {[
          ['⌘K', 'Search everything'],
          ['⌘N', 'New item, from anywhere'],
          ['⌘↵', 'Save and close a dialog'],
          ['Esc', 'Close a dialog, or leave settings']
        ].map(([key, label]) => (
          <div key={key} className="flex items-center gap-3">
            <Kbd>{key}</Kbd>
            <span className="text-base-content/60">{label}</span>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

function AboutPane(): React.JSX.Element {
  const settings = useApi('settings:get')

  return (
    <Panel>
      <div className="flex items-center gap-4">
        <Logo size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.015em]">Neo</span>
            <span className="font-mono text-[11px] text-base-content/40">
              {settings.data?.appVersion ?? '…'}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            A personal command centre for running several working lives at once. Everything it
            knows is on this machine.
          </p>
        </div>
      </div>
    </Panel>
  )
}
