import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useApiMutation } from '@/lib/api'
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
