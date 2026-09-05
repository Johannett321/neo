import { useEffect, useMemo, useState } from 'react'
import type { BoardColumn, TaskView } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { differs } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Avatar, ConfirmButton, Field, Modal } from './primitives'
import { DateField } from './DateField'

interface State {
  title: string
  details: string
  assigneePersonId: string
  dueDate: string
  columnId: string
}

const stateFor = (task: TaskView): State => ({
  title: task.title,
  details: task.details,
  assigneePersonId: task.assigneePersonId ?? '',
  dueDate: task.dueDate ?? '',
  columnId: task.columnId ?? ''
})

/**
 * Editing an item. There is no "what kind is this" question, because the answer is
 * already implied by the fields: work someone else owns is delegated, work you own is
 * yours. Asking twice is how the two drift apart.
 */
export function TaskDialog({
  open,
  onClose,
  task,
  columns = []
}: {
  open: boolean
  onClose: () => void
  task: TaskView | null
  columns?: BoardColumn[]
}): React.JSX.Element {
  const workspace = useWorkspace()
  /**
   * The project's cast, not the workspace's people. An item belongs to one project, so
   * the people who can own it are the people on it.
   */
  const people = useApi(
    'person:list',
    { workspaceId: workspace.id, projectId: task?.projectId ?? '' },
    { enabled: open && Boolean(task?.projectId) }
  )
  const save = useApiMutation('task:save')
  const remove = useApiMutation('task:delete')

  const original = useMemo(
    () =>
      task
        ? stateFor(task)
        : ({
            title: '',
            details: '',
            assigneePersonId: '',
            dueDate: '',
            columnId: ''
          } as State),
    [task]
  )
  const [state, setState] = useState<State>(original)

  useEffect(() => {
    if (open) setState(original)
  }, [open, original])

  const set = <K extends keyof State>(key: K, value: State[K]): void =>
    setState((s) => ({ ...s, [key]: value }))

  const me = (people.data ?? []).find((p) => p.isMe)
  const assignee = (people.data ?? []).find((p) => p.id === state.assigneePersonId)

  /**
   * Whoever owns this item today, if they have since been taken off the project. The
   * cast no longer contains them, so without this the picker would show a blank box and
   * saving would quietly hand the item to nobody. Shown, marked, and replaceable — but
   * not silently discarded, because losing an owner is a worse outcome than an odd
   * entry in a list.
   */
  const departed =
    state.assigneePersonId && !assignee && task?.assigneePersonId === state.assigneePersonId
      ? { id: state.assigneePersonId, name: task.assigneeName ?? 'Someone', color: task.assigneeColor }
      : null

  const submit = async (): Promise<void> => {
    if (!task || !state.title.trim()) return
    // Whether it is delegated follows from who owns it, rather than being asked twice.
    const kind = state.assigneePersonId && state.assigneePersonId !== me?.id ? 'delegated' : 'task'

    await save.mutateAsync({
      id: task.id,
      title: state.title.trim(),
      details: state.details,
      kind,
      columnId: state.columnId || null,
      dueDate: state.dueDate || null,
      assigneePersonId: state.assigneePersonId || null
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit item"
      description={task?.projectName}
      onSubmit={() => void submit()}
      isDirty={differs(state, original)}
      footer={
        <>
          {task && (
            <ConfirmButton
              label="Delete"
              title="Delete this item?"
              body={task.title}
              className="btn btn-ghost btn-sm mr-auto text-base-content/50 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: task.id })
                onClose()
              }}
            />
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!state.title.trim()}
            onClick={() => void submit()}
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What needs doing">
          <input
            autoFocus
            className="input input-bordered w-full"
            value={state.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>

        <Field label="Note">
          <textarea
            className="textarea textarea-bordered min-h-20 w-full text-sm"
            value={state.details}
            onChange={(e) => set('details', e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Assigned to">
            <div className="flex items-center gap-2">
              {assignee ? (
                <Avatar
                  name={assignee.name}
                  color={assignee.avatarColor}
                  image={assignee.avatar}
                  size={26}
                />
              ) : (
                departed && (
                  <Avatar name={departed.name} color={departed.color ?? '#64748b'} size={26} />
                )
              )}
              <select
                className="select select-bordered w-full"
                value={state.assigneePersonId}
                onChange={(e) => set('assigneePersonId', e.target.value)}
              >
                <option value="">Nobody yet</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isMe ? 'Me' : p.name}
                  </option>
                ))}
                {departed && (
                  <option value={departed.id}>{departed.name} — no longer on this project</option>
                )}
              </select>
            </div>
          </Field>

          {columns.length > 0 && (
            <Field label="Column">
              <select
                className="select select-bordered w-full"
                value={state.columnId}
                onChange={(e) => set('columnId', e.target.value)}
              >
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Due date">
            <DateField value={state.dueDate} onChange={(v) => set('dueDate', v)} />
          </Field>
        </div>

      </div>
    </Modal>
  )
}
