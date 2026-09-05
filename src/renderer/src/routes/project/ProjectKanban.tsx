import { useState } from 'react'
import type { BoardColumn, TaskView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { dueLabel, KIND_LABEL } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { Avatar, ConfirmButton } from '@/components/primitives'
import { CreateDialog } from '@/components/CreateDialog'
import { TaskDialog } from '@/components/TaskDialog'
import { useProject } from './ProjectLayout'

const KIND_ICON = { task: 'check', delegated: 'arrowRight' } as const

function Card({
  task,
  columns,
  onEdit,
  onDragStart
}: {
  task: TaskView
  columns: BoardColumn[]
  onEdit: () => void
  onDragStart: () => void
}): React.JSX.Element {
  const setColumn = useApiMutation('task:setColumn')
  const setStatus = useApiMutation('task:setStatus')
  const remove = useApiMutation('task:delete')
  const openMenu = useContextMenu()
  const overdue = task.daysUntilDue !== null && task.daysUntilDue < 0 && task.status !== 'done'

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onEdit}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Edit…', icon: 'edit', onSelect: onEdit },
          {
            label: task.status === 'done' ? 'Mark as not done' : 'Mark as done',
            icon: 'check',
            onSelect: () =>
              setStatus.mutate({ id: task.id, status: task.status === 'done' ? 'open' : 'done' })
          },
          'separator',
          ...columns
            .filter((c) => c.id !== task.columnId)
            .map((c) => ({
              label: `Move to ${c.name}`,
              icon: 'arrowRight' as const,
              onSelect: () => setColumn.mutate({ id: task.id, columnId: c.id })
            })),
          'separator',
          {
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: () => remove.mutate({ id: task.id }),
            confirm: { title: 'Delete this item?', body: task.title }
          }
        ])
      }
      className="hairline row-hover cursor-grab rounded-field border bg-base-100 px-2.5 py-2 active:cursor-grabbing"
    >
      <div className={`text-[12px] leading-snug ${task.status === 'done' ? 'text-base-content/40' : ''}`}>
        {task.title}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-base-content/45">
        {task.kind !== 'task' && (
          <span className="flex items-center gap-1">
            <Icon name={KIND_ICON[task.kind]} size={9} />
            {KIND_LABEL[task.kind]}
          </span>
        )}
        {task.assigneeName && (
          <span className="flex items-center gap-1" title={`Assigned to ${task.assigneeName}`}>
            <Avatar
              name={task.assigneeName}
              color={task.assigneeColor ?? '#64748b'}
              image={task.assigneeAvatar}
              size={14}
            />
            {task.assigneeIsMe ? 'Me' : task.assigneeName.split(' ')[0]}
          </span>
        )}
        {task.dueDate && (
          <span className={`ml-auto tabular-nums ${overdue ? 'font-medium text-error' : ''}`}>
            {dueLabel(task.daysUntilDue)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The columns belong to the project, not to the app — a build pipeline and a client
 * engagement do not move through the same stages. An empty board still shows its
 * columns, because the columns are the thing you are looking at before there is
 * anything in them.
 */
export function ProjectKanban(): React.JSX.Element {
  const { project, columns, tasks } = useProject()
  const setColumn = useApiMutation('task:setColumn')
  const saveColumn = useApiMutation('column:save')
  const deleteColumn = useApiMutation('column:delete')
  const reorderColumns = useApiMutation('column:reorder')

  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [editing, setEditing] = useState<TaskView | null>(null)
  /**
   * Which column a new card is going into. `''` is the board's own button, which
   * lands in the first column the way it always has; a column id is the `+` on that
   * column's own header. Capturing straight into the stage you are looking at saves
   * the drag that otherwise always follows.
   */
  const [adding, setAdding] = useState<string | null>(null)
  const [addingColumn, setAddingColumn] = useState(false)
  const [newColumn, setNewColumn] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const drop = (columnId: string): void => {
    if (dragging) setColumn.mutate({ id: dragging, columnId })
    setDragging(null)
    setOver(null)
  }

  const moveColumn = (index: number, delta: number): void => {
    const next = [...columns]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    reorderColumns.mutate({ ids: next.map((c) => c.id) })
    setMenuFor(null)
  }

  const addColumn = (): void => {
    if (!newColumn.trim()) return
    saveColumn.mutate({ projectId: project.id, name: newColumn.trim() })
    setNewColumn('')
    setAddingColumn(false)
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setAdding('')}>
          <Icon name="plus" size={13} />
          Add item
        </button>
        <span className="ml-auto text-[11px] text-base-content/35">Drag a card to move it</span>
      </div>

      {/* Columns share the width available and only scroll once they would be
          too narrow to read, so the board grows with the window. */}
      <div className="scroll-area -mx-1 overflow-x-auto px-1 pb-2">
        <div className="flex min-w-full items-stretch gap-3">
          {columns.map((column, index) => (
            <BoardColumnView
              key={column.id}
              column={column}
              index={index}
              total={columns.length}
              tasks={tasks.filter((t) => t.columnId === column.id)}
              isOver={over === column.id}
              menuOpen={menuFor === column.id}
              onMenuToggle={() => setMenuFor((c) => (c === column.id ? null : column.id))}
              onMenuClose={() => setMenuFor(null)}
              onDragOver={() => setOver(column.id)}
              onDragLeave={() => setOver(null)}
              onDrop={() => drop(column.id)}
              onRename={(name) => saveColumn.mutate({ id: column.id, name })}
              onMarkDone={() => saveColumn.mutate({ id: column.id, isDone: true })}
              onMove={(delta) => moveColumn(index, delta)}
              onDelete={() => deleteColumn.mutate({ id: column.id })}
              onEditTask={setEditing}
              onAddTask={() => setAdding(column.id)}
              onDragStartTask={setDragging}
              allColumns={columns}
            />
          ))}

          {addingColumn ? (
            <div className="hairline w-[180px] shrink-0 self-start rounded-box border bg-base-100 p-2">
              <input
                autoFocus
                className="input input-bordered input-sm w-full"
                placeholder="Column name…"
                value={newColumn}
                onChange={(e) => setNewColumn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addColumn()
                  if (e.key === 'Escape') {
                    setAddingColumn(false)
                    setNewColumn('')
                  }
                }}
              />
              <div className="mt-2 flex gap-1.5">
                <button className="btn btn-primary btn-xs flex-1" onClick={addColumn}>
                  Add
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    setAddingColumn(false)
                    setNewColumn('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            // Deliberately not column-shaped: it is an action, not a place cards go.
            <button
              className="tooltip tooltip-right btn btn-ghost btn-sm btn-circle shrink-0 self-start text-base-content/35 hover:text-base-content"
              data-tip="Add column"
              onClick={() => setAddingColumn(true)}
              aria-label="Add column"
            >
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
      </div>

      <CreateDialog
        open={adding !== null}
        onClose={() => setAdding(null)}
        projectId={project.id}
        columnId={adding || undefined}
        only="task"
      />
      <TaskDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        task={editing}
        columns={columns}
      />
    </div>
  )
}

function BoardColumnView({
  column,
  index,
  total,
  tasks,
  isOver,
  menuOpen,
  onMenuToggle,
  onMenuClose,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onMarkDone,
  onMove,
  onDelete,
  onEditTask,
  onAddTask,
  onDragStartTask,
  allColumns
}: {
  column: BoardColumn
  index: number
  total: number
  tasks: TaskView[]
  isOver: boolean
  menuOpen: boolean
  onMenuToggle: () => void
  onMenuClose: () => void
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: () => void
  onRename: (name: string) => void
  onMarkDone: () => void
  onMove: (delta: number) => void
  onDelete: () => void
  onEditTask: (task: TaskView) => void
  onAddTask: () => void
  onDragStartTask: (id: string) => void
  allColumns: BoardColumn[]
}): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const openMenu = useContextMenu()

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Add an item here', icon: 'plus', onSelect: onAddTask },
          'separator',
          { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) },
          { label: 'Move left', icon: 'arrowLeft', disabled: index === 0, onSelect: () => onMove(-1) },
          {
            label: 'Move right',
            icon: 'arrowRight',
            disabled: index === total - 1,
            onSelect: () => onMove(1)
          },
          ...(column.isDone
            ? []
            : [
                {
                  label: 'Mark as the done column',
                  icon: 'check' as const,
                  onSelect: onMarkDone
                }
              ]),
          'separator',
          {
            label: 'Delete column',
            icon: 'trash',
            danger: true,
            onSelect: onDelete,
            confirm: {
              title: `Delete "${column.name}"?`,
              body:
                tasks.length > 0
                  ? `Its ${tasks.length === 1 ? 'card moves' : `${tasks.length} cards move`} to the first column. Nothing is lost.`
                  : 'The column is empty, so nothing moves.',
              confirmLabel: 'Delete column'
            }
          }
        ])
      }
      className={`group/column min-w-[190px] max-w-[340px] flex-1 rounded-box border p-2 transition ${
        isOver ? 'border-primary/50 bg-primary/[0.05]' : 'hairline bg-base-200/40'
      }`}
    >
      <div className="relative mb-2 flex items-center gap-1.5 px-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={column.name}
            className="input input-bordered input-xs w-full"
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== column.name) onRename(e.target.value.trim())
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <>
            <span
              className="cursor-text truncate rounded px-1 py-0.5 -mx-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-base-content/50 transition hover:bg-base-content/[0.06] hover:text-base-content/80"
              title="Double-click to rename"
              onDoubleClick={() => setRenaming(true)}
            >
              {column.name}
            </span>
            {column.isDone && (
              <span className="tooltip text-success" data-tip="Cards here count as done">
                <Icon name="check" size={11} />
              </span>
            )}
            <span className="text-[11px] tabular-nums text-base-content/30">{tasks.length}</span>

            {/* Quiet until the pointer is on the column, because four of these
                competing with the board's own button would be four primary actions. */}
            <button
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-field text-base-content/45 opacity-0 transition hover:bg-base-content/10 hover:text-base-content focus-visible:opacity-100 group-hover/column:opacity-100"
              onClick={onAddTask}
              title={`Add an item to ${column.name}`}
              aria-label={`Add an item to ${column.name}`}
            >
              <Icon name="plus" size={14} />
            </button>

            <button
              className={`flex size-6 shrink-0 items-center justify-center rounded-field text-base-content/45 transition hover:bg-base-content/10 hover:text-base-content ${
                menuOpen ? 'bg-base-content/10 text-base-content' : ''
              }`}
              onClick={onMenuToggle}
              title="Rename, reorder or delete this column"
              aria-label={`${column.name} options`}
            >
              <Icon name="more" size={15} />
            </button>
          </>
        )}

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={onMenuClose} />
            <div className="rise hairline absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-box border bg-base-100 py-1 shadow-xl shadow-black/10">
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-base-200"
                onClick={() => {
                  setRenaming(true)
                  onMenuClose()
                }}
              >
                <Icon name="edit" size={12} className="opacity-55" />
                Rename
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-base-200 disabled:opacity-35"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <Icon name="arrowLeft" size={12} className="opacity-55" />
                Move left
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-base-200 disabled:opacity-35"
                disabled={index === total - 1}
                onClick={() => onMove(1)}
              >
                <Icon name="arrowRight" size={12} className="opacity-55" />
                Move right
              </button>
              {!column.isDone && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-base-200"
                  onClick={() => {
                    onMarkDone()
                    onMenuClose()
                  }}
                >
                  <Icon name="check" size={12} className="opacity-55" />
                  Mark as the done column
                </button>
              )}
              <div className="hairline my-1 border-t" />
              <div className="px-2 pb-1">
                <ConfirmButton
                  label="Delete column"
                  title={`Delete "${column.name}"?`}
                  body={
                    tasks.length > 0
                      ? `Its ${tasks.length === 1 ? 'card moves' : `${tasks.length} cards move`} to the first column. Nothing is lost.`
                      : 'The column is empty, so nothing moves.'
                  }
                  confirmLabel="Delete column"
                  className="btn btn-ghost btn-xs w-full justify-start text-base-content/55 hover:text-error"
                  onConfirm={() => {
                    onDelete()
                    onMenuClose()
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="min-h-[5rem] space-y-1.5">
        {tasks.map((task) => (
          <Card
            key={task.id}
            task={task}
            columns={allColumns}
            onEdit={() => onEditTask(task)}
            onDragStart={() => onDragStartTask(task.id)}
          />
        ))}
        {/* An empty column was dead space you could only drop onto. It is the most
            obvious place to put the first card, so it now says so. */}
        {tasks.length === 0 && (
          <button
            className="hairline flex h-[4.5rem] w-full items-center justify-center gap-1.5 rounded-field border border-dashed text-[11px] text-base-content/30 transition hover:border-base-content/25 hover:text-base-content/55"
            onClick={onAddTask}
          >
            <Icon name="plus" size={12} />
            Add an item
          </button>
        )}
      </div>
    </div>
  )
}
