import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useContextMenu } from '@/lib/contextMenu'
import type { CastMember, Person } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { differs, ROLE_SUGGESTIONS } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { Avatar, ConfirmButton, EmptyState, Field, Modal, Section } from '@/components/primitives'
import { formatRoles, parseRoles, RoleBadges, RoleInput } from '@/components/RoleInput'

/**
 * The cast sits above the fold on every project, because "who is who here again"
 * is a question you ask on the way into a project, not once you are deep in it.
 */
export function CastPanel({
  projectId,
  cast
}: {
  projectId: string
  cast: CastMember[]
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<CastMember | null>(null)
  const remove = useApiMutation('membership:delete')
  const navigate = useNavigate()
  const openMenu = useContextMenu()

  return (
    <Section
      title="Cast"
      count={cast.length}
      action={
        <button className="btn btn-ghost btn-xs gap-1" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} />
          Add
        </button>
      }
    >
      {cast.length === 0 ? (
        <EmptyState
          icon="people"
          title="Nobody recorded yet."
          hint="Roles live on the connection, not the person — the same person can be a tech lead here and a stakeholder somewhere else."
        />
      ) : (
        <div className="hairline overflow-hidden rounded-box border bg-base-100">
          {cast.map((member) => (
            <div
              key={member.id}
              className={`row-hover hairline group flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0 ${
                member.isMe ? 'bg-primary/[0.03]' : ''
              }`}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Edit role…', icon: 'edit', onSelect: () => setEditing(member) },
                  {
                    label: 'Open profile',
                    icon: 'people',
                    onSelect: () => navigate(`/people/${member.personId}`)
                  },
                  ...(member.isMe
                    ? []
                    : ([
                        'separator',
                        {
                          label: 'Remove from project',
                          icon: 'trash' as const,
                          danger: true,
                          onSelect: () => remove.mutate({ id: member.id }),
                          confirm: {
                            title: `Remove ${member.name} from this project?`,
                            body: 'They stay in the workspace and on any other project they are part of.',
                            confirmLabel: 'Remove'
                          }
                        }
                      ] as const))
                ])
              }
            >
              <Avatar name={member.name} color={member.avatarColor} image={member.avatar} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Link to={`/people/${member.personId}`} className="truncate text-[13px] font-medium hover:underline">
                    {member.name}
                  </Link>
                  {member.isMe && (
                    <span className="rounded-full bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary">
                      You
                    </span>
                  )}
                  {member.isEscalation && (
                    <span
                      className="tooltip tooltip-right text-warning"
                      data-tip="Escalation path — go here when it is stuck"
                    >
                      <Icon name="flag" size={11} />
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {member.isMe && !member.role.trim() ? (
                    <button
                      className="text-[11px] text-primary hover:underline"
                      onClick={() => setEditing(member)}
                    >
                      Set your role on this project
                    </button>
                  ) : (
                    <RoleBadges value={member.role} />
                  )}
                  {member.org && <span className="text-[11px] text-base-content/40">{member.org}</span>}
                </div>
                {member.howToWorkWith && (
                  <div className="mt-1 text-[11px] leading-snug text-base-content/45">
                    {member.howToWorkWith}
                  </div>
                )}
                {member.note && (
                  <div className="mt-0.5 text-[11px] leading-snug text-base-content/45">{member.note}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                <button
                  className="btn btn-ghost btn-xs text-base-content/45"
                  onClick={() => setEditing(member)}
                >
                  Edit
                </button>
                {!member.isMe && (
                  <ConfirmButton
                    label="Remove"
                    title={`Remove ${member.name} from this project?`}
                    body="They stay in the workspace and on any other project they are part of."
                    confirmLabel="Remove"
                    onConfirm={() => remove.mutate({ id: member.id })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <CastMemberModal
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
        member={editing}
        projectId={projectId}
        existing={cast.map((c) => c.personId)}
      />
    </Section>
  )
}

interface Form {
  roles: string[]
  isEscalation: boolean
  note: string
}

/**
 * Adding someone starts by looking for them: most of the people on a new project are
 * already somewhere else in the workspace, and retyping their details would create a
 * second, slightly different copy of the same person.
 */
function CastMemberModal({
  open,
  onClose,
  member,
  projectId,
  existing
}: {
  open: boolean
  onClose: () => void
  member: CastMember | null
  projectId: string
  existing: string[]
}): React.JSX.Element {
  const workspace = useWorkspace()
  const people = useApi('person:list', { workspaceId: workspace.id }, { enabled: open })
  const usedRoles = useApi('membership:roles', { workspaceId: workspace.id }, { enabled: open })
  const savePerson = useApiMutation('person:save')
  const saveMembership = useApiMutation('membership:save')

  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Person | null>(null)
  const [creating, setCreating] = useState<{ name: string; org: string; avatarPath: string; avatar: string | null } | null>(null)
  const [form, setForm] = useState<Form>({ roles: [], isEscalation: false, note: '' })

  const original: Form = useMemo(
    () => ({
      roles: parseRoles(member?.role ?? ''),
      isEscalation: member?.isEscalation ?? false,
      note: member?.note ?? ''
    }),
    [member]
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setPicked(null)
    setCreating(null)
    setForm(original)
  }, [open, original])

  const suggestions = useMemo(
    () => [...new Set([...(usedRoles.data ?? []), ...ROLE_SUGGESTIONS])],
    [usedRoles.data]
  )

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (people.data ?? [])
      .filter((p) => !existing.includes(p.id))
      .filter((p) =>
        needle ? p.name.toLowerCase().includes(needle) || p.org.toLowerCase().includes(needle) : true
      )
      .slice(0, 6)
  }, [people.data, existing, query])

  const chosenName = member?.name ?? picked?.name ?? creating?.name ?? ''
  const canSave = Boolean(member || picked || creating?.name.trim())

  const submit = async (): Promise<void> => {
    if (!canSave) return
    let personId = member?.personId ?? picked?.id ?? ''
    if (!personId && creating) {
      const person = await savePerson.mutateAsync({
        workspaceId: workspace.id,
        name: creating.name.trim(),
        org: creating.org,
        avatarPath: creating.avatarPath
      })
      personId = person.id
    }
    if (!personId) return
    await saveMembership.mutateAsync({
      id: member?.id,
      personId,
      projectId,
      role: formatRoles(form.roles),
      isEscalation: form.isEscalation,
      note: form.note
    })
    onClose()
  }

  const reset = (): void => {
    setPicked(null)
    setCreating(null)
    setQuery('')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={member ? (member.isMe ? 'Your role on this project' : `${member.name} on this project`) : 'Add someone to this project'}
      onSubmit={() => void submit()}
      isDirty={differs(form, original) || picked !== null || creating !== null}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!canSave} onClick={() => void submit()}>
            {member ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Step one: who. Skipped entirely when editing an existing membership. */}
        {!member && !picked && !creating && (
          <Field label="Who" hint="Search the people already in this workspace, or add someone new.">
            <input
              autoFocus
              className="input input-bordered w-full"
              placeholder="Start typing a name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="hairline mt-2 overflow-hidden rounded-field border">
              {matches.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className="row-hover hairline flex w-full items-center gap-2.5 border-b px-3 py-2 text-left last:border-b-0"
                  onClick={() => setPicked(person)}
                >
                  <Avatar name={person.name} color={person.avatarColor} image={person.avatar} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{person.name}</span>
                    <span className="block truncate text-[11px] text-base-content/45">
                      {person.org || 'No organisation'} · on {person.projectCount}{' '}
                      {person.projectCount === 1 ? 'project' : 'projects'}
                    </span>
                  </span>
                </button>
              ))}

              <button
                type="button"
                className="row-hover flex w-full items-center gap-2.5 px-3 py-2 text-left"
                onClick={() =>
                  setCreating({ name: query.trim(), org: '', avatarPath: '', avatar: null })
                }
              >
                <span className="flex size-[26px] items-center justify-center rounded-full bg-base-200 text-base-content/50">
                  <Icon name="plus" size={13} />
                </span>
                <span className="text-[13px]">
                  {query.trim() ? (
                    <>
                      Add <span className="font-medium">{query.trim()}</span> as a new person
                    </>
                  ) : (
                    'Add someone new'
                  )}
                </span>
              </button>
            </div>
            {matches.length === 0 && query.trim() && (
              <p className="mt-1.5 text-[11px] text-base-content/40">
                Nobody in {workspace.name} matches that.
              </p>
            )}
          </Field>
        )}

        {/* A person already in the workspace: reuse everything, including the photo. */}
        {!member && picked && (
          <div className="hairline flex items-center gap-3 rounded-field border px-3 py-2.5">
            <Avatar name={picked.name} color={picked.avatarColor} image={picked.avatar} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{picked.name}</div>
              <div className="truncate text-[11px] text-base-content/45">
                {picked.org || 'No organisation'}
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-xs" onClick={reset}>
              Change
            </button>
          </div>
        )}

        {/* Somebody new: only the details a project actually needs up front. */}
        {!member && creating && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <IconPicker
                name={creating.name}
                color="#64748b"
                icon={creating.avatar}
                size={44}
                hint="Optional photo, up to 2 MB."
                onChange={({ iconPath, icon }) =>
                  setCreating({ ...creating, avatarPath: iconPath, avatar: icon })
                }
              />
              <button type="button" className="btn btn-ghost btn-xs" onClick={reset}>
                Back to search
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name">
                <input
                  autoFocus
                  className="input input-bordered w-full"
                  value={creating.name}
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                />
              </Field>
              <Field label="Organisation">
                <input
                  className="input input-bordered w-full"
                  value={creating.org}
                  onChange={(e) => setCreating({ ...creating, org: e.target.value })}
                />
              </Field>
            </div>
          </div>
        )}

        {member && (
          <div className="hairline flex items-center gap-3 rounded-field border px-3 py-2.5">
            <Avatar name={member.name} color={member.avatarColor} image={member.avatar} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{member.name}</div>
              <div className="truncate text-[11px] text-base-content/45">
                {member.org || 'No organisation'}
              </div>
            </div>
            <Link to={member.isMe ? '/settings' : `/people/${member.personId}`} className="btn btn-ghost btn-xs">
              {member.isMe ? 'Edit profile' : 'Open profile'}
            </Link>
          </div>
        )}

        {/* Step two: what they are here. Always editable, whoever they are. */}
        <Field
          label={
            member?.isMe
              ? 'Your roles here'
              : chosenName
                ? `What ${chosenName.split(' ')[0]} is on this project`
                : 'Role on this project'
          }
          hint="Add as many as apply — comma or Enter after each."
        >
          <RoleInput
            roles={form.roles}
            suggestions={suggestions}
            onChange={(roles) => setForm((f) => ({ ...f, roles }))}
          />
        </Field>

        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={form.isEscalation}
            onChange={(e) => setForm((f) => ({ ...f, isEscalation: e.target.checked }))}
          />
          <span>
            Escalation path
            <span className="block text-[11px] text-base-content/45">
              {member?.isMe
                ? 'You are where this escalates to.'
                : 'The person you go to when this project is stuck.'}
            </span>
          </span>
        </label>

        <Field label="Note" hint="Anything specific to their part in this project.">
          <input
            className="input input-bordered w-full"
            placeholder="Signs off the invoices — escalate here, not to their team."
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </Field>
      </div>
    </Modal>
  )
}
