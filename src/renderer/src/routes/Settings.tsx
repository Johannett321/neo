import { useEffect, useState } from 'react'
import { useApi, useApiMutation } from '@/lib/api'
import { Link } from 'react-router-dom'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { ConfirmButton, PageHeader, Panel, Section } from '@/components/primitives'
import { Field } from '@/components/primitives'
import { IconPicker } from '@/components/IconPicker'

export function SettingsPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const settings = useApi('settings:get')
  const reveal = useApiMutation('settings:revealData')
  const exportMarkdown = useApiMutation('settings:exportMarkdown')
  const exportJson = useApiMutation('settings:exportJson')
  const loadSample = useApiMutation('settings:loadSample')
  const wipe = useApiMutation('settings:wipe')

  const [message, setMessage] = useState('')

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={
          <>
            You and your data. Anything about {workspace.name} itself lives in{' '}
            <Link to="/workspace" className="underline decoration-base-content/25 hover:decoration-current">
              workspace settings
            </Link>
            .
          </>
        }
      />

      <ProfileSection />

      <Section title="Your data">
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
      </Section>

      <Section title="Getting started">
        <Panel>
          <p className="text-[12px] leading-relaxed text-base-content/60">
            Sample data fills the app with a realistic set of projects, people and history so you can see how
            the pieces fit before committing your own. It only loads into an empty database.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn btn-sm gap-1.5"
              onClick={async () => {
                await loadSample.mutateAsync()
                setMessage('Sample data loaded.')
              }}
            >
              <Icon name="sparkle" size={13} />
              Load sample data
            </button>
            <ConfirmButton
              label="Delete everything"
              className="btn btn-ghost btn-sm text-base-content/50 hover:text-error"
              onConfirm={async () => {
                await wipe.mutateAsync()
                setMessage('Database reset.')
              }}
            />
          </div>
        </Panel>
      </Section>

      <Section title="Shortcuts">
        <Panel>
          <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
            {[
              ['⌘K', 'Search everything'],
              ['⌘N', 'New item, from anywhere'],
              ['⌘↵', 'Save and close a dialog'],
              ['Esc', 'Close a dialog']
            ].map(([key, label]) => (
              <div key={key} className="flex items-center gap-3">
                <kbd className="hairline rounded border px-1.5 py-0.5 font-mono text-[10px] text-base-content/55">
                  {key}
                </kbd>
                <span className="text-base-content/60">{label}</span>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>
    </>
  )
}

/**
 * One profile, mirrored into every workspace as a person. Editing it here renames and
 * re-photographs you everywhere you appear — cast panels, meeting attendees, task
 * assignees — without you having to touch each workspace.
 */
function ProfileSection(): React.JSX.Element {
  const profile = useApi('profile:get')
  const save = useApiMutation('profile:save')
  const [name, setName] = useState('')

  useEffect(() => {
    if (profile.data) setName(profile.data.name)
  }, [profile.data?.name])

  if (!profile.data) return <></>

  return (
    <Section title="Your profile">
      <Panel>
        <div className="flex items-start gap-5">
          <IconPicker
            name={name}
            color="#6366f1"
            icon={profile.data.avatar}
            size={56}
            hint="Your photo, shown wherever you appear on a project."
            onChange={({ iconPath }) => save.mutate({ avatarPath: iconPath })}
          />
          <div className="min-w-0 flex-1">
            <Field label="Your name">
              <input
                className="input input-bordered w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== profile.data?.name && save.mutate({ name: name.trim() })}
              />
            </Field>
            <p className="mt-2 text-[11px] leading-relaxed text-base-content/45">
              You appear as a person in every workspace, so you can be put on projects and given roles
              like anyone else. Changing this updates all of them.
            </p>
          </div>
        </div>
      </Panel>
    </Section>
  )
}
