import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useContextMenu } from '@/lib/contextMenu'
import type { Person } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { differs, plural, STATUS_LABEL } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { RoleBadges } from '@/components/RoleInput'
import {
  Avatar, ConfirmButton, EmptyState, Field, Modal, PageHeader, Panel, Section
} from '@/components/primitives'

const AVATAR_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899',
  '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#eab308'
]

export function PeoplePage(): React.JSX.Element {
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const openMenu = useContextMenu()
  const removePerson = useApiMutation('person:delete')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingPerson, setEditingPerson] = useState<Person | null>(null)
  const people = useApi('person:list', { workspaceId: workspace.id, query })

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`Who is who in ${workspace.name}, and what they are to you on each project.`}
        actions={
          <>
            <label className="input input-bordered input-sm w-56 gap-2">
              <Icon name="search" size={13} className="text-base-content/35" />
              <input
                className="grow"
                placeholder="Search people…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              Add person
            </button>
          </>
        }
      />

      {people.data?.length === 0 ? (
        <EmptyState
          icon="people"
          title={query ? 'Nobody matches that.' : 'No people yet.'}
          hint="Roles belong to the connection between a person and a project, so the same person can be a tech lead in one place and a stakeholder in another."
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {(people.data ?? []).map((person) => (
            <Link
              key={person.id}
              to={`/people/${person.id}`}
              className="hairline row-hover flex items-start gap-3 rounded-box border bg-base-100 px-4 py-3"
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Open', icon: 'arrowRight', onSelect: () => navigate(`/people/${person.id}`) },
                  person.isMe
                    ? { label: 'Edit your profile', icon: 'edit', onSelect: () => navigate('/settings') }
                    : { label: 'Edit…', icon: 'edit', onSelect: () => setEditingPerson(person) },
                  ...(person.isMe
                    ? []
                    : ([
                        'separator',
                        {
                          label: 'Delete person',
                          icon: 'trash' as const,
                          danger: true,
                          onSelect: () => removePerson.mutate({ id: person.id }),
                          confirm: {
                            title: `Delete ${person.name}?`,
                            body: 'They are removed from every project in this workspace. Notes and decisions stay.'
                          }
                        }
                      ] as const))
                ])
              }
            >
              <Avatar name={person.name} color={person.avatarColor} image={person.avatar} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{person.name}</span>
                  {person.isMe && (
                    <span className="rounded-full bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary">
                      You
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-base-content/50">
                  {person.isMe
                    ? `On ${plural(person.projectCount, 'project')} in this workspace`
                    : `${person.org || 'No organisation'} · ${plural(person.projectCount, 'project')}`}
                </div>
                {person.howToWorkWith && (
                  <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-base-content/45">
                    {person.howToWorkWith}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      <PersonModal open={creating} onClose={() => setCreating(false)} person={null} />
      <PersonModal
        open={editingPerson !== null}
        onClose={() => setEditingPerson(null)}
        person={editingPerson}
      />
    </>
  )
}

export function PersonPage(): React.JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const { data, isLoading } = useApi('person:get', { id })
  const remove = useApiMutation('person:delete')

  if (isLoading || !data) {
    return <div className="py-20 text-center text-sm text-base-content/40">Loading…</div>
  }

  const { person, projects } = data

  return (
    <>
      <Link
        to="/people"
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-base-content/45 transition hover:text-base-content"
      >
        <Icon name="arrowLeft" size={12} />
        People
      </Link>

      <div className="mb-8 flex items-start gap-4">
        <Avatar name={person.name} color={person.avatarColor} image={person.avatar} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[26px] font-semibold tracking-[-0.02em]">
            {person.name}
            {person.isMe && (
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                You
              </span>
            )}
          </h1>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-base-content/50">
            {person.org && <span>{person.org}</span>}
            {person.email && <span>{person.email}</span>}
            {person.phone && <span>{person.phone}</span>}
            {person.timezone && <span>{person.timezone}</span>}
          </div>
        </div>
        {person.isMe ? (
          <Link to="/settings" className="btn btn-ghost btn-sm gap-1.5">
            <Icon name="edit" size={13} />
            Edit profile
          </Link>
        ) : (
          <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => setEditing(true)}>
            <Icon name="edit" size={13} />
            Edit
          </button>
        )}
      </div>

      <div className="grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <Section title="On these projects" count={projects.length}>
            {projects.length === 0 ? (
              <EmptyState icon="projects" title="Not on any project yet." />
            ) : (
              <div className="hairline overflow-hidden rounded-box border bg-base-100">
                {projects.map((membership) => (
                  <Link
                    key={membership.id}
                    to={`/projects/${membership.projectId}`}
                    className="row-hover hairline flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium">{membership.projectName}</span>
                        {membership.isEscalation && (
                          <span className="tooltip text-warning" data-tip="Escalation path here">
                            <Icon name="flag" size={11} />
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <RoleBadges value={membership.role} />
                        <span className="text-[11px] text-base-content/45">
                          {STATUS_LABEL[membership.projectStatus]}
                        </span>
                      </div>
                      {membership.note && (
                        <div className="mt-1 text-[11px] text-base-content/45">{membership.note}</div>
                      )}
                    </div>
                    <Icon name="chevronRight" size={13} className="text-base-content/20" />
                  </Link>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div>
          {person.howToWorkWith && (
            <Section title="How to work with them">
              <Panel>
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{person.howToWorkWith}</p>
              </Panel>
            </Section>
          )}
          {person.notes && (
            <Section title="Notes">
              <Panel>
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{person.notes}</p>
              </Panel>
            </Section>
          )}
          {!person.isMe && (
            <ConfirmButton
              label="Delete person"
              title={`Delete ${person.name}?`}
              body="They are removed from every project in this workspace. Notes and decisions stay."
              className="btn btn-ghost btn-xs text-base-content/35 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: person.id })
                navigate('/people')
              }}
            />
          )}
        </div>
      </div>

      <PersonModal open={editing} onClose={() => setEditing(false)} person={person} />
    </>
  )
}

function PersonModal({
  open,
  onClose,
  person
}: {
  open: boolean
  onClose: () => void
  person: Person | null
}): React.JSX.Element {
  const workspace = useWorkspace()
  const save = useApiMutation('person:save')
  const [form, setForm] = useState({
    name: '', org: '', email: '', phone: '', timezone: '', howToWorkWith: '', notes: '',
    avatarColor: AVATAR_COLORS[0] as string,
    avatarPath: ''
  })
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)

  const original = {
    name: person?.name ?? '',
    org: person?.org ?? '',
    email: person?.email ?? '',
    phone: person?.phone ?? '',
    timezone: person?.timezone ?? '',
    howToWorkWith: person?.howToWorkWith ?? '',
    notes: person?.notes ?? '',
    avatarColor: person?.avatarColor ?? (AVATAR_COLORS[0] as string),
    avatarPath: person?.avatarPath ?? ''
  }

  useEffect(() => {
    if (!open) return
    setForm({
      name: person?.name ?? '',
      org: person?.org ?? '',
      email: person?.email ?? '',
      phone: person?.phone ?? '',
      timezone: person?.timezone ?? '',
      howToWorkWith: person?.howToWorkWith ?? '',
      notes: person?.notes ?? '',
      avatarColor: person?.avatarColor ?? (AVATAR_COLORS[0] as string),
      avatarPath: person?.avatarPath ?? ''
    })
    setAvatarPreview(person?.avatar ?? null)
  }, [open, person])

  const set = (key: keyof typeof form, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return
    await save.mutateAsync({
      id: person?.id,
      workspaceId: workspace.id,
      ...form,
      name: form.name.trim()
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={person ? 'Edit person' : 'Add a person'}
      width="max-w-2xl"
      onSubmit={() => void submit()}
      isDirty={differs(form, original)}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!form.name.trim()} onClick={() => void submit()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <IconPicker
          name={form.name}
          color={form.avatarColor}
          icon={avatarPreview}
          size={56}
          hint="A photo makes people recognisable at a glance across projects and meetings."
          onChange={({ iconPath, icon }) => {
            setForm((f) => ({ ...f, avatarPath: iconPath }))
            setAvatarPreview(icon)
          }}
        />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <input
              autoFocus
              className="input input-bordered w-full"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Organisation">
            <input
              className="input input-bordered w-full"
              value={form.org}
              onChange={(e) => set('org', e.target.value)}
            />
          </Field>
          <Field label="Email">
            <input
              className="input input-bordered w-full"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <input
              className="input input-bordered w-full"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </Field>
          <Field label="Timezone" hint="Useful when half your people are not where you are.">
            <input
              className="input input-bordered w-full"
              placeholder="Europe/Oslo"
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            />
          </Field>
          <Field label="Colour" hint="Used when there is no photo.">
            <div className="flex flex-wrap gap-1.5 pt-1.5">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`size-6 rounded-full transition ${
                    form.avatarColor === color ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100' : ''
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => set('avatarColor', color)}
                  aria-label={color}
                />
              ))}
            </div>
          </Field>
        </div>

        <Field
          label="How to work with them"
          hint="The operating manual: how they prefer to be contacted, when they are useless, what they actually decide."
        >
          <textarea
            className="textarea textarea-bordered min-h-20 w-full text-sm leading-relaxed"
            placeholder="Decides fast, but only in writing. No meetings before 10."
            value={form.howToWorkWith}
            onChange={(e) => set('howToWorkWith', e.target.value)}
          />
        </Field>

        <Field label="Notes">
          <textarea
            className="textarea textarea-bordered min-h-16 w-full text-sm leading-relaxed"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
