import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CastMember, Person } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { differs, ROLE_SUGGESTIONS } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { Avatar, Field, Modal } from '@/components/primitives'
import { formatRoles, parseRoles, RoleInput } from '@/components/RoleInput'
import { stableKey } from '@/lib/sync'

interface Form {
  roles: string[]
  note: string
}

/**
 * Adding someone starts by looking for them: most of the people on a new project are
 * already somewhere else in the workspace, and retyping their details would create a
 * second, slightly different copy of the same person.
 */
export function CastMemberModal({
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
  const [form, setForm] = useState<Form>({ roles: [], note: '' })

  const original: Form = useMemo(
    () => ({
      roles: parseRoles(member?.role ?? ''),
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

  /*
   * Both writes are drawn at once and sent in order, so the dialog closes on Add. A new
   * person is drawn under a temporary id, and their place on the project names that id;
   * main swaps in the real one when the person comes back (`shared/sync.ts`).
   */
  const submit = (): void => {
    if (!canSave) return
    let personId = member?.personId ?? picked?.id ?? ''
    if (!personId && creating) {
      const person = savePerson.mutate({
        workspaceId: workspace.id,
        name: creating.name.trim(),
        org: creating.org,
        avatarPath: creating.avatarPath
      })
      personId = person?.id ?? ''
    }
    if (!personId) return
    saveMembership.mutate({
      id: member?.id,
      personId,
      projectId,
      role: formatRoles(form.roles),
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
                  key={stableKey(person.id)}
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
