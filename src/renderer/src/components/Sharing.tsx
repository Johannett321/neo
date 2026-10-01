import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Workspace, WorkspaceInviteCreated, WorkspaceMember } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { plural, relativeFromIso } from '@/lib/format'
import { useWorkspaces } from '@/lib/workspace'
import { Icon } from './Icon'
import { Avatar, ConfirmButton, Field, Modal, Panel } from './primitives'
import { WORKSPACE_COLORS } from './WorkspaceModal'

/*
 * Sharing a workspace: the whole of it or nothing. Everybody in a workspace sees and
 * edits everything in it; the owner is the one who invites, removes, renames and
 * deletes. An invitation is a link, good for one person for seven days, shown once —
 * Neo Cloud keeps only a hash of it and sends no email, so the link is what you send.
 */

/** IPC keeps only an error's message, prefixed with where it came from. */
export function said(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** A person's colour, the same every time, from the palette people already wear. */
function colorFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length] as string
}

export function MemberAvatar({ member, size = 28 }: { member: WorkspaceMember; size?: number }): React.JSX.Element {
  return <Avatar name={member.name} color={colorFor(member.accountId)} size={size} />
}

/**
 * The quiet sign that a workspace is shared: who else is in it, as a few overlapping
 * faces. Nothing at all for a workspace that is only yours — the default stays silent.
 */
export function AvatarStack({
  workspace,
  size = 16,
  max = 3
}: {
  workspace: Workspace
  size?: number
  max?: number
}): React.JSX.Element | null {
  const others = workspace.members.filter((m) => !m.isMe)
  if (others.length === 0) return null
  const shown = others.slice(0, max)
  const rest = others.length - shown.length
  return (
    <span
      className="flex shrink-0 items-center"
      title={`Shared with ${others.map((m) => m.name).join(', ')}`}
      aria-label={`Shared with ${plural(others.length, 'person', 'people')}`}
    >
      {shown.map((member, i) => (
        <span key={member.accountId} className="rounded-full ring-2 ring-base-100" style={{ marginLeft: i ? -size / 3 : 0 }}>
          <MemberAvatar member={member} size={size} />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-[10px] text-base-content/45">+{rest}</span>}
    </span>
  )
}

function expiresIn(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
  return days <= 1 ? 'expires within a day' : `expires in ${days} days`
}

/**
 * Who is in this workspace, and the door in. The owner sees the invite form, the
 * people with a remove beside each, and the links still waiting; a member sees the
 * people and the way out.
 */
export function MembersPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const owner = workspace.role === 'owner'
  const members = useApi('workspace:members', { workspaceId: workspace.id })
  const invites = useApi('workspace:invites', { workspaceId: workspace.id }, { enabled: owner })
  const remove = useApiMutation('workspace:removeMember')
  const revoke = useApiMutation('workspace:revokeInvite')
  const { workspaces, switchTo } = useWorkspaces()
  const navigate = useNavigate()

  const people = members.data ?? workspace.members
  const ownerName = people.find((m) => m.role === 'owner')?.name ?? 'the owner'
  const pending = owner ? (invites.data ?? []) : []

  const leave = async (me: WorkspaceMember): Promise<void> => {
    await remove.mutateAsync({ workspaceId: workspace.id, accountId: me.accountId })
    const next = workspaces.find((w) => w.id !== workspace.id)
    if (next) switchTo(next.id)
    navigate('/')
  }

  return (
    <div className="space-y-4">
      {owner && <InviteForm workspace={workspace} />}

      <Panel padded={false}>
        <div className="flex items-baseline justify-between px-4 pb-2 pt-3.5">
          <span className="text-[13px] font-medium">People in {workspace.name}</span>
          <span className="text-[11px] text-base-content/40">{plural(people.length, 'person', 'people')}</span>
        </div>
        <ul>
          {people.map((member) => (
            <li key={member.accountId} className="hairline flex items-center gap-3 border-t px-4 py-2.5">
              <MemberAvatar member={member} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">
                  {member.name}
                  {member.isMe && <span className="ml-1.5 text-base-content/40">you</span>}
                </span>
                <span className="block truncate text-[11px] text-base-content/45">
                  {member.handle} · joined {relativeFromIso(member.joinedAt)}
                </span>
              </span>
              {member.role === 'owner' && (
                <span className="badge badge-sm badge-ghost text-[10.5px] text-base-content/60">Owner</span>
              )}
              {owner && !member.isMe && (
                <ConfirmButton
                  label="Remove"
                  title={`Remove ${member.name} from ${workspace.name}?`}
                  body="They lose access at once. The work they did stays here; their conversations with the assistant about it go with them. You can invite them again."
                  onConfirm={() => remove.mutate({ workspaceId: workspace.id, accountId: member.accountId })}
                />
              )}
              {!owner && member.isMe && (
                <ConfirmButton
                  label="Leave"
                  title={`Leave ${workspace.name}?`}
                  body={`It disappears from your switcher. What you did in it stays, and ${ownerName} can invite you back.`}
                  onConfirm={() => void leave(member)}
                />
              )}
            </li>
          ))}
        </ul>
      </Panel>

      {pending.length > 0 && (
        <Panel padded={false}>
          <div className="px-4 pb-2 pt-3.5 text-[13px] font-medium">Waiting to be accepted</div>
          <ul>
            {pending.map((invite) => (
              <li key={invite.id} className="hairline flex items-center gap-3 border-t px-4 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-base-200">
                  <Icon name="link" size={13} className="text-base-content/50" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    {invite.email || <span className="text-base-content/60">Anyone with the link</span>}
                  </span>
                  <span className="block text-[11px] text-base-content/45">
                    Made {relativeFromIso(invite.createdAt)} · {expiresIn(invite.expiresAt)}
                  </span>
                </span>
                <ConfirmButton
                  label="Revoke"
                  title="Revoke this invitation?"
                  body="The link stops working at once. Nobody who already joined is affected."
                  onConfirm={() => revoke.mutate({ workspaceId: workspace.id, inviteId: invite.id })}
                />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {!owner && (
        <p className="px-1 text-[11.5px] leading-relaxed text-base-content/45">
          {ownerName} owns this workspace, so only they can invite people, rename it or delete it. Everything
          else in it is yours to work on.
        </p>
      )}
    </div>
  )
}

function InviteForm({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const invite = useApiMutation('workspace:invite')
  const [email, setEmail] = useState('')
  const [created, setCreated] = useState<WorkspaceInviteCreated | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setCreated(null)
    setEmail('')
  }, [workspace.id])

  const copy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // The link is selectable in the field beside the button, which is the fallback.
    }
  }

  const make = async (): Promise<void> => {
    const result = await invite.mutateAsync({ workspaceId: workspace.id, email })
    setCreated(result)
    setEmail('')
    void copy(result.url)
  }

  return (
    <Panel>
      <div className="text-[13px] font-medium">Invite people</div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
        They see and edit everything in {workspace.name}. Each link lets one person in, for seven days.
      </p>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void make().catch(() => {})
        }}
      >
        <input
          type="email"
          className="input input-bordered input-sm min-w-0 flex-1"
          placeholder="Their email, to remember who it was for (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn btn-primary btn-sm gap-1.5" disabled={invite.isPending}>
          <Icon name="link" size={13} />
          Create invite link
        </button>
      </form>
      {invite.error && <p className="mt-2 text-[12px] text-error">{said(invite.error)}</p>}

      {created && (
        <div className="hairline mt-3 rounded-field border bg-base-200/50 p-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="input input-sm min-w-0 flex-1 bg-base-100 font-mono text-[11.5px]"
              value={created.url}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-sm gap-1.5" onClick={() => void copy(created.url)}>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-base-content/50">
            {created.invite.email ? `For ${created.invite.email}. ` : ''}
            Send it however you like — Neo does not email it. They paste it into{' '}
            <span className="text-base-content/70">Join a workspace</span> in their workspace switcher. This is the only
            time the link is shown.
          </p>
        </div>
      )}
    </Panel>
  )
}

/** Paste the link somebody sent you, and the workspace appears in your switcher. */
export function JoinWorkspaceModal({
  open,
  onClose,
  onJoined
}: {
  open: boolean
  onClose: () => void
  onJoined: (workspace: Workspace) => void
}): React.JSX.Element {
  const accept = useApiMutation('workspace:acceptInvite')
  const [link, setLink] = useState('')

  useEffect(() => {
    if (open) {
      setLink('')
      accept.reset()
    }
  }, [open])

  const join = async (): Promise<void> => {
    if (!link.trim()) return
    const workspace = await accept.mutateAsync({ token: link.trim() })
    onJoined(workspace)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Join a workspace"
      description="Paste the invite link someone sent you. You will see and work on everything in their workspace."
      onSubmit={() => void join().catch(() => {})}
      isDirty={link.trim() !== ''}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!link.trim() || accept.isPending}
            onClick={() => void join().catch(() => {})}
          >
            Join workspace
          </button>
        </>
      }
    >
      <Field label="Invite link">
        <input
          autoFocus
          className="input input-bordered w-full font-mono text-[12px]"
          placeholder="https://sync.neomoon.io/invite/…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
      </Field>
      {accept.error && <p className="mt-2 text-[12px] text-error">{said(accept.error)}</p>}
    </Modal>
  )
}
