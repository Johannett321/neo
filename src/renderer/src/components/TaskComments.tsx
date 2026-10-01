import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TaskComment } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { timeAgo } from '@/lib/format'
import { useToast } from '@/lib/toast'
import { Avatar } from './primitives'
import { Markdown } from './Markdown'

/**
 * A stable colour per author for the initials, since a comment carries a name and a
 * photo but no colour of its own. The same name always lands on the same one, so a
 * thread of six replies between two people reads as two faces, not six.
 */
const COLOURS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316']
const colourOf = (name: string): string => {
  let n = 0
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return COLOURS[n % COLOURS.length] as string
}

const isSend = (e: React.KeyboardEvent): boolean => e.key === 'Enter' && (e.metaKey || e.ctrlKey)

interface Pending {
  key: number
  body: string
}

/**
 * The conversation on a card: what happened to the work since the card was written,
 * oldest at the top so it reads as it was said, and the composer at the bottom where
 * the next line goes.
 *
 * It sits inside the task dialog's form, so nothing in it may submit that form: every
 * button is `type="button"`, and ⌘Enter is caught here before the dialog sees it.
 *
 * A comment appears the moment it is sent, faded until Neo Cloud has it — the thread is
 * where you are looking, and a box that empties with nothing appearing for a beat
 * reads as lost. If the send fails the words go back in the box.
 */
export function TaskComments({
  taskId,
  onDraftChange
}: {
  taskId: string
  /** Whether something is typed and unsent, so the dialog can ask before throwing it away. */
  onDraftChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const client = useQueryClient()
  const toast = useToast()
  const comments = useApi('taskComment:list', { taskId })
  const profile = useApi('profile:get')
  const save = useApiMutation('taskComment:save')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const nextKey = useRef(0)

  useEffect(() => onDraftChange?.(draft.trim().length > 0), [draft, onDraftChange])

  const list = comments.data ?? []
  const count = list.length + pending.length

  // A new line in the thread is the thing to look at: keep the bottom in view.
  useEffect(() => {
    if (pending.length > 0) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [pending.length])

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body) return
    const key = nextKey.current++
    setPending((p) => [...p, { key, body }])
    setDraft('')
    try {
      const saved = await save.mutateAsync({ taskId, body })
      // Into the cache before the faded copy goes, so there is no frame without it.
      client.setQueryData<TaskComment[]>(['taskComment:list', { taskId }], (old) =>
        old && !old.some((c) => c.id === saved.id) ? [...old, saved] : old
      )
    } catch (error) {
      setDraft((current) => (current ? `${body}\n\n${current}` : body))
      toast({
        title: 'That comment was not sent',
        detail: (error as Error).message || 'It is back in the box to try again.',
        icon: 'alert'
      })
    } finally {
      setPending((p) => p.filter((x) => x.key !== key))
    }
  }

  const me = profile.data

  return (
    <section className="hairline -mx-5 mt-5 border-t px-5 pt-4">
      <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-base-content/45">
        Comments
        {count > 0 && (
          <span className="rounded-full bg-base-content/8 px-1.5 py-px text-[10px] font-medium tabular-nums text-base-content/55">
            {count}
          </span>
        )}
      </h4>

      {count > 0 && (
        <ol className="mb-4 max-h-[320px] space-y-3.5 overflow-y-auto">
          {list.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              editing={editing === comment.id}
              onEdit={() => setEditing(comment.id)}
              onDone={() => setEditing(null)}
            />
          ))}
          {pending.map((p) => (
            <li key={`pending-${p.key}`} className="flex gap-2.5 opacity-55">
              <Avatar name={me?.name ?? 'Me'} color={colourOf(me?.name ?? 'Me')} image={me?.avatar} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-medium">{me?.name ?? 'Me'}</span>
                  <span className="text-[11px] text-base-content/40">Sending…</span>
                </div>
                <Markdown source={p.body} className="mt-0.5 text-[13px]" />
              </div>
            </li>
          ))}
          <div ref={endRef} />
        </ol>
      )}

      <div className="flex items-start gap-2.5">
        <Avatar name={me?.name ?? 'Me'} color={colourOf(me?.name ?? 'Me')} image={me?.avatar} size={24} />
        <div className="hairline min-w-0 flex-1 rounded-field border bg-base-100 focus-within:border-base-content/30">
          <textarea
            rows={draft.includes('\n') ? 3 : 1}
            value={draft}
            placeholder={count > 0 ? 'Reply…' : 'Write a comment…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isSend(e)) {
                e.preventDefault()
                e.stopPropagation()
                void send()
              }
            }}
            className="block max-h-40 min-h-[34px] w-full resize-y bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none"
          />
          {draft.trim() && (
            <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
              <span className="text-[10px] text-base-content/35">⌘↵</span>
              <button type="button" className="btn btn-primary btn-xs" onClick={() => void send()}>
                Comment
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function CommentItem({
  comment,
  editing,
  onEdit,
  onDone
}: {
  comment: TaskComment
  editing: boolean
  onEdit: () => void
  onDone: () => void
}): React.JSX.Element {
  const save = useApiMutation('taskComment:save')
  const remove = useApiMutation('taskComment:delete')
  const openMenu = useContextMenu()
  const [body, setBody] = useState(comment.body)

  useEffect(() => {
    if (editing) setBody(comment.body)
  }, [editing, comment.body])

  const commit = async (): Promise<void> => {
    const next = body.trim()
    if (!next || next === comment.body) return onDone()
    await save.mutateAsync({ id: comment.id, body: next })
    onDone()
  }

  return (
    <li
      className="group flex gap-2.5"
      onContextMenu={
        comment.isMine
          ? (e) =>
              openMenu(e, [
                { label: 'Edit…', icon: 'edit', onSelect: onEdit },
                'separator',
                {
                  label: 'Delete comment',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => remove.mutate({ id: comment.id }),
                  confirm: { title: 'Delete this comment?', body: comment.body.slice(0, 140) }
                }
              ])
          : undefined
      }
    >
      <Avatar
        name={comment.authorName || 'Someone'}
        color={colourOf(comment.authorName || 'Someone')}
        image={comment.authorAvatar}
        size={24}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="font-medium">{comment.authorName || 'Someone'}</span>
          <span className="text-[11px] text-base-content/40" title={new Date(comment.createdAt).toLocaleString()}>
            {timeAgo(comment.createdAt)}
            {comment.editedAt && ' · edited'}
          </span>
          {comment.isMine && !editing && (
            <span className="ml-auto flex gap-1 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                className="text-[11px] text-base-content/40 hover:text-base-content"
                onClick={onEdit}
              >
                Edit
              </button>
            </span>
          )}
        </div>

        {editing ? (
          <div className="mt-1">
            <textarea
              autoFocus
              rows={Math.min(8, Math.max(2, body.split('\n').length))}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (isSend(e)) {
                  e.preventDefault()
                  e.stopPropagation()
                  void commit()
                } else if (e.key === 'Escape') {
                  // Leaving the edit, not the dialog.
                  e.preventDefault()
                  e.stopPropagation()
                  onDone()
                }
              }}
              className="textarea textarea-bordered w-full text-[13px] leading-relaxed"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost btn-xs" onClick={onDone}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-xs"
                disabled={!body.trim()}
                onClick={() => void commit()}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <Markdown source={comment.body} className="mt-0.5 text-[13px]" />
        )}
      </div>
    </li>
  )
}
