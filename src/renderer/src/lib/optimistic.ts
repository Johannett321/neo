import type { Query, QueryClient } from '@tanstack/react-query'
import type { Channel, Input, Output, TaskFilter } from '@shared/api'
import type { SyncableChannel } from '@shared/sync'
import type {
  CastMember, Decision, JournalEntry, Link, Note, Person, ProjectDetail, ProjectSummary, Task, TaskView,
  TodayView
} from '@shared/types'
import { parseDate, todayStr } from './format'

/**
 * What a write will do, drawn before Neo Cloud has said so.
 *
 * One entry per channel that can be drawn ahead (`SYNCABLE` in `shared/sync.ts`), and
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

type Registry = { [C in SyncableChannel]: Optimist<C> }

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
          sourceMeetingId: null
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
  }
}

type ListKey = 'decisions' | 'journal' | 'links' | 'notes'

/** Create or edit one row of a list that lives on the project's detail. */
function saveIn<T extends Row & { projectId: string }>(
  cache: Draft,
  key: ListKey,
  input: Partial<T> & { id?: string },
  tempId: string | undefined,
  at: 'start' | 'end',
  blank: (detail: ProjectDetail | undefined) => T
): T | undefined {
  let result: T | undefined
  if (input.id) {
    const id = input.id
    const change = defined(input)
    cache.update('project:get', (d) => {
      const list = d[key] as unknown as T[]
      const next = patch(list, id, (row) => (result = { ...row, ...change, id }))
      return next === list ? d : { ...d, [key]: next }
    })
    return result ?? (input as T)
  }
  if (!tempId || !input.projectId) return undefined
  const row: T = { ...blank(detailOf(cache, input.projectId)), ...defined(input), id: tempId }
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

export const optimistFor = (channel: Channel): Optimist<Channel> | undefined =>
  (optimists as Partial<Record<Channel, Optimist<Channel>>>)[channel]

export const contextFor = (tempId?: string): Context => ({ tempId, now: new Date().toISOString(), today: todayStr() })
