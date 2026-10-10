import type { Query, QueryClient } from '@tanstack/react-query'
import type { Channel, Input, Output, ProjectFilter, TaskFilter } from '@shared/api'
import type { DrawnChannel } from '@shared/sync'
import type {
  BoardColumn, CastMember, Decision, JournalEntry, Link, MeetingTodo, MeetingView, Note, OpenQuestion, Person,
  Project, ProjectCollapsibleView, ProjectDetail, ProjectFolderView, ProjectSummary, Task, TaskComment, TaskView,
  TodayView
} from '@shared/types'
import { parseDate, todayStr } from './format'

/**
 * What a write will do, drawn before Neo Cloud has said so.
 *
 * One entry per channel that can be drawn ahead (`SYNCABLE` and `ONLINE_ONLY` in
 * `shared/sync.ts`), and
 * nothing at the call sites: `useApiMutation` finds the entry by channel, so a dialog
 * that saves a task gets the instant version by saving a task. Each one edits the
 * query caches the screens are already drawing from — the project's detail, the task
 * lists, Today — the way the server is about to, and returns what the channel would
 * have returned so a caller waiting on the answer has one.
 *
 * They are guesses, and they are allowed to be: every write is followed by a refetch
 * that replaces the guess with the truth. What they must be is **idempotent** — the
 * same write is applied again on top of every fresh answer for as long as it is still
 * waiting (see `rebase` in `api.ts`), so a create inserts only if its id is absent and
 * an edit sets fields rather than toggling them.
 */

export interface Context {
  /** Set on a create: the id the new thing is drawn under until it has a real one. */
  tempId?: string
  now: string
  today: string
}

export interface Optimist<C extends Channel> {
  /** Whether this input makes something new, and so needs a temporary id. */
  creates?: (input: Input<C>) => boolean
  /** The write in words, for the list of what is waiting and for a refusal. */
  label: (input: Input<C>, cache: Draft) => string
  apply: (input: Input<C>, cache: Draft, context: Context) => Output<C> | void
}

/**
 * The query cache, as an optimist may touch it. Every change is recorded with what
 * it replaced, so a refused write can be put back exactly. `scope` narrows it to one
 * query, which is how a write still waiting is laid back over a fresh answer.
 */
export class Draft {
  readonly replaced = new Map<string, { key: readonly unknown[]; data: unknown }>()

  constructor(
    private readonly client: QueryClient,
    private readonly scope?: Query
  ) {}

  private queries(channel: Channel): Query[] {
    return this.client
      .getQueryCache()
      .findAll({ queryKey: [channel] })
      .filter((q) => !this.scope || q === this.scope)
  }

  /** Change every cached answer to `channel`. Return the input unchanged to leave one alone. */
  update<C extends Channel>(channel: C, change: (data: Output<C>, input: Input<C>) => Output<C>): void {
    for (const query of this.queries(channel)) {
      const data = query.state.data as Output<C> | undefined
      if (data === undefined) continue
      const next = change(data, query.queryKey[1] as Input<C>)
      if (next === data) continue
      if (!this.replaced.has(query.queryHash)) this.replaced.set(query.queryHash, { key: query.queryKey, data })
      this.client.setQueryData(query.queryKey, next)
    }
  }

  /** Every cached answer to `channel`, for looking things up. Never narrowed by scope. */
  read<C extends Channel>(channel: C): { input: Input<C>; data: Output<C> }[] {
    return this.client
      .getQueryCache()
      .findAll({ queryKey: [channel] })
      .filter((q) => q.state.data !== undefined)
      .map((q) => ({ input: q.queryKey[1] as Input<C>, data: q.state.data as Output<C> }))
  }

  /** Put back everything this draft changed. */
  restore(): void {
    for (const { key, data } of this.replaced.values()) this.client.setQueryData(key, data)
  }
}

/* --------------------------------------------------------------------- lists */

type Row = { id: string }

const has = <T extends Row>(list: T[], id: string): boolean => list.some((x) => x.id === id)

/** Insert unless it is already there — which is what makes a create safe to apply twice. */
const insert = <T extends Row>(list: T[], item: T, at: 'start' | 'end' = 'end'): T[] =>
  has(list, item.id) ? list : at === 'start' ? [item, ...list] : [...list, item]

const patch = <T extends Row>(list: T[], id: string, change: (item: T) => T): T[] => {
  if (!has(list, id)) return list
  return list.map((x) => (x.id === id ? change(x) : x))
}

const drop = <T extends Row>(list: T[], id: string): T[] => (has(list, id) ? list.filter((x) => x.id !== id) : list)

/**
 * Put `ids` in that order, in the places they already hold among the rest, numbering
 * them from one the way Neo Cloud's `reorder` does. Rows not named stay exactly where
 * they are, so a list that is a superset of what was dragged — a board's every card,
 * every project in a workspace — keeps its shape.
 */
function arrange<T extends Row>(list: T[], ids: string[]): T[] {
  const order = new Map(ids.map((id, i) => [id, i]))
  const named = list.filter((x) => order.has(x.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  if (named.length === 0) return list
  let next = 0
  const numbered = (x: T): T =>
    'sortOrder' in x && (x as { sortOrder: number }).sortOrder !== order.get(x.id)! + 1
      ? { ...x, sortOrder: order.get(x.id)! + 1 }
      : x
  const out = list.map((x) => (order.has(x.id) ? numbered(named[next++]!) : x))
  return out.every((x, i) => x === list[i]) ? list : out
}

/** Only the fields a draft actually carries — `undefined` means "not sent", not "cleared". */
const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>

const quote = (text: string | undefined, fallback: string): string => {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return fallback
  return `“${trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed}”`
}

/* ------------------------------------------------------------------ lookups */

function detailOf(cache: Draft, projectId: string): ProjectDetail | undefined {
  return cache.read('project:get').find((q) => q.data.project.id === projectId)?.data
}

function projectOf(cache: Draft, projectId: string): ProjectSummary | undefined {
  return (
    detailOf(cache, projectId)?.project ??
    cache.read('project:list').flatMap((q) => q.data).find((p) => p.id === projectId)
  )
}

function personOf(cache: Draft, personId: string | null | undefined): Person | CastMember | undefined {
  if (!personId) return undefined
  return (
    cache.read('person:list').flatMap((q) => q.data).find((p) => p.id === personId) ??
    cache.read('project:get').flatMap((q) => q.data.cast).find((m) => m.personId === personId)
  )
}

function findTask(cache: Draft, id: string): TaskView | undefined {
  return (
    cache.read('project:get').flatMap((q) => q.data.tasks).find((t) => t.id === id) ??
    cache.read('task:list').flatMap((q) => q.data).find((t) => t.id === id) ??
    cache
      .read('dashboard:today')
      .flatMap((q) => [...q.data.overdue, ...q.data.dueToday, ...q.data.soon])
      .find((t) => t.id === id)
  )
}

const daysUntil = (due: string | null, today: string): number | null =>
  due ? Math.round((parseDate(due).getTime() - parseDate(today).getTime()) / 86_400_000) : null

/* -------------------------------------------------------------------- tasks */

/** The fields of a task that follow from others: who it belongs to, how far off it is. */
function decorate(cache: Draft, task: TaskView, today: string): TaskView {
  const person = personOf(cache, task.assigneePersonId)
  const isMe = Boolean(person && 'isMe' in person && person.isMe)
  return {
    ...task,
    assigneeName: task.assigneePersonId ? (person?.name ?? task.assigneeName) : null,
    assigneeAvatar: task.assigneePersonId ? (person?.avatar ?? task.assigneeAvatar) : null,
    assigneeColor: task.assigneePersonId ? (person?.avatarColor ?? task.assigneeColor) : null,
    assigneeIsMe: task.assigneePersonId ? isMe : false,
    daysUntilDue: daysUntil(task.dueDate, today)
  }
}

/** Change one task wherever a screen is drawing it. */
function everywhere(cache: Draft, id: string, change: (task: TaskView) => TaskView): void {
  cache.update('project:get', (d) => {
    const tasks = patch(d.tasks, id, change)
    return tasks === d.tasks ? d : { ...d, tasks }
  })
  cache.update('task:list', (list) => patch(list, id, change))
  cache.update('dashboard:today', (d) => {
    const next = { overdue: patch(d.overdue, id, change), dueToday: patch(d.dueToday, id, change), soon: patch(d.soon, id, change) }
    return next.overdue === d.overdue && next.dueToday === d.dueToday && next.soon === d.soon ? d : { ...d, ...next }
  })
  cache.update('dashboard:everywhere', (d) => {
    const next = { overdue: patch(d.overdue, id, change), dueToday: patch(d.dueToday, id, change), soon: patch(d.soon, id, change) }
    return next.overdue === d.overdue && next.dueToday === d.dueToday && next.soon === d.soon ? d : { ...d, ...next }
  })
}

function removeEverywhere(cache: Draft, id: string): void {
  cache.update('project:get', (d) => {
    const tasks = drop(d.tasks, id)
    return tasks === d.tasks ? d : { ...d, tasks }
  })
  cache.update('task:list', (list) => drop(list, id))
  cache.update('dashboard:today', (d) => {
    const next = { overdue: drop(d.overdue, id), dueToday: drop(d.dueToday, id), soon: drop(d.soon, id) }
    return next.overdue === d.overdue && next.dueToday === d.dueToday && next.soon === d.soon ? d : { ...d, ...next }
  })
  cache.update('dashboard:everywhere', (d) => {
    const next = { overdue: drop(d.overdue, id), dueToday: drop(d.dueToday, id), soon: drop(d.soon, id) }
    return next.overdue === d.overdue && next.dueToday === d.dueToday && next.soon === d.soon ? d : { ...d, ...next }
  })
}

/** Every task, wherever it is drawn, that `which` picks out. For changes that follow from another row. */
function everyTask(cache: Draft, which: (task: TaskView) => boolean, change: (task: TaskView) => TaskView): void {
  const each = (list: TaskView[]): TaskView[] => {
    const next = list.map((t) => (which(t) ? change(t) : t))
    return next.every((t, i) => t === list[i]) ? list : next
  }
  cache.update('project:get', (d) => {
    const tasks = each(d.tasks)
    return tasks === d.tasks ? d : { ...d, tasks }
  })
  cache.update('task:list', each)
  const lists = <D extends { overdue: TaskView[]; dueToday: TaskView[]; soon: TaskView[] }>(d: D): D => {
    const next = { overdue: each(d.overdue), dueToday: each(d.dueToday), soon: each(d.soon) }
    return next.overdue === d.overdue && next.dueToday === d.dueToday && next.soon === d.soon ? d : { ...d, ...next }
  }
  cache.update('dashboard:today', lists)
  cache.update('dashboard:everywhere', lists)
}

const matchesFilter = (filter: TaskFilter | void | null, task: TaskView): boolean =>
  !filter ||
  ((!filter.projectId || filter.projectId === task.projectId) &&
    (!filter.workspaceId || filter.workspaceId === task.workspaceId) &&
    (!filter.kind || filter.kind === task.kind) &&
    (!filter.status || filter.status === task.status))

/** Where Today files a dated task: late, today, or the coming week. */
function onToday(view: TodayView, task: TaskView): TodayView {
  const days = task.daysUntilDue
  if (days === null || task.status !== 'open' || days > 7) return view
  const bucket = days < 0 ? 'overdue' : days === 0 ? 'dueToday' : 'soon'
  const list = insert(view[bucket], task)
  return list === view[bucket] ? view : { ...view, [bucket]: list }
}

const doneColumn = (detail: ProjectDetail | undefined): string | null =>
  detail?.columns.find((c) => c.isDone)?.id ?? null

const firstColumn = (detail: ProjectDetail | undefined): string | null =>
  [...(detail?.columns ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).find((c) => !c.isDone)?.id ??
  detail?.columns[0]?.id ??
  null

/* ---------------------------------------------------------------- registry */

type Registry = { [C in DrawnChannel]: Optimist<C> }

export const optimists: Registry = {
  'task:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Edit ${quote(input.title ?? findTask(cache, input.id)?.title, 'a task')}`
        : `Add task ${quote(input.title, '')}`.trim(),
    apply: (input, cache, { tempId, now, today }) => {
      if (input.id) {
        const id = input.id
        let result: TaskView | undefined
        const detail = cache.read('project:get').find((q) => q.data.tasks.some((t) => t.id === id))?.data
        everywhere(cache, id, (task) => {
          const next = decorate(cache, { ...task, ...defined(input), id, updatedAt: now } as TaskView, today)
          if (input.columnId && input.columnId !== task.columnId) {
            const column = detail?.columns.find((c) => c.id === input.columnId)
            if (column?.isDone) next.status = 'done'
            else if (column && task.status === 'done') next.status = 'open'
          }
          result = next
          return next
        })
        return result ?? ({ ...input, id } as Task)
      }
      if (!tempId || !input.projectId) return
      const detail = detailOf(cache, input.projectId)
      const project = projectOf(cache, input.projectId)
      const task = decorate(
        cache,
        {
          id: tempId,
          projectId: input.projectId,
          title: input.title ?? '',
          details: input.details ?? '',
          kind: input.kind ?? 'task',
          status: 'open',
          columnId: input.columnId ?? firstColumn(detail),
          dueDate: input.dueDate ?? null,
          assigneePersonId: input.assigneePersonId ?? null,
          completedAt: null,
          sortOrder: Math.max(0, ...(detail?.tasks ?? []).map((t) => t.sortOrder)) + 1,
          createdAt: now,
          updatedAt: now,
          projectName: project?.name ?? '',
          projectColor: project?.color ?? '',
          workspaceId: project?.workspaceId ?? '',
          workspaceName: project?.workspaceName ?? '',
          workspaceColor: project?.workspaceColor ?? '',
          assigneeName: null,
          assigneeAvatar: null,
          assigneeColor: null,
          assigneeIsMe: false,
          daysUntilDue: null,
          sourceMeetingId: null,
          commentCount: 0
        },
        today
      )
      cache.update('project:get', (d) =>
        d.project.id === task.projectId ? { ...d, tasks: insert(d.tasks, task) } : d
      )
      cache.update('task:list', (list, filter) => (matchesFilter(filter, task) ? insert(list, task) : list))
      cache.update('dashboard:today', (view, scope) =>
        scope.workspaceId === task.workspaceId ? onToday(view, task) : view
      )
      return task
    }
  },

  'task:setStatus': {
    label: ({ id, status }, cache) =>
      `Mark ${quote(findTask(cache, id)?.title, 'a task')} ${status === 'done' ? 'done' : 'not done'}`,
    apply: ({ id, status }, cache, { now }) => {
      let result: TaskView | undefined
      const detail = cache.read('project:get').find((q) => q.data.tasks.some((t) => t.id === id))?.data
      everywhere(cache, id, (task) => {
        if (task.status === status) return (result = task)
        // Ticking it moves the card to Done, and unticking it takes it back out.
        const done = doneColumn(detail)
        const columnId =
          status === 'done' ? (done ?? task.columnId) : task.columnId === done ? firstColumn(detail) : task.columnId
        return (result = { ...task, status, columnId, completedAt: status === 'done' ? now : null, updatedAt: now })
      })
      return result ?? ({ id, status } as Task)
    }
  },

  'task:setColumn': {
    label: ({ id, columnId }, cache) => {
      const column = cache.read('project:get').flatMap((q) => q.data.columns).find((c) => c.id === columnId)
      return `Move ${quote(findTask(cache, id)?.title, 'a task')}${column ? ` to ${column.name}` : ''}`
    },
    apply: ({ id, columnId }, cache, { now }) => {
      let result: TaskView | undefined
      const column = cache.read('project:get').flatMap((q) => q.data.columns).find((c) => c.id === columnId)
      everywhere(cache, id, (task) => {
        if (task.columnId === columnId) return (result = task)
        // Into the done column ticks it; out of it unticks it.
        const status = column?.isDone ? 'done' : task.status === 'done' ? 'open' : task.status
        return (result = { ...task, columnId, status, completedAt: status === 'done' ? (task.completedAt ?? now) : null, updatedAt: now })
      })
      return result ?? ({ id, columnId } as Task)
    }
  },

  'task:delete': {
    label: ({ id }, cache) => `Delete ${quote(findTask(cache, id)?.title, 'a task')}`,
    apply: ({ id }, cache) => removeEverywhere(cache, id)
  },

  'person:save': {
    creates: (input) => !input.id,
    label: (input) => (input.id ? `Edit ${quote(input.name, 'a person')}` : `Add ${quote(input.name, 'a person')}`),
    apply: (input, cache, { tempId, now }) => {
      if (input.id) {
        const id = input.id
        const change = defined(input)
        let result: Person | undefined
        cache.update('person:list', (list) => patch(list, id, (p) => (result = { ...p, ...change, id })))
        cache.update('person:get', (d) => (d.person.id === id ? { ...d, person: (result = { ...d.person, ...change, id }) } : d))
        cache.update('project:get', (d) => {
          const cast = d.cast.map((m) =>
            m.personId === id
              ? { ...m, ...defined({ name: input.name, org: input.org, email: input.email, avatarColor: input.avatarColor, howToWorkWith: input.howToWorkWith }) }
              : m
          )
          return d.cast.some((m) => m.personId === id) ? { ...d, cast } : d
        })
        return result ?? ({ ...input, id } as Person)
      }
      if (!tempId || !input.workspaceId) return
      const person: Person & { projectCount: number } = {
        id: tempId,
        workspaceId: input.workspaceId,
        name: input.name ?? '',
        org: input.org ?? '',
        email: input.email ?? '',
        phone: input.phone ?? '',
        timezone: input.timezone ?? '',
        avatarColor: input.avatarColor ?? '#64748b',
        avatarPath: input.avatarPath ?? '',
        avatar: input.avatar ?? null,
        isMe: false,
        howToWorkWith: input.howToWorkWith ?? '',
        notes: input.notes ?? '',
        createdAt: now,
        projectCount: 0
      }
      cache.update('person:list', (list, scope) =>
        scope.workspaceId === person.workspaceId && !scope.projectId &&
        (!scope.query || person.name.toLowerCase().includes(scope.query.toLowerCase()))
          ? insert(list, person)
          : list
      )
      return person
    }
  },

  'membership:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Change ${quote(personOf(cache, input.personId)?.name, 'a role')} on the project`
        : `Add ${quote(personOf(cache, input.personId)?.name, 'someone')} to ${projectOf(cache, input.projectId ?? '')?.name ?? 'the project'}`,
    apply: (input, cache, { tempId, now }) => {
      if (input.id) {
        const id = input.id
        const change = defined({ role: input.role, note: input.note })
        let result: CastMember | undefined
        cache.update('project:get', (d) => {
          const cast = patch(d.cast, id, (m) => (result = { ...m, ...change }))
          return cast === d.cast ? d : { ...d, cast }
        })
        cache.update('person:get', (d) => {
          const projects = patch(d.projects, id, (p) => ({ ...p, ...change }))
          return projects === d.projects ? d : { ...d, projects }
        })
        return result ?? ({ ...input, id } as CastMember)
      }
      if (!tempId || !input.personId || !input.projectId) return
      const person = personOf(cache, input.personId)
      const member: CastMember = {
        id: tempId,
        personId: input.personId,
        projectId: input.projectId,
        role: input.role ?? '',
        note: input.note ?? '',
        createdAt: now,
        name: person?.name ?? '',
        org: person?.org ?? '',
        email: person?.email ?? '',
        avatarColor: person?.avatarColor ?? '#64748b',
        avatar: person?.avatar ?? null,
        isMe: Boolean(person?.isMe),
        howToWorkWith: person?.howToWorkWith ?? ''
      }
      cache.update('project:get', (d) =>
        d.project.id === member.projectId && !d.cast.some((m) => m.personId === member.personId)
          ? { ...d, cast: insert(d.cast, member) }
          : d
      )
      const listed = cache.read('person:list').flatMap((q) => q.data).find((p) => p.id === member.personId)
      if (listed) {
        cache.update('person:list', (list, scope) =>
          scope.projectId === member.projectId ? insert(list, listed) : list
        )
      }
      return member
    }
  },

  'decision:save': {
    creates: (input) => !input.id,
    label: (input) => `${input.id ? 'Edit decision' : 'Log decision'} ${quote(input.title, '')}`.trim(),
    apply: (input, cache, { tempId, now, today }) =>
      saveIn<Decision>(cache, 'decisions', input, tempId, 'start', () => ({
        id: tempId ?? '',
        projectId: input.projectId ?? '',
        title: '',
        rationale: '',
        alternatives: '',
        question: '',
        decidedBy: '',
        decidedOn: today,
        createdAt: now
      }))
  },
  'decision:delete': {
    label: ({ id }, cache) =>
      `Delete decision ${quote(cache.read('project:get').flatMap((q) => q.data.decisions).find((d) => d.id === id)?.title, '')}`.trim(),
    apply: ({ id }, cache) => dropFrom(cache, 'decisions', id)
  },

  'journal:save': {
    creates: (input) => !input.id,
    label: (input) => (input.id ? 'Edit a log entry' : `Add log entry ${quote(input.body, '')}`.trim()),
    apply: (input, cache, { tempId, now, today }) =>
      saveIn<JournalEntry>(cache, 'journal', input, tempId, 'start', () => ({
        id: tempId ?? '',
        projectId: input.projectId ?? '',
        body: '',
        occurredOn: today,
        createdAt: now
      }))
  },
  'journal:delete': {
    label: () => 'Delete a log entry',
    apply: ({ id }, cache) => dropFrom(cache, 'journal', id)
  },

  'link:save': {
    creates: (input) => !input.id,
    label: (input) => `${input.id ? 'Edit link' : 'Add link'} ${quote(input.label || input.url, '')}`.trim(),
    apply: (input, cache, { tempId }) =>
      saveIn<Link>(cache, 'links', input, tempId, 'end', (detail) => ({
        id: tempId ?? '',
        projectId: input.projectId ?? '',
        label: '',
        url: '',
        kind: 'other',
        sortOrder: (detail?.links.length ?? 0) + 1
      }))
  },
  'link:delete': {
    label: ({ id }, cache) =>
      `Remove link ${quote(cache.read('project:get').flatMap((q) => q.data.links).find((l) => l.id === id)?.label, '')}`.trim(),
    apply: ({ id }, cache) => dropFrom(cache, 'links', id)
  },

  'note:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      `Save note ${quote(input.title ?? cache.read('project:get').flatMap((q) => q.data.notes).find((n) => n.id === input.id)?.title, 'Untitled')}`,
    apply: (input, cache, { tempId, now }) =>
      saveIn<Note>(cache, 'notes', { ...input, updatedAt: now }, tempId, 'start', () => ({
        id: tempId ?? '',
        projectId: input.projectId ?? '',
        title: '',
        body: '',
        folderId: null,
        isPinned: false,
        createdAt: now,
        updatedAt: now
      }))
  },
  'note:delete': {
    label: ({ id }, cache) =>
      `Delete note ${quote(cache.read('project:get').flatMap((q) => q.data.notes).find((n) => n.id === id)?.title, '')}`.trim(),
    apply: ({ id }, cache) => dropFrom(cache, 'notes', id)
  },

  'openQuestion:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Edit question ${quote(input.question ?? questionOf(cache, input.id)?.question, '')}`.trim()
        : `Ask ${quote(input.question, 'a question')}`,
    apply: (input, cache, { tempId, now, today }) =>
      saveIn<OpenQuestion>(
        cache,
        'openQuestions',
        { ...input, updatedAt: now },
        tempId,
        'end',
        () => ({
          id: tempId ?? '',
          projectId: input.projectId ?? '',
          question: '',
          context: '',
          ownerPersonId: null,
          ownerName: null,
          ownerAvatar: null,
          ownerColor: null,
          dueDate: null,
          daysUntilDue: null,
          createdAt: now,
          updatedAt: now
        }),
        (q) => {
          const owner = personOf(cache, q.ownerPersonId)
          return {
            ...q,
            ownerName: q.ownerPersonId ? (owner?.name ?? q.ownerName) : null,
            ownerAvatar: q.ownerPersonId ? (owner?.avatar ?? q.ownerAvatar) : null,
            ownerColor: q.ownerPersonId ? (owner?.avatarColor ?? q.ownerColor) : null,
            daysUntilDue: daysUntil(q.dueDate, today)
          }
        }
      )
  },
  'openQuestion:delete': {
    label: ({ id }, cache) => `Drop question ${quote(questionOf(cache, id)?.question, '')}`.trim(),
    apply: ({ id }, cache) => dropFrom(cache, 'openQuestions', id)
  },
  /** Settled: the question leaves the open list and the decision is logged with it on. */
  'openQuestion:decide': {
    creates: () => true,
    label: (input) => `Log decision ${quote(input.title, '')}`.trim(),
    apply: (input, cache, { tempId, now, today }) => {
      const question = questionOf(cache, input.id)
      const projectId =
        question?.projectId ??
        cache.read('project:get').find((q) => q.data.decisions.some((d) => d.id === tempId))?.data.project.id
      dropFrom(cache, 'openQuestions', input.id)
      if (!tempId || !projectId) return
      const decision: Decision = {
        id: tempId,
        projectId,
        title: input.title.trim(),
        rationale: input.rationale ?? '',
        alternatives: input.alternatives ?? '',
        decidedBy: input.decidedBy ?? '',
        decidedOn: input.decidedOn || today,
        question: question?.question ?? '',
        createdAt: now
      }
      cache.update('project:get', (d) => {
        if (d.project.id !== projectId) return d
        const decisions = insert(d.decisions, decision, 'start')
        return decisions === d.decisions ? d : { ...d, decisions }
      })
      return decision
    }
  },

  /* The order of the cards on a board: one column's cards, in the order they now stand. */
  'task:reorder': {
    label: () => 'Reorder cards',
    apply: ({ ids }, cache) => {
      cache.update('project:get', (d) => {
        const tasks = arrange(d.tasks, ids)
        return tasks === d.tasks ? d : { ...d, tasks }
      })
    }
  },

  /**
   * Into another project: into its first column, or its done column if it was done,
   * at the bottom; and with nobody on it if that is another workspace, unless it was
   * your own, which stays yours.
   */
  'task:setProject': {
    label: ({ id, projectId }, cache) =>
      `Move ${quote(findTask(cache, id)?.title, 'a task')} to ${projectOf(cache, projectId)?.name ?? 'another project'}`,
    apply: ({ id, projectId }, cache, { now, today }) => {
      const task = findTask(cache, id)
      if (!task) return
      const target = detailOf(cache, projectId)
      const project = projectOf(cache, projectId)
      let moved = task
      if (task.projectId !== projectId) {
        const workspaceId = project?.workspaceId ?? task.workspaceId
        const crossing = workspaceId !== task.workspaceId
        const me = crossing && task.assigneeIsMe
          ? cache.read('person:list').filter((q) => q.input.workspaceId === workspaceId).flatMap((q) => q.data).find((p) => p.isMe)
          : undefined
        moved = decorate(
          cache,
          {
            ...task,
            projectId,
            columnId: task.status === 'done' ? doneColumn(target) : firstColumn(target),
            sortOrder: Math.max(-1, ...(target?.tasks ?? []).map((t) => t.sortOrder)) + 1,
            projectName: project?.name ?? task.projectName,
            projectColor: project?.color ?? task.projectColor,
            workspaceId,
            workspaceName: project?.workspaceName ?? task.workspaceName,
            workspaceColor: project?.workspaceColor ?? task.workspaceColor,
            assigneePersonId: crossing ? (me?.id ?? null) : task.assigneePersonId,
            updatedAt: now
          },
          today
        )
      }
      cache.update('project:get', (d) => {
        if (d.project.id === projectId) {
          const tasks = insert(d.tasks, moved)
          return tasks === d.tasks ? d : { ...d, tasks }
        }
        const tasks = drop(d.tasks, id)
        return tasks === d.tasks ? d : { ...d, tasks }
      })
      everywhere(cache, id, () => moved)
      return moved
    }
  },

  'taskComment:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id ? 'Edit a comment' : `Comment on ${quote(findTask(cache, input.taskId ?? '')?.title, 'a task')}`,
    apply: (input, cache, { tempId, now }) => {
      const body = input.body.trim()
      if (input.id) {
        const id = input.id
        let result: TaskComment | undefined
        cache.update('taskComment:list', (list) => patch(list, id, (c) => (result = { ...c, body, editedAt: now })))
        return result ?? ({ id, body } as TaskComment)
      }
      const taskId = input.taskId
      if (!tempId || !taskId) return
      const me = cache.read('profile:get')[0]?.data
      const comment: TaskComment = {
        id: tempId,
        taskId,
        body,
        authorAccountId: null,
        authorName: me?.name ?? '',
        authorAvatar: me?.avatar ?? null,
        isMine: true,
        createdAt: now,
        editedAt: null
      }
      // The count on the card moves with the thread, and only when the thread did, so
      // laying this write again over the same answer never counts it twice.
      let added = false
      cache.update('taskComment:list', (list, scope) => {
        if (scope.taskId !== taskId) return list
        const next = insert(list, comment)
        added ||= next !== list
        return next
      })
      if (added) everywhere(cache, taskId, (t) => ({ ...t, commentCount: t.commentCount + 1 }))
      return comment
    }
  },
  'taskComment:delete': {
    label: () => 'Delete a comment',
    apply: ({ id }, cache) => {
      let taskId: string | null = null
      cache.update('taskComment:list', (list, scope) => {
        const next = drop(list, id)
        if (next !== list) taskId = scope.taskId
        return next
      })
      if (taskId) everywhere(cache, taskId, (t) => ({ ...t, commentCount: Math.max(0, t.commentCount - 1) }))
    }
  },

  /** Off every project and every card they had, and out of the list. */
  'person:delete': {
    label: ({ id }, cache) => `Delete ${quote(personOf(cache, id)?.name, 'a person')}`,
    apply: ({ id }, cache) => {
      cache.update('person:list', (list) => drop(list, id))
      cache.update('project:get', (d) => {
        const cast = d.cast.filter((m) => m.personId !== id)
        return cast.length === d.cast.length ? d : { ...d, cast }
      })
      everyTask(
        cache,
        (t) => t.assigneePersonId === id,
        (t) => ({ ...t, assigneePersonId: null, assigneeName: null, assigneeAvatar: null, assigneeColor: null, assigneeIsMe: false })
      )
      cache.update('project:get', (d) => {
        if (!d.openQuestions.some((q) => q.ownerPersonId === id)) return d
        const openQuestions = d.openQuestions.map((q) =>
          q.ownerPersonId === id ? { ...q, ownerPersonId: null, ownerName: null, ownerAvatar: null, ownerColor: null } : q
        )
        return { ...d, openQuestions }
      })
    }
  },
  'membership:delete': {
    label: ({ id }, cache) => {
      const member = cache.read('project:get').flatMap((q) => q.data.cast).find((m) => m.id === id)
      return `Take ${quote(member?.name, 'someone')} off ${projectOf(cache, member?.projectId ?? '')?.name ?? 'the project'}`
    },
    apply: ({ id }, cache) => {
      const member =
        cache.read('project:get').flatMap((q) => q.data.cast).find((m) => m.id === id) ??
        cache.read('person:get').flatMap((q) => q.data.projects).find((p) => p.id === id)
      cache.update('project:get', (d) => {
        const cast = drop(d.cast, id)
        return cast === d.cast ? d : { ...d, cast }
      })
      cache.update('person:get', (d) => {
        const projects = drop(d.projects, id)
        return projects === d.projects ? d : { ...d, projects }
      })
      if (member) {
        cache.update('person:list', (list, scope) =>
          scope.projectId === member.projectId ? drop(list, member.personId) : list
        )
      }
    }
  },

  /* ----------------------------------------------- drawn, but never kept offline */

  'project:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Edit ${quote(input.name ?? projectOf(cache, input.id)?.name, 'a project')}`
        : `Add project ${quote(input.name, '')}`.trim(),
    apply: (input, cache, { tempId, now }) => {
      if (input.id) {
        const id = input.id
        const current = projectOf(cache, id)
        const change: Partial<Project> = defined(input)
        // Filed somewhere else: the band it was in belonged to the level it left, and
        // its place among its old neighbours means nothing among the new ones.
        if (current && input.folderId !== undefined && (input.folderId ?? null) !== current.folderId) {
          change.collapsibleId = input.collapsibleId ?? null
        }
        let result: ProjectSummary | undefined
        const edit = (p: ProjectSummary): ProjectSummary => (result = { ...p, ...change, id })
        cache.update('project:list', (list) => patch(list, id, edit))
        cache.update('project:get', (d) => (d.project.id === id ? { ...d, project: edit(d.project) } : d))
        refile(cache, current?.workspaceId ?? result?.workspaceId)
        return result ?? ({ ...input, id } as Project)
      }
      if (!tempId || !input.workspaceId) return
      const workspace = cache.read('workspace:list').flatMap((q) => q.data).find((w) => w.id === input.workspaceId)
      const project: ProjectSummary = {
        id: tempId,
        workspaceId: input.workspaceId,
        name: input.name ?? '',
        summary: input.summary ?? '',
        iconPath: input.iconPath ?? '',
        icon: null,
        color: input.color ?? '',
        deadline: input.deadline ?? null,
        status: input.status ?? 'active',
        folderId: input.folderId ?? null,
        collapsibleId: input.collapsibleId ?? null,
        isPinned: input.isPinned ?? false,
        lastOpenedAt: null,
        previousOpenedAt: null,
        lastActivityAt: now,
        createdAt: now,
        archivedAt: null,
        workspaceName: workspace?.name ?? '',
        workspaceColor: workspace?.color ?? '',
        openTasks: 0,
        overdueTasks: 0,
        nextDue: null,
        peopleCount: 0,
        myRoles: '',
        castPreview: [],
        attention: null
      }
      // Never placed by hand, and the newest thing to have happened: Neo Cloud puts it
      // after the cards that were, and after the pinned ones among the rest.
      cache.update('project:list', (list, scope) => {
        if (!listsProject(scope, project) || has(list, project.id)) return list
        const at = list.findIndex((p) => !p.isPinned)
        return at < 0 ? [...list, project] : [...list.slice(0, at), project, ...list.slice(at)]
      })
      refile(cache, project.workspaceId)
      return project
    }
  },
  'project:setArchived': {
    label: ({ id, archived }, cache) => `${archived ? 'Archive' : 'Restore'} ${quote(projectOf(cache, id)?.name, 'a project')}`,
    apply: ({ id, archived }, cache, { now }) => {
      const current =
        projectOf(cache, id) ??
        cache.read('project:list').flatMap((q) => q.data).find((p) => p.id === id)
      if (!current) return
      const archivedAt = archived ? (current.archivedAt ?? now) : null
      const project: ProjectSummary = { ...current, archivedAt }
      cache.update('project:list', (list, scope) =>
        listsProject(scope, project) ? (has(list, id) ? patch(list, id, () => project) : insert(list, project)) : drop(list, id)
      )
      cache.update('project:get', (d) => (d.project.id === id ? { ...d, project: { ...d.project, archivedAt } } : d))
      refile(cache, project.workspaceId)
      return project
    }
  },
  'project:delete': {
    label: ({ id }, cache) => `Delete ${quote(projectOf(cache, id)?.name, 'a project')}`,
    apply: ({ id }, cache) => {
      const workspaceId = projectOf(cache, id)?.workspaceId
      cache.update('project:list', (list) => drop(list, id))
      cache.update('task:list', (list) => (list.some((t) => t.projectId === id) ? list.filter((t) => t.projectId !== id) : list))
      cache.update('dashboard:today', (d) => {
        const keep = (t: TaskView): boolean => t.projectId !== id
        if (![...d.overdue, ...d.dueToday, ...d.soon].some((t) => !keep(t)) && !has(d.needsAttention, id)) return d
        return {
          ...d,
          overdue: d.overdue.filter(keep),
          dueToday: d.dueToday.filter(keep),
          soon: d.soon.filter(keep),
          needsAttention: drop(d.needsAttention, id),
          owedFromMeetings: d.owedFromMeetings.filter((m) => m.projectId !== id)
        }
      })
      refile(cache, workspaceId)
    }
  },
  'project:reorder': {
    label: () => 'Rearrange projects',
    apply: ({ ids }, cache) => cache.update('project:list', (list) => arrange(list, ids))
  },

  'folder:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `${input.name ? 'Rename' : 'Move'} folder ${quote(input.name ?? folderOf(cache, input.id)?.name, '')}`.trim()
        : `Add folder ${quote(input.name, '')}`.trim(),
    apply: (input, cache, { tempId, now }) => {
      let result: ProjectFolderView | undefined
      if (input.id) {
        const id = input.id
        const current = folderOf(cache, id)
        const change: Partial<ProjectFolderView> = defined(input)
        // Filed under another parent: the band it was in is drawn on the page it left.
        if (current && input.parentId !== undefined && (input.parentId ?? null) !== current.parentId) {
          change.collapsibleId = input.collapsibleId ?? null
        }
        cache.update('folder:list', (list) => tree(patch(list, id, (f) => ({ ...f, ...change, id }))))
        result = folderOf(cache, id)
        regroup(cache, current?.workspaceId ?? result?.workspaceId)
        return result ?? ({ ...input, id } as ProjectFolderView)
      }
      if (!tempId || !input.workspaceId) return
      const workspaceId = input.workspaceId
      cache.update('folder:list', (list, scope) => {
        if (scope.workspaceId !== workspaceId || has(list, tempId)) return list
        const parentId = input.parentId ?? null
        result = {
          id: tempId,
          workspaceId,
          parentId,
          collapsibleId: input.collapsibleId ?? null,
          name: input.name ?? '',
          sortOrder: Math.max(-1, ...list.filter((f) => f.parentId === parentId).map((f) => f.sortOrder)) + 1,
          createdAt: now,
          path: [],
          depth: 0,
          projectCount: 0,
          folderCount: 0
        }
        return tree([...list, result])
      })
      refile(cache, workspaceId)
      regroup(cache, workspaceId)
      return result
    }
  },
  /** Gone, and what was in it lifted a level: its projects, its folders, its bands. */
  'folder:delete': {
    label: ({ id }, cache) => `Delete folder ${quote(folderOf(cache, id)?.name, '')}`.trim(),
    apply: ({ id }, cache) => {
      const folder = folderOf(cache, id)
      if (!folder) return
      const up = folder.parentId
      cache.update('folder:list', (list) =>
        has(list, id) ? tree(drop(list, id).map((f) => (f.parentId === id ? { ...f, parentId: up } : f))) : list
      )
      cache.update('collapsible:list', (list) =>
        list.some((c) => c.folderId === id) ? list.map((c) => (c.folderId === id ? { ...c, folderId: up } : c)) : list
      )
      cache.update('project:list', (list) =>
        list.some((p) => p.folderId === id) ? list.map((p) => (p.folderId === id ? { ...p, folderId: up } : p)) : list
      )
      refile(cache, folder.workspaceId)
      regroup(cache, folder.workspaceId)
    }
  },

  'collapsible:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Edit ${quote(input.name ?? cache.read('collapsible:list').flatMap((q) => q.data).find((c) => c.id === input.id)?.name, 'a collapsible')}`
        : `Add collapsible ${quote(input.name, '')}`.trim(),
    apply: (input, cache, { tempId, now }) => {
      let result: ProjectCollapsibleView | undefined
      if (input.id) {
        const id = input.id
        const change = defined(input)
        cache.update('collapsible:list', (list) => patch(list, id, (c) => (result = { ...c, ...change, id })))
        return result ?? ({ ...input, id } as ProjectCollapsibleView)
      }
      if (!tempId || !input.workspaceId) return
      const workspaceId = input.workspaceId
      cache.update('collapsible:list', (list, scope) => {
        if (scope.workspaceId !== workspaceId) return list
        const folderId = input.folderId ?? null
        result = {
          id: tempId,
          workspaceId,
          folderId,
          name: input.name ?? '',
          sortOrder: Math.max(-1, ...list.filter((c) => c.folderId === folderId).map((c) => c.sortOrder)) + 1,
          isCollapsed: input.isCollapsed ?? false,
          createdAt: now,
          projectCount: 0,
          folderCount: 0
        }
        return insert(list, result)
      })
      return result
    }
  },
  /** Gone, and its projects and folders back among the loose cards on the same page. */
  'collapsible:delete': {
    label: ({ id }, cache) =>
      `Remove ${quote(cache.read('collapsible:list').flatMap((q) => q.data).find((c) => c.id === id)?.name, 'a collapsible')}`,
    apply: ({ id }, cache) => {
      cache.update('collapsible:list', (list) => drop(list, id))
      cache.update('project:list', (list) =>
        list.some((p) => p.collapsibleId === id) ? list.map((p) => (p.collapsibleId === id ? { ...p, collapsibleId: null } : p)) : list
      )
      cache.update('folder:list', (list) =>
        list.some((f) => f.collapsibleId === id) ? list.map((f) => (f.collapsibleId === id ? { ...f, collapsibleId: null } : f)) : list
      )
    }
  },

  'column:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Edit column ${quote(input.name ?? columnOf(cache, input.id)?.name, '')}`.trim()
        : `Add column ${quote(input.name, '')}`.trim(),
    apply: (input, cache, { tempId, now }) => {
      const projectId = input.projectId ?? (input.id ? columnOf(cache, input.id)?.projectId : undefined)
      if (!projectId) return
      let result: BoardColumn | undefined
      cache.update('project:get', (d) => {
        if (d.project.id !== projectId) return d
        let columns = d.columns
        if (input.id) {
          const id = input.id
          columns = patch(columns, id, (c) => (result = { ...c, ...defined(input), id }))
        } else if (tempId) {
          result = {
            id: tempId,
            projectId,
            name: input.name ?? '',
            sortOrder: input.sortOrder ?? Math.max(-1, ...columns.map((c) => c.sortOrder)) + 1,
            isDone: input.isDone ?? false,
            createdAt: now
          }
          columns = insert(columns, result)
        }
        // Only one column can be the finishing line.
        if (result?.isDone && input.isDone) {
          const done = result.id
          if (columns.some((c) => c.isDone && c.id !== done)) {
            columns = columns.map((c) => (c.isDone && c.id !== done ? { ...c, isDone: false } : c))
          }
        }
        return columns === d.columns ? d : { ...d, columns }
      })
      return result
    }
  },
  /** Cards are never deleted with their column; they fall back to the first one left. */
  'column:delete': {
    label: ({ id }, cache) => `Delete column ${quote(columnOf(cache, id)?.name, '')}`.trim(),
    apply: ({ id }, cache) => {
      cache.update('project:get', (d) => {
        if (!has(d.columns, id)) return d
        const rest = [...drop(d.columns, id)].sort((a, b) => a.sortOrder - b.sortOrder)
        // A board needs at least one column, and Neo Cloud will say so.
        const fallback = rest[0]
        if (!fallback) return d
        return {
          ...d,
          columns: drop(d.columns, id),
          tasks: d.tasks.map((t) => (t.columnId === id ? { ...t, columnId: fallback.id } : t))
        }
      })
    }
  },
  'column:reorder': {
    label: () => 'Rearrange the board',
    apply: ({ ids }, cache) => {
      cache.update('project:get', (d) => {
        const columns = arrange(d.columns, ids)
        return columns === d.columns ? d : { ...d, columns: [...columns].sort((a, b) => a.sortOrder - b.sortOrder) }
      })
    }
  },

  /**
   * A meeting's name, date, folder and who was there. Never its write-up: the page it
   * is written on keeps that itself, and reads a change to it in the cache as text
   * that arrived from elsewhere — the recap — to be appended to what is being typed.
   */
  'meeting:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `Save meeting ${quote(input.title ?? meetingOf(cache, input.id)?.title, 'Untitled')}`
        : `Add meeting ${quote(input.title, '')}`.trim(),
    apply: (input, cache, { tempId, now, today }) => {
      const projectId = input.projectId ?? (input.id ? meetingOf(cache, input.id)?.projectId : undefined)
      if (!projectId) return
      const detail = detailOf(cache, projectId)
      const attendees = input.attendeeIds?.map((personId) => {
        const member = detail?.cast.find((m) => m.personId === personId)
        const person = personOf(cache, personId)
        return {
          id: personId,
          name: member?.name ?? person?.name ?? '',
          color: member?.avatarColor ?? person?.avatarColor ?? '#64748b',
          avatar: member?.avatar ?? person?.avatar ?? null,
          role: member?.role ?? ''
        }
      })
      if (input.id) {
        const id = input.id
        const change = defined({ title: input.title, occurredOn: input.occurredOn, folderId: input.folderId, attendees })
        let result: MeetingView | undefined
        cache.update('project:get', (d) => {
          const meetings = patch(d.meetings, id, (m) => (result = { ...m, ...change, id }))
          return meetings === d.meetings ? d : { ...d, meetings }
        })
        return result ?? ({ ...input, id } as unknown as MeetingView)
      }
      if (!tempId) return
      const meeting: MeetingView = {
        id: tempId,
        projectId,
        title: input.title ?? '',
        occurredOn: input.occurredOn ?? today,
        body: input.body ?? '',
        folderId: input.folderId ?? null,
        createdAt: now,
        updatedAt: now,
        recording: null,
        attendees: attendees ?? [],
        todos: [],
        openTodos: 0
      }
      cache.update('project:get', (d) => {
        if (d.project.id !== projectId) return d
        const meetings = insert(d.meetings, meeting, 'start')
        return meetings === d.meetings ? d : { ...d, meetings }
      })
      return meeting
    }
  },
  'meeting:delete': {
    label: ({ id }, cache) => `Delete meeting ${quote(meetingOf(cache, id)?.title, '')}`.trim(),
    apply: ({ id }, cache) => {
      cache.update('project:get', (d) => {
        const meetings = drop(d.meetings, id)
        return meetings === d.meetings ? d : { ...d, meetings }
      })
      owed(cache, id, 0)
    }
  },

  'meetingTodo:save': {
    creates: (input) => !input.id,
    label: (input, cache) =>
      input.id
        ? `${input.done === undefined ? 'Edit' : input.done ? 'Tick' : 'Untick'} ${quote(input.text ?? todoOf(cache, input.id)?.text, 'an item')}`
        : `Add item ${quote(input.text, '')}`.trim(),
    apply: (input, cache, { tempId }) => {
      const meetingId = input.meetingId ?? (input.id ? meetingOf(cache, todoOf(cache, input.id)?.meetingId ?? '')?.id : undefined)
      if (!meetingId) return
      return onTodos(cache, meetingId, (todos) => {
        if (input.id) {
          const change = defined({ text: input.text, done: input.done, taskId: input.taskId, sortOrder: input.sortOrder })
          return patch(todos, input.id, (t) => ({ ...t, ...change, ...(input.taskId === null ? { taskColumn: null } : {}) }))
        }
        if (!tempId) return todos
        return insert(todos, {
          id: tempId,
          meetingId,
          text: input.text ?? '',
          done: input.done ?? false,
          taskId: null,
          taskColumn: null,
          sortOrder: input.sortOrder ?? Math.max(-1, ...todos.map((t) => t.sortOrder)) + 1
        })
      })
    }
  },
  'meetingTodo:delete': {
    label: ({ id }, cache) => `Delete item ${quote(todoOf(cache, id)?.text, '')}`.trim(),
    apply: ({ id }, cache) => {
      const meetingId = todoOf(cache, id)?.meetingId
      if (meetingId) onTodos(cache, meetingId, (todos) => drop(todos, id))
    }
  }
}

type ListKey = 'decisions' | 'openQuestions' | 'journal' | 'links' | 'notes'

/** Create or edit one row of a list that lives on the project's detail. */
function saveIn<T extends Row & { projectId: string }>(
  cache: Draft,
  key: ListKey,
  input: Partial<T> & { id?: string },
  tempId: string | undefined,
  at: 'start' | 'end',
  blank: (detail: ProjectDetail | undefined) => T,
  /** Whatever follows from the fields that were written: a name from an id, a count of days. */
  finish: (row: T) => T = (row) => row
): T | undefined {
  let result: T | undefined
  if (input.id) {
    const id = input.id
    const change = defined(input)
    cache.update('project:get', (d) => {
      const list = d[key] as unknown as T[]
      const next = patch(list, id, (row) => (result = finish({ ...row, ...change, id })))
      return next === list ? d : { ...d, [key]: next }
    })
    return result ?? (input as T)
  }
  if (!tempId || !input.projectId) return undefined
  const row: T = finish({ ...blank(detailOf(cache, input.projectId)), ...defined(input), id: tempId })
  cache.update('project:get', (d) => {
    if (d.project.id !== row.projectId) return d
    const list = d[key] as unknown as T[]
    const next = insert(list, row, at)
    return next === list ? d : { ...d, [key]: next }
  })
  return row
}

function dropFrom(cache: Draft, key: ListKey, id: string): void {
  cache.update('project:get', (d) => {
    const list = d[key] as unknown as Row[]
    const next = drop(list, id)
    return next === list ? d : { ...d, [key]: next }
  })
}

/* ----------------------------------------------------------------- helpers */

function questionOf(cache: Draft, id: string): OpenQuestion | undefined {
  return cache.read('project:get').flatMap((q) => q.data.openQuestions).find((q) => q.id === id)
}

function columnOf(cache: Draft, id: string): BoardColumn | undefined {
  return cache.read('project:get').flatMap((q) => q.data.columns).find((c) => c.id === id)
}

function meetingOf(cache: Draft, id: string): MeetingView | undefined {
  return cache.read('project:get').flatMap((q) => q.data.meetings).find((m) => m.id === id)
}

function todoOf(cache: Draft, id: string): MeetingTodo | undefined {
  return cache.read('project:get').flatMap((q) => q.data.meetings).flatMap((m) => m.todos).find((t) => t.id === id)
}

function folderOf(cache: Draft, id: string): ProjectFolderView | undefined {
  return cache.read('folder:list').flatMap((q) => q.data).find((f) => f.id === id)
}

/** Whether a list of projects asked for with this filter would have this one in it. */
const listsProject = (scope: ProjectFilter, project: ProjectSummary): boolean =>
  scope.workspaceId === project.workspaceId &&
  Boolean(scope.archived) === Boolean(project.archivedAt) &&
  (!scope.status || scope.status === 'all' || scope.status === project.status) &&
  (!scope.query || project.name.toLowerCase().includes(scope.query.toLowerCase()))

/**
 * A folder list's path, depth and folder counts, worked out again from the parents —
 * after a folder is added, renamed, moved or taken out. Walks carry a depth guard, as
 * every walk over the tree does.
 */
function tree(list: ProjectFolderView[]): ProjectFolderView[] {
  const byId = new Map(list.map((f) => [f.id, f]))
  const pathOf = (folder: ProjectFolderView): string[] => {
    const names: string[] = []
    let at: ProjectFolderView | undefined = folder
    for (let guard = 0; at && guard < 64; guard++) {
      names.unshift(at.name)
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
    return names
  }
  const next = list.map((f) => {
    const path = pathOf(f)
    const folderCount = list.filter((c) => c.parentId === f.id).length
    const same = f.depth === path.length - 1 && f.folderCount === folderCount && path.join('/') === f.path.join('/')
    return same ? f : { ...f, path, depth: path.length - 1, folderCount }
  })
  return next.every((f, i) => f === list[i]) ? list : next
}

/**
 * How many projects each folder and each band holds, counted again from the list of
 * every live project in the workspace when one is cached. Counting rather than adding
 * and subtracting is what keeps this safe to apply twice.
 */
function refile(cache: Draft, workspaceId: string | undefined): void {
  if (!workspaceId) return
  const all = cache
    .read('project:list')
    .find((q) => q.input.workspaceId === workspaceId && !q.input.archived && !q.input.query && (!q.input.status || q.input.status === 'all'))
    ?.data
  if (!all) return
  const count = (key: 'folderId' | 'collapsibleId', id: string): number => all.filter((p) => p[key] === id).length
  cache.update('folder:list', (list, scope) => {
    if (scope.workspaceId !== workspaceId) return list
    const next = list.map((f) => (f.projectCount === count('folderId', f.id) ? f : { ...f, projectCount: count('folderId', f.id) }))
    return next.every((f, i) => f === list[i]) ? list : next
  })
  cache.update('collapsible:list', (list, scope) => {
    if (scope.workspaceId !== workspaceId) return list
    const next = list.map((c) =>
      c.projectCount === count('collapsibleId', c.id) ? c : { ...c, projectCount: count('collapsibleId', c.id) }
    )
    return next.every((c, i) => c === list[i]) ? list : next
  })
}

/**
 * How many folder cards each band holds, counted again from the workspace's folder list
 * — the folder half of `refile`, and safe to apply twice for the same reason.
 */
function regroup(cache: Draft, workspaceId: string | undefined): void {
  if (!workspaceId) return
  const folders = cache.read('folder:list').find((q) => q.input.workspaceId === workspaceId)?.data
  if (!folders) return
  const count = (id: string): number => folders.filter((f) => f.collapsibleId === id).length
  cache.update('collapsible:list', (list, scope) => {
    if (scope.workspaceId !== workspaceId) return list
    const next = list.map((c) => (c.folderCount === count(c.id) ? c : { ...c, folderCount: count(c.id) }))
    return next.every((c, i) => c === list[i]) ? list : next
  })
}

/** Change one meeting's to-dos, keep its count of what is still owed, and say so on Today. */
function onTodos(cache: Draft, meetingId: string, change: (todos: MeetingTodo[]) => MeetingTodo[]): MeetingView | undefined {
  let result: MeetingView | undefined
  cache.update('project:get', (d) => {
    const meetings = patch(d.meetings, meetingId, (m) => {
      const todos = change(m.todos)
      return (result = todos === m.todos ? m : { ...m, todos, openTodos: todos.filter((t) => !t.done).length })
    })
    return meetings === d.meetings ? d : { ...d, meetings }
  })
  // Today counts an item on the board by its card, and one that is not by its box.
  const open = (t: MeetingTodo): boolean => (t.taskId ? findTask(cache, t.taskId)?.status !== 'done' : !t.done)
  if (result) owed(cache, meetingId, result.todos.filter(open).length)
  return result
}

/** Today's line for a meeting with to-dos still owed: a new count, or gone at none. */
function owed(cache: Draft, meetingId: string, open: number): void {
  const recount = <M extends { meetingId: string; openTodos: number }>(list: M[]): M[] => {
    if (!list.some((m) => m.meetingId === meetingId && m.openTodos !== open)) return list
    return open === 0
      ? list.filter((m) => m.meetingId !== meetingId)
      : list.map((m) => (m.meetingId === meetingId ? { ...m, openTodos: open } : m))
  }
  cache.update('dashboard:today', (d) => {
    const owedFromMeetings = recount(d.owedFromMeetings)
    return owedFromMeetings === d.owedFromMeetings ? d : { ...d, owedFromMeetings }
  })
  cache.update('dashboard:everywhere', (d) => {
    const owedFromMeetings = recount(d.owedFromMeetings)
    return owedFromMeetings === d.owedFromMeetings ? d : { ...d, owedFromMeetings }
  })
}

export const optimistFor = (channel: Channel): Optimist<Channel> | undefined =>
  (optimists as Partial<Record<Channel, Optimist<Channel>>>)[channel]

export const contextFor = (tempId?: string): Context => ({ tempId, now: new Date().toISOString(), today: todayStr() })
