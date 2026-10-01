import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useContextMenu, type MenuItem } from '@/lib/contextMenu'
import type { BoardColumn, TaskView } from '@shared/types'
import { call, useApiMutation, useRefresh } from '@/lib/api'
import { dueLabel, formatDate, KIND_LABEL, projectColor } from '@/lib/format'
import { EASE } from '@/lib/motion'
import { revealState } from '@/lib/reveal'
import { useGoIn } from '@/lib/workspace'
import { useToast } from '@/lib/toast'
import { Avatar, Dot } from './primitives'
import { Icon, type IconName } from './Icon'

const KIND_ICON = { task: 'check', delegated: 'arrowRight' } as const

/**
 * How long a finished row stays on screen, ticked and struck through, before it is
 * written and folds away. Long enough to *see* the tick land — a row that vanished
 * on the click would leave you wondering whether you hit the one you meant — and
 * short enough that ticking five in a row never waits on the list.
 */
const SETTLE_MS = 420

/**
 * One row shape, used by Today and a project's own Today tab. Reusing it everywhere
 * is what makes different screens feel like the same application.
 *
 * Every list it is drawn in shows open work only, so finishing a row is also the row
 * leaving: it ticks, holds for a beat, folds away (`TaskList`), and says so in a toast
 * with an *Undo* — which puts the card back in the column it left, not merely back to
 * "open", so an In-review card un-ticked does not land in To do.
 */
export function TaskRow({
  task,
  board = [],
  showProject = false,
  showWorkspace = false,
  onEdit
}: {
  task: TaskView
  /** Its own project's board columns, in order; empty when the screen does not know them. */
  board?: BoardColumn[]
  showProject?: boolean
  /**
   * Only on the overview across workspaces, the one screen where rows from different
   * workspaces sit together: the rule down the left and the dot become the workspace's,
   * and its name goes in front of the project's.
   */
  showWorkspace?: boolean
  onEdit?: (task: TaskView) => void
}): React.JSX.Element {
  const setStatus = useApiMutation('task:setStatus')
  const remove = useApiMutation('task:delete')
  const refresh = useRefresh()
  const toast = useToast()
  // Every way out of a row goes through this, so a row on the overview lands in its
  // own workspace rather than drawing its project inside whichever one was active.
  const goIn = useGoIn()
  const go = (path: string, reveal?: string): void =>
    goIn(task.workspaceId, path, reveal ? { state: revealState(reveal) } : undefined)
  const openMenu = useContextMenu()
  /** Told to go, and showing it, while the write waits out `SETTLE_MS`. */
  const [leaving, setLeaving] = useState(false)
  const done = task.status === 'done' || leaving
  // Its project's colour, not its workspace's: every row on a workspace-fenced
  // screen shares the workspace colour, so that one could never tell them apart. On
  // the overview it is the other way round, and the workspace is the identity.
  const colour = showWorkspace ? task.workspaceColor : projectColor(task)
  const overdue = task.daysUntilDue !== null && task.daysUntilDue < 0 && !done
  const dueToday = task.daysUntilDue === 0 && !done
  const column = board.find((c) => c.id === task.columnId) ?? null
  /*
   * Which stage it is at, said only when it is not the first. Every card starts in To
   * do, so naming that on every row is noise; "In review" on one of them is the fact.
   */
  const stage = column && board[0] && column.id !== board[0].id && !column.isDone ? column.name : null

  /*
   * Every write here is a `call`, not the hook's mutation, because the toast's *Undo*
   * runs after the row has gone and has to work with nobody left to hold a hook.
   */
  const putBack = (): void => {
    const was = task.columnId
    void (was
      ? call('task:setColumn', { id: task.id, columnId: was })
      : call('task:setStatus', { id: task.id, status: 'open' })
    ).then(refresh, refresh)
  }

  const said = (title: string, icon: IconName, tone: 'success' | 'neutral'): void =>
    toast({ title, detail: task.title, icon, tone, action: { label: 'Undo', run: putBack } })

  /** Finish with it: tick, hold, write, fold away, offer it back. */
  const leave = (write: () => Promise<unknown>, title: string, icon: IconName, tone: 'success' | 'neutral'): void => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => {
      write().then(
        () => {
          refresh()
          said(title, icon, tone)
        },
        (error: Error) => {
          setLeaving(false)
          toast({ title: 'That did not save', detail: error.message, icon: 'alert', tone: 'neutral' })
        }
      )
    }, SETTLE_MS)
  }

  const complete = (): void => {
    if (task.status === 'done') {
      setStatus.mutate({ id: task.id, status: 'open' })
      return
    }
    leave(() => call('task:setStatus', { id: task.id, status: 'done' }), 'Done', 'check', 'success')
  }

  const moveTo = (target: BoardColumn): void => {
    const write = (): Promise<unknown> => call('task:setColumn', { id: task.id, columnId: target.id })
    // The done column is finishing it by another name, and leaves the same way.
    if (target.isDone) {
      leave(write, `Moved to ${target.name}`, 'check', 'success')
      return
    }
    void write().then(() => {
      refresh()
      said(`Moved to ${target.name}`, 'arrowRight', 'neutral')
    }, refresh)
  }

  /*
   * The stages of its own board, all of them, with the one it is in shown and not
   * pickable — where it is now is half of choosing where it goes. One submenu because
   * this is one question with four answers; flat, they would push everything else
   * in the menu out of reach.
   */
  const stages: MenuItem[] =
    board.length > 0
      ? [
          {
            label: 'Move to',
            icon: 'board',
            items: board.map((c) => ({
              label: c.name,
              icon: (c.id === task.columnId ? 'dot' : c.isDone ? 'check' : 'arrowRight') as IconName,
              disabled: c.id === task.columnId,
              onSelect: () => moveTo(c)
            }))
          }
        ]
      : []

  return (
    <div
      onContextMenu={(e) =>
        openMenu(e, [
          {
            label: task.status === 'done' ? 'Mark as not done' : 'Mark as done',
            icon: 'check',
            disabled: leaving,
            onSelect: complete
          },
          ...stages,
          ...(task.status === 'open'
            ? [
                {
                  // Not doing it is an answer too, and it should leave the list as
                  // decisively as doing it does — without pretending it was done.
                  label: 'Cancel item',
                  icon: 'close' as const,
                  disabled: leaving,
                  onSelect: () =>
                    leave(
                      () => call('task:setStatus', { id: task.id, status: 'cancelled' }),
                      'Cancelled',
                      'close',
                      'neutral'
                    )
                }
              ]
            : []),
          { label: 'Edit…', icon: 'edit', disabled: !onEdit, onSelect: () => onEdit?.(task) },
          'separator',
          /*
           * Where this row actually is, rather than which screen it is somewhere on.
           * A row on Today has been lifted out of its context, and finding it again
           * afterwards — on a board with forty cards, in a write-up with a dozen
           * items — was left entirely to the eye. Both of these land on the thing
           * itself and light it for a beat. See `lib/reveal.ts`.
           *
           * The board first because it is where the card lives now: an item promoted
           * out of a meeting stops being the meeting's to keep, and from then on the
           * card is what says whether it is done.
           */
          {
            label: 'Show on the board',
            icon: 'board',
            onSelect: () => go(`/projects/${task.projectId}/kanban`, task.id)
          },
          ...(task.sourceMeetingId
            ? [
                {
                  label: 'Show in the meeting',
                  icon: 'people' as const,
                  onSelect: () =>
                    go(`/projects/${task.projectId}/meetings/${task.sourceMeetingId}`, task.id)
                }
              ]
            : []),
          // No "Open project": the board *is* the project, at the card. Two ways to the
          // same place, one of them less exact, was a choice the menu made you make.
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
      className="row-hover group flex items-center gap-3 px-3 py-2.5"
      style={showProject || showWorkspace ? { boxShadow: `inset 2px 0 0 ${colour}` } : undefined}
    >
      <button
        className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-base-content/25 text-transparent transition hover:border-primary hover:text-primary/50 data-[done=true]:border-primary data-[done=true]:bg-primary data-[done=true]:text-primary-content"
        data-done={done}
        onClick={complete}
        aria-label={done ? 'Mark as open' : 'Mark as done'}
      >
        <Icon name="check" size={11} strokeWidth={2.4} />
      </button>

      <button
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        onClick={() => onEdit?.(task)}
      >
        <span
          className={`truncate text-sm transition-colors duration-200 ${done ? 'text-base-content/35 line-through' : ''}`}
        >
          {task.title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-base-content/45">
          {showWorkspace ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Dot color={colour} size={5} />
              <span className="shrink-0 text-base-content/60">{task.workspaceName}</span>
              <span className="text-base-content/25">·</span>
              <span className="truncate">{task.projectName}</span>
            </span>
          ) : (
            showProject && (
              <span className="flex min-w-0 items-center gap-1.5">
                <Dot color={colour} size={5} />
                <span className="truncate">{task.projectName}</span>
              </span>
            )
          )}
          {stage && (
            <span className="flex shrink-0 items-center gap-1">
              <Icon name="board" size={10} />
              {stage}
            </span>
          )}
          {task.kind !== 'task' && (
            <span className="flex items-center gap-1">
              <Icon name={KIND_ICON[task.kind]} size={10} />
              {KIND_LABEL[task.kind]}
            </span>
          )}
        </span>
      </button>

      {task.commentCount > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-base-content/35"
          title={task.commentCount === 1 ? '1 comment' : `${task.commentCount} comments`}
        >
          <Icon name="chat" size={11} />
          {task.commentCount}
        </span>
      )}

      {task.assigneeName && (
        <span className="shrink-0" title={`Assigned to ${task.assigneeIsMe ? 'you' : task.assigneeName}`}>
          <Avatar
            name={task.assigneeName}
            color={task.assigneeColor ?? '#64748b'}
            image={task.assigneeAvatar}
            size={20}
          />
        </span>
      )}

      {task.dueDate && (
        <span
          className={`shrink-0 text-xs tabular-nums ${
            overdue ? 'font-medium text-error' : dueToday ? 'font-medium text-warning' : 'text-base-content/40'
          }`}
          title={formatDate(task.dueDate)}
        >
          {dueLabel(task.daysUntilDue)}
        </span>
      )}

      {(showProject || showWorkspace) && (
        <button
          onClick={() => go(`/projects/${task.projectId}`)}
          className="btn btn-ghost btn-xs btn-circle opacity-0 transition group-hover:opacity-100"
          aria-label="Open project"
        >
          <Icon name="chevronRight" size={13} />
        </button>
      )}
    </div>
  )
}

/**
 * A list of rows that come and go. A row that leaves — finished, cancelled, moved to
 * done, or gone because another device did it — folds shut rather than vanishing, so
 * the rows below slide up into its place instead of jumping; one put back by *Undo*
 * opens again where it was.
 */
export function TaskList({
  tasks,
  columns = [],
  showProject = false,
  showWorkspace = false,
  onEdit
}: {
  tasks: TaskView[]
  /** Board columns for the projects these rows belong to, in board order. */
  columns?: BoardColumn[]
  showProject?: boolean
  showWorkspace?: boolean
  onEdit?: (task: TaskView) => void
}): React.JSX.Element {
  const still = useReducedMotion()
  const fold = { duration: still ? 0 : 0.24, ease: EASE }

  return (
    <div className="hairline overflow-hidden rounded-box border bg-base-100">
      <AnimatePresence initial={false}>
        {tasks.map((task) => (
          <motion.div
            key={task.id}
            className="hairline overflow-hidden border-b last:border-b-0"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: fold }}
            exit={{ height: 0, opacity: 0, transition: fold }}
          >
            <TaskRow
              task={task}
              board={columns.filter((c) => c.projectId === task.projectId)}
              showProject={showProject}
              showWorkspace={showWorkspace}
              onEdit={onEdit}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/**
 * A whole section that folds shut the same way, for when its last row leaves. Without
 * it the last tick under "Overdue" took the heading with it in one frame, which is the
 * exact jump the rows were made to avoid.
 */
export function Folding({ open, children }: { open: boolean; children: React.ReactNode }): React.JSX.Element {
  const still = useReducedMotion()
  const fold = { duration: still ? 0 : 0.24, ease: EASE }
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="overflow-hidden"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transition: fold }}
          exit={{ height: 0, opacity: 0, transition: fold }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
