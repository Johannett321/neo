/**
 * What is worth interrupting you about, and how it is worded.
 *
 * The sibling of `attention.ts`, and built on the same rule: everything here is read
 * off the work — a project's deadline, a card's due date — so there is nothing to
 * create, snooze, dismiss or keep true by hand. A reminder you have to maintain is a
 * status field with an alarm attached to it, which is the one thing this app has
 * decided not to have.
 *
 * Two further decisions are load-bearing, and both are about restraint:
 *
 * **One notification per kind, not one per item.** Three cards due tomorrow produce
 * "3 items are due tomorrow", once. An app that puts nine cards in the notification
 * centre is an app whose notifications you switch off, and then it has none.
 *
 * **An exact day, never a window.** A warning fires on the morning that is exactly N
 * days before the date, and on no other morning. A window would fire again every day
 * until the deadline arrived, which is nagging; and a fact that is true for a week is
 * the sort of thing Today is for, where you go and look rather than being told.
 *
 * Everything in here is pure. It takes rows and preferences and returns sentences,
 * so what the app would say on any given morning can be asserted without a database,
 * a window or a desktop.
 */
import type { NotificationKind, PendingNotification } from '@shared/types'
import { addDays } from '../db/client'

/** How this workspace has been told to behave. Zero days means never, in both cases. */
export interface NotifyPrefs {
  projectAheadDays: number
  projectOnTheDay: boolean
  taskAheadDays: number
  taskOnTheDay: boolean
  taskDayAfter: boolean
}

export interface NotifyProject {
  id: string
  name: string
  /** YYYY-MM-DD; only projects that have one are ever passed in. */
  deadline: string
}

export interface NotifyTask {
  id: string
  title: string
  dueDate: string
  projectId: string
  projectName: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "tomorrow" reads as a day; "in 1 day" reads as arithmetic. */
const ahead = (days: number): string => (days === 1 ? 'tomorrow' : `in ${plural(days, 'day')}`)

/**
 * Up to two names and then a count. Two is where a notification stops being a
 * sentence you read at a glance and starts being a list you have to work through —
 * and the list itself is one click away in either case.
 */
function names(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`
}

/**
 * Where clicking it puts you. A group that is entirely inside one project opens that
 * project, because that is where every one of those items is; anything spread across
 * two opens Today, which is the screen that already draws exactly this list.
 */
function pathFor(projectIds: string[]): string {
  const distinct = [...new Set(projectIds)]
  return distinct.length === 1 ? `/projects/${distinct[0]}` : '/'
}

export interface NotifyInput {
  /** The morning being decided about, as YYYY-MM-DD. */
  on: string
  workspaceId: string
  workspaceName: string
  prefs: NotifyPrefs
  /** Live, active projects that have a deadline. */
  projects: NotifyProject[]
  /** Open items with a due date, from projects that are not paused or archived. */
  tasks: NotifyTask[]
}

/**
 * Everything this workspace would say on this morning, in the order it would say it:
 * what is already late, then what is due, then what is coming. An ordinary day
 * returns nothing at all, and that is the answer this is tuned to give.
 */
export function dueNotifications(input: NotifyInput): PendingNotification[] {
  const { on, prefs, workspaceId, workspaceName } = input
  const out: PendingNotification[] = []

  const add = (
    kind: NotificationKind,
    title: string,
    detail: string,
    projectIds: string[]
  ): void => {
    out.push({
      kind,
      workspaceId,
      title,
      // The working life is always the last thing said, because the notification
      // arrives on a desktop where all of them are running at once and "whose
      // deadline is this" is the first question you would ask of it.
      body: detail ? `${detail} · ${workspaceName}` : workspaceName,
      path: pathFor(projectIds),
      count: projectIds.length
    })
  }

  /* -------------------------------------------------------------- already late */

  if (prefs.taskDayAfter) {
    const yesterday = addDays(on, -1)
    const late = input.tasks.filter((t) => t.dueDate === yesterday)
    if (late.length === 1 && late[0]) {
      add('task-after', `${late[0].title} was due yesterday`, late[0].projectName, [late[0].projectId])
    } else if (late.length > 1) {
      add('task-after', `${plural(late.length, 'item')} were due yesterday`,
          names(late.map((t) => t.title)), late.map((t) => t.projectId))
    }
  }

  /* ------------------------------------------------------------------- due today */

  if (prefs.projectOnTheDay) {
    const due = input.projects.filter((p) => p.deadline === on)
    if (due.length === 1 && due[0]) {
      add('project-day', `${due[0].name}'s deadline is today`, '', [due[0].id])
    } else if (due.length > 1) {
      add('project-day', `${plural(due.length, 'project deadline')} are today`,
          names(due.map((p) => p.name)), due.map((p) => p.id))
    }
  }

  if (prefs.taskOnTheDay) {
    const due = input.tasks.filter((t) => t.dueDate === on)
    if (due.length === 1 && due[0]) {
      add('task-day', `${due[0].title} is due today`, due[0].projectName, [due[0].projectId])
    } else if (due.length > 1) {
      add('task-day', `${plural(due.length, 'item')} are due today`,
          names(due.map((t) => t.title)), due.map((t) => t.projectId))
    }
  }

  /* --------------------------------------------------------------------- coming */

  if (prefs.taskAheadDays > 0) {
    const when = addDays(on, prefs.taskAheadDays)
    const soon = input.tasks.filter((t) => t.dueDate === when)
    if (soon.length === 1 && soon[0]) {
      add('task-ahead', `${soon[0].title} is due ${ahead(prefs.taskAheadDays)}`,
          soon[0].projectName, [soon[0].projectId])
    } else if (soon.length > 1) {
      add('task-ahead', `${plural(soon.length, 'item')} are due ${ahead(prefs.taskAheadDays)}`,
          names(soon.map((t) => t.title)), soon.map((t) => t.projectId))
    }
  }

  if (prefs.projectAheadDays > 0) {
    const when = addDays(on, prefs.projectAheadDays)
    const soon = input.projects.filter((p) => p.deadline === when)
    if (soon.length === 1 && soon[0]) {
      add('project-ahead', `${soon[0].name}'s deadline is ${ahead(prefs.projectAheadDays)}`, '', [soon[0].id])
    } else if (soon.length > 1) {
      add('project-ahead', `${plural(soon.length, 'project deadline')} are ${ahead(prefs.projectAheadDays)}`,
          names(soon.map((p) => p.name)), soon.map((p) => p.id))
    }
  }

  return out
}

/**
 * Whether this moment is inside the part of the day that a delivery may happen in.
 *
 * "At or after the time you chose, on a day you allowed" — deliberately a window
 * rather than an instant, because the machine is very often asleep at nine in the
 * morning and the alternative is a notification that is simply lost. What stops it
 * being said twice is not this function but the row the delivery writes down; this
 * only says the morning has arrived.
 */
export function deliveryDue(now: Date, at: string, weekends: boolean): boolean {
  const day = now.getDay()
  if (!weekends && (day === 0 || day === 6)) return false
  const [hours, minutes] = at.split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false
  return now.getHours() * 60 + now.getMinutes() >= (hours ?? 0) * 60 + (minutes ?? 0)
}
