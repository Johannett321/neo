import type { CastMember, MeetingView, ProjectDetail, TaskView } from '@shared/types'
import { q, today } from '../../db/client'
import { invokeChannel } from '../../ipc/util'

/**
 * What the assistant can do.
 *
 * Two rules shape this file, and both are load-bearing.
 *
 * **Every write goes through a channel the app already has.** A tool never touches
 * the database directly — it calls `project:save`, `task:setStatus`, `note:save`,
 * exactly as a click in the interface does. So an assistant-made task logs activity,
 * bumps the project's clock and rewrites the Markdown mirror for free, and it cannot
 * drift from what the buttons do, because it is not a second implementation of them.
 *
 * **Every write says what it is about to do, in plain words, before doing it.** That
 * is what `summary` is for: the sentence the confirmation shows. It is written for
 * someone who has not read the arguments — names resolved, dates spelled out — because
 * a confirmation you cannot check is a confirmation you learn to click through.
 *
 * Reads take no confirmation. They are scoped to one workspace by construction: every
 * one of them either filters on `workspaceId` or resolves an id that was itself
 * returned by a scoped read, so the assistant opened in a client's area has no route
 * to the day job's, which is the same boundary every screen in the app obeys.
 */

export interface ToolContext {
  workspaceId: string
  /** The project the panel was opened over, if any. Lets "this project" mean something. */
  projectId?: string
}

export interface Tool {
  name: string
  description: string
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  parameters: Record<string, any>
  /** Writes stop the run and ask. Reads never do. */
  writes: boolean
  /**
   * Takes something away rather than changing it. The in-app assistant does not need
   * to know — it asks about every write in the same words either way — but a client
   * on the other side of the MCP bridge has only its own approval prompt to warn
   * with, so it is told which calls are the ones there is no undo for.
   */
  destroys?: boolean
  /**
   * The confirmation line, in plain words. Resolves ids to names, so it may query.
   * Only ever called for a tool that writes.
   */
  summary?: (input: Args, ctx: ToolContext) => Promise<string>
  run: (input: Args, ctx: ToolContext) => Promise<unknown>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = Record<string, any>

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const optional = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  description
})

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

/* ------------------------------------------------------------------ resolving */

/**
 * Ids are what the tools take, and names are what a person says. Every lookup that
 * accepts either resolves inside the workspace, so a name that is ambiguous says so
 * rather than picking one, and a name from another workspace is simply not found.
 */
async function resolveProject(ref: string, ctx: ToolContext): Promise<{ id: string; name: string }> {
  const rows = await q<{ id: string; name: string }>(
    `SELECT id, name FROM project
     WHERE workspace_id = $1 AND (id::text = $2 OR lower(name) = lower($2) OR name ILIKE $3)
     ORDER BY (lower(name) = lower($2)) DESC, archived_at NULLS FIRST, name
     LIMIT 5`,
    [ctx.workspaceId, ref, `%${ref}%`]
  )
  if (rows.length === 0) throw new Error(`No project in this workspace matches "${ref}".`)
  // An exact match wins outright; several loose ones are an ambiguity worth reporting.
  const exact = rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase() || r.id === ref)
  if (exact.length === 1) return exact[0]
  if (rows.length > 1) {
    throw new Error(`"${ref}" matches ${rows.map((r) => r.name).join(', ')}. Ask which one is meant.`)
  }
  return rows[0]
}

async function resolvePerson(ref: string, ctx: ToolContext): Promise<{ id: string; name: string }> {
  const rows = await q<{ id: string; name: string }>(
    `SELECT id, name FROM person
     WHERE workspace_id = $1 AND (id::text = $2 OR lower(name) = lower($2) OR name ILIKE $3)
     ORDER BY (lower(name) = lower($2)) DESC, name
     LIMIT 5`,
    [ctx.workspaceId, ref, `%${ref}%`]
  )
  if (rows.length === 0) throw new Error(`Nobody in this workspace matches "${ref}".`)
  const exact = rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase() || r.id === ref)
  if (exact.length === 1) return exact[0]
  if (rows.length > 1) {
    throw new Error(`"${ref}" matches ${rows.map((r) => r.name).join(', ')}. Ask which one is meant.`)
  }
  return rows[0]
}

/** A task, confirmed to be inside this workspace before anything is done to it. */
async function resolveTask(id: string, ctx: ToolContext): Promise<{ id: string; title: string; projectName: string }> {
  const rows = await q<{ id: string; title: string; project_name: string }>(
    `SELECT t.id, t.title, p.name AS project_name
     FROM task t JOIN project p ON p.id = t.project_id
     WHERE t.id::text = $1 AND p.workspace_id = $2`,
    [id, ctx.workspaceId]
  )
  if (rows.length === 0) throw new Error(`No task ${id} in this workspace. Look it up first.`)
  return { id: rows[0].id, title: rows[0].title, projectName: rows[0].project_name }
}

/** Dates are spoken, not typed. "Friday" is the model's job; this only checks. */
function checkDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${field} must be a calendar date as YYYY-MM-DD, not "${text}".`)
  }
  return text
}

/* -------------------------------------------------------------------- reading */

/** Long prose is summarised in lists and fetched in full on demand. */
const trim = (text: string, max = 400): string =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length} characters; open it in full to read the rest)`

const taskLine = (t: TaskView): Record<string, unknown> => ({
  id: t.id,
  title: t.title,
  project: t.projectName,
  status: t.status,
  dueDate: t.dueDate,
  daysUntilDue: t.daysUntilDue,
  assignee: t.assigneeName,
  delegated: t.kind === 'delegated'
})

const castLine = (c: CastMember): Record<string, unknown> => ({
  id: c.personId,
  name: c.name,
  role: c.role,
  org: c.org,
  isMe: c.isMe,
  howToWorkWith: c.howToWorkWith || undefined
})

const meetingLine = (m: MeetingView): Record<string, unknown> => ({
  id: m.id,
  title: m.title,
  occurredOn: m.occurredOn,
  attendees: m.attendees.map((a) => a.name),
  openTodos: m.openTodos,
  todos: m.todos.map((t) => ({ id: t.id, text: t.text, done: t.done, onTheBoard: Boolean(t.taskId) })),
  body: trim(m.body)
})

/**
 * Everything about one project, trimmed. This is the tool the assistant reaches for
 * most, so it carries the board, the cast, the notes, the meetings, the decisions,
 * the journal and the log in one call rather than making it ask six times — but with
 * every slab of prose cut short, because the full text of forty notes is not context,
 * it is a bill.
 */
function projectPayload(detail: ProjectDetail): Record<string, unknown> {
  const columns = new Map(detail.columns.map((c) => [c.id, c.name]))
  return {
    id: detail.project.id,
    name: detail.project.name,
    summary: detail.project.summary,
    status: detail.project.status,
    deadline: detail.project.deadline,
    myRoles: detail.project.myRoles,
    archived: Boolean(detail.project.archivedAt),
    attention: detail.project.attention,
    lastActivityAt: detail.project.lastActivityAt,
    board: detail.columns.map((c) => ({
      id: c.id,
      name: c.name,
      isDoneColumn: c.isDone,
      cards: detail.tasks
        .filter((t) => t.columnId === c.id)
        .map((t) => ({ ...taskLine(t), details: trim(t.details, 200) }))
    })),
    unplacedCards: detail.tasks.filter((t) => !t.columnId || !columns.has(t.columnId)).map(taskLine),
    people: detail.cast.map(castLine),
    links: detail.links.map((l) => ({ label: l.label, url: l.url, kind: l.kind })),
    notes: detail.notes.map((n) => ({
      id: n.id,
      title: n.title,
      isPinned: n.isPinned,
      updatedAt: n.updatedAt,
      body: trim(n.body)
    })),
    meetings: detail.meetings.map(meetingLine),
    decisions: detail.decisions.map((d) => ({
      id: d.id,
      title: d.title,
      decidedOn: d.decidedOn,
      decidedBy: d.decidedBy,
      rationale: trim(d.rationale),
      alternatives: trim(d.alternatives)
    })),
    journal: detail.journal.map((j) => ({ id: j.id, occurredOn: j.occurredOn, body: trim(j.body) })),
    recentActivity: detail.activity.map((a) => ({ kind: a.kind, summary: a.summary, at: a.createdAt }))
  }
}

/* ---------------------------------------------------------------------- tools */

export const TOOLS: Tool[] = [
  /* ----------------------------------------------------------------- reading */
  {
    name: 'list_projects',
    description:
      'Every project in this workspace, with what each one is asking for. Start here when the question is about more than one project.',
    parameters: object({
      status: {
        type: ['string', 'null'],
        enum: ['active', 'paused', 'dormant', 'done', 'all', null],
        description: 'Defaults to all statuses.'
      },
      includeArchived: { type: ['boolean', 'null'], description: 'Archived projects are left out by default.' }
    }),
    writes: false,
    run: async (input, ctx) => {
      const projects = await invokeChannel('project:list', {
        workspaceId: ctx.workspaceId,
        status: (input.status as 'all') ?? 'all',
        archived: input.includeArchived === true
      })
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        summary: p.summary,
        status: p.status,
        deadline: p.deadline,
        openTasks: p.openTasks,
        overdueTasks: p.overdueTasks,
        nextDue: p.nextDue,
        people: p.peopleCount,
        myRoles: p.myRoles,
        attention: p.attention,
        lastActivityAt: p.lastActivityAt
      }))
    }
  },
  {
    name: 'get_project',
    description:
      'One project in full: its board and every card, the people on it, its notes, meetings, decisions, journal, links and recent log. Long prose is cut short — use get_document for the full text of a note or meeting.',
    parameters: object({ project: str('The project id, or its name.') }, ['project']),
    writes: false,
    run: async (input, ctx) => {
      const { id } = await resolveProject(String(input.project), ctx)
      // `touch: false` — the assistant reading a project is not you visiting it, and
      // must not roll the clock the re-entry brief measures from.
      return projectPayload(await invokeChannel('project:get', { id, touch: false }))
    }
  },
  {
    name: 'today',
    description:
      'What is on fire in this workspace right now: overdue work, what is due today and soon, and the projects asking for a look.',
    parameters: object({}),
    writes: false,
    run: async (_input, ctx) => {
      const view = await invokeChannel('dashboard:today', { workspaceId: ctx.workspaceId })
      return {
        today: view.today,
        overdue: view.overdue.map(taskLine),
        dueToday: view.dueToday.map(taskLine),
        dueSoon: view.soon.map(taskLine),
        needsAttention: view.needsAttention.map((p) => ({
          id: p.id,
          name: p.name,
          attention: p.attention,
          deadline: p.deadline
        })),
        stats: view.stats
      }
    }
  },
  {
    name: 'search',
    description:
      'Free-text search across this workspace — projects, tasks, people, notes, decisions and journal entries. Use it when you do not know where something lives.',
    parameters: object({ query: str('What to look for.') }, ['query']),
    writes: false,
    run: async (input, ctx) =>
      invokeChannel('search:query', { workspaceId: ctx.workspaceId, q: String(input.query) })
  },
  {
    name: 'list_tasks',
    description: 'Cards across the workspace, or within one project. Filterable by status and by who owns them.',
    parameters: object({
      project: optional('Limit to one project, by id or name.'),
      status: { type: ['string', 'null'], enum: ['open', 'done', 'cancelled', null] },
      kind: {
        type: ['string', 'null'],
        enum: ['task', 'delegated', null],
        description: '"task" is work you do; "delegated" is work you are waiting on somebody else for.'
      }
    }),
    writes: false,
    run: async (input, ctx) => {
      const projectId = input.project ? (await resolveProject(String(input.project), ctx)).id : undefined
      const tasks = await invokeChannel('task:list', {
        workspaceId: ctx.workspaceId,
        projectId,
        status: input.status ?? undefined,
        kind: input.kind ?? undefined
      })
      return tasks.map(taskLine)
    }
  },
  {
    name: 'list_people',
    description: 'Everybody in this workspace, and how many projects each of them is on.',
    parameters: object({ query: optional('Narrow by name.') }),
    writes: false,
    run: async (input, ctx) => {
      const people = await invokeChannel('person:list', {
        workspaceId: ctx.workspaceId,
        query: input.query ?? undefined
      })
      return people.map((p) => ({
        id: p.id,
        name: p.name,
        org: p.org,
        email: p.email,
        timezone: p.timezone,
        isMe: p.isMe,
        howToWorkWith: p.howToWorkWith,
        notes: trim(p.notes),
        projectCount: p.projectCount
      }))
    }
  },
  {
    name: 'get_person',
    description: 'One person: how to work with them, and every project they are on with the hat they wear on each.',
    parameters: object({ person: str('The person id, or their name.') }, ['person']),
    writes: false,
    run: async (input, ctx) => {
      const { id } = await resolvePerson(String(input.person), ctx)
      const { person, projects } = await invokeChannel('person:get', { id })
      return {
        ...person,
        avatar: undefined,
        avatarPath: undefined,
        projects: projects.map((p) => ({
          projectId: p.projectId,
          project: p.projectName,
          status: p.projectStatus,
          role: p.role,
          note: p.note
        }))
      }
    }
  },
  {
    name: 'get_document',
    description:
      'The full untrimmed text of one note, meeting write-up, decision or journal entry. Use it after a listing has shown you the one you want.',
    parameters: object(
      {
        kind: { type: 'string', enum: ['note', 'meeting', 'decision', 'journal'] },
        id: str('The id from a listing.')
      },
      ['kind', 'id']
    ),
    writes: false,
    run: async (input, ctx) => {
      const kind = String(input.kind)
      const table = kind === 'journal' ? 'journal_entry' : kind
      // Joined to project so a document outside this workspace simply does not exist.
      const rows = await q<Record<string, unknown>>(
        `SELECT d.*, p.name AS project_name FROM ${table} d
         JOIN project p ON p.id = d.project_id
         WHERE d.id::text = $1 AND p.workspace_id = $2`,
        [String(input.id), ctx.workspaceId]
      )
      const row = rows[0]
      if (!row) throw new Error(`No ${kind} ${String(input.id)} in this workspace.`)
      if (kind !== 'meeting') return row
      // A meeting is only itself with its attendees and its to-do items attached.
      const detail = await invokeChannel('project:get', { id: String(row.project_id), touch: false })
      return detail.meetings.find((m) => m.id === row.id) ?? row
    }
  },
  {
    name: 'meeting_recording',
    description:
      'What a recorded meeting produced: the recap — decisions, commitments and key insights — and, if you ask for it, the transcript itself. Use it when a question is about what was actually said in a room rather than what was written up afterwards.',
    parameters: object(
      {
        meeting: str('The meeting id, from get_project or get_document.'),
        transcript: {
          type: ['boolean', 'null'],
          description: 'Include the full transcript. It is long; leave it off unless the recap is not enough.'
        }
      },
      ['meeting']
    ),
    writes: false,
    run: async (input, ctx) => {
      // Joined back to the workspace, like every other read here: a meeting id from
      // somewhere else is simply not found rather than quietly answered.
      const rows = await q<Record<string, any>>(
        `SELECT r.*, m.title, m.occurred_on FROM recording r
         JOIN meeting m ON m.id = r.meeting_id
         JOIN project p ON p.id = m.project_id
         WHERE r.meeting_id::text = $1 AND p.workspace_id = $2`,
        [String(input.meeting), ctx.workspaceId]
      )
      const row = rows[0]
      if (!row) throw new Error('That meeting has no recording in this workspace.')

      const speakers = row.speakers ?? {}
      const payload: Record<string, unknown> = {
        meeting: row.title,
        occurredOn: row.occurred_on,
        state:
          row.summary_state === 'done'
            ? 'ready'
            : row.transcript_state === 'failed' || row.summary_state === 'failed'
              ? 'failed'
              : 'still being written',
        summary: row.summary,
        ...(row.recap ?? {}),
        durationMinutes: Math.round(Number(row.duration_ms ?? 0) / 60_000),
        audioDeleted: Boolean(row.audio_deleted_at)
      }

      if (input.transcript) {
        const cues = await q<{ speaker: string; text: string }>(
          'SELECT speaker, text FROM transcript_cue WHERE recording_id = $1 ORDER BY ord',
          [row.id]
        )
        const lines: string[] = []
        let current = ''
        for (const cue of cues) {
          const named = speakers[cue.speaker]?.name || cue.speaker
          if (named && named !== current) {
            current = named
            lines.push(`${named}: ${cue.text}`)
          } else if (lines.length) {
            lines[lines.length - 1] += ` ${cue.text}`
          } else {
            lines.push(cue.text)
          }
        }
        payload.transcript = lines.join('\n')
        payload.speakersAreInferred =
          'Speaker labels are worked out from the words rather than from the voices, so treat them as a good guess.'
      }
      return payload
    }
  },
  {
    name: 'recent_activity',
    description: 'What has changed lately across the workspace, newest first.',
    parameters: object({ limit: { type: ['integer', 'null'], description: 'Defaults to 40.' } }),
    writes: false,
    run: async (input, ctx) => {
      const rows = await invokeChannel('dashboard:activity', {
        workspaceId: ctx.workspaceId,
        limit: Math.min(Number(input.limit ?? 40) || 40, 200)
      })
      return rows.map((a) => ({ project: a.projectName, kind: a.kind, summary: a.summary, at: a.createdAt }))
    }
  },

  /* ----------------------------------------------------------------- writing */
  {
    name: 'create_task',
    description: 'Put a new card on a project board. It lands in the first column unless a column is named.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        title: str('What the card says.'),
        details: optional('Longer detail, as Markdown.'),
        dueDate: optional('YYYY-MM-DD.'),
        assignee: optional('Who owns it, by name or id. Leave empty for yourself.'),
        column: optional('The column to drop it into, by name. Defaults to the first.')
      },
      ['project', 'title']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const who = input.assignee ? (await resolvePerson(String(input.assignee), ctx)).name : null
      const due = checkDate(input.dueDate, 'dueDate')
      const parts = [`Add “${String(input.title)}” to ${project.name}`]
      if (who) parts.push(`for ${who}`)
      if (due) parts.push(`due ${due}`)
      return `${parts.join(', ')}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const assignee = input.assignee ? (await resolvePerson(String(input.assignee), ctx)).id : undefined
      let columnId: string | undefined
      if (input.column) {
        const columns = await q<{ id: string; name: string }>(
          'SELECT id, name FROM board_column WHERE project_id = $1 AND name ILIKE $2 ORDER BY sort_order LIMIT 1',
          [project.id, String(input.column)]
        )
        if (!columns[0]) throw new Error(`${project.name} has no column called "${String(input.column)}".`)
        columnId = columns[0].id
      }
      const task = await invokeChannel('task:save', {
        projectId: project.id,
        title: String(input.title),
        details: input.details ? String(input.details) : undefined,
        dueDate: checkDate(input.dueDate, 'dueDate') ?? undefined,
        // Kind follows the assignee rather than being chosen, so the two cannot disagree.
        kind: assignee ? 'delegated' : 'task',
        assigneePersonId: assignee,
        columnId
      })
      return { id: task.id, title: task.title, project: project.name }
    }
  },
  {
    name: 'update_task',
    description: 'Change an existing card — its title, detail, due date or who owns it. Only the fields you pass change.',
    parameters: object(
      {
        id: str('The task id, from a listing.'),
        title: optional('A new title.'),
        details: optional('New detail, as Markdown. Replaces what is there.'),
        dueDate: optional('YYYY-MM-DD, or null to clear it.'),
        assignee: optional('A new owner by name or id, or null to take it back yourself.')
      },
      ['id']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      const changes: string[] = []
      if (input.title) changes.push(`rename it to “${String(input.title)}”`)
      if (input.details !== undefined && input.details !== null) changes.push('rewrite its detail')
      if (input.dueDate !== undefined) {
        const due = checkDate(input.dueDate, 'dueDate')
        changes.push(due ? `set it due ${due}` : 'clear its due date')
      }
      if (input.assignee !== undefined) {
        const who = input.assignee ? (await resolvePerson(String(input.assignee), ctx)).name : null
        changes.push(who ? `hand it to ${who}` : 'take it back yourself')
      }
      const what = changes.length ? changes.join(', ') : 'save it unchanged'
      return `On “${task.title}” in ${task.projectName}: ${what}.`
    },
    run: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      const assigneeGiven = input.assignee !== undefined
      const assignee = input.assignee ? (await resolvePerson(String(input.assignee), ctx)).id : null
      const saved = await invokeChannel('task:save', {
        id: task.id,
        title: input.title ? String(input.title) : undefined,
        details: input.details !== undefined && input.details !== null ? String(input.details) : undefined,
        dueDate: input.dueDate === undefined ? undefined : checkDate(input.dueDate, 'dueDate'),
        assigneePersonId: assigneeGiven ? assignee : undefined,
        kind: assigneeGiven ? (assignee ? 'delegated' : 'task') : undefined
      })
      return { id: saved.id, title: saved.title }
    }
  },
  {
    name: 'set_task_status',
    description: 'Tick a card off, cancel it, or reopen it. Ticking it also moves it into the board’s done column.',
    parameters: object(
      { id: str('The task id.'), status: { type: 'string', enum: ['open', 'done', 'cancelled'] } },
      ['id', 'status']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      const verb =
        input.status === 'done' ? 'Tick off' : input.status === 'cancelled' ? 'Cancel' : 'Reopen'
      return `${verb} “${task.title}” in ${task.projectName}.`
    },
    run: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      const saved = await invokeChannel('task:setStatus', {
        id: task.id,
        status: input.status as 'done'
      })
      return { id: saved.id, status: saved.status }
    }
  },
  {
    name: 'move_task',
    description: 'Move a card to another column on its own board. Moving into the done column ticks it off.',
    parameters: object({ id: str('The task id.'), column: str('The column name.') }, ['id', 'column']),
    writes: true,
    summary: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      return `Move “${task.title}” to ${String(input.column)} in ${task.projectName}.`
    },
    run: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      const columns = await q<{ id: string }>(
        `SELECT c.id FROM board_column c JOIN task t ON t.project_id = c.project_id
         WHERE t.id = $1 AND c.name ILIKE $2 ORDER BY c.sort_order LIMIT 1`,
        [task.id, String(input.column)]
      )
      if (!columns[0]) throw new Error(`${task.projectName} has no column called "${String(input.column)}".`)
      const saved = await invokeChannel('task:setColumn', { id: task.id, columnId: columns[0].id })
      return { id: saved.id, status: saved.status }
    }
  },
  {
    name: 'delete_task',
    description: 'Remove a card outright. Prefer set_task_status — a cancelled card keeps its history.',
    parameters: object({ id: str('The task id.') }, ['id']),
    writes: true,
    destroys: true,
    summary: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      return `Delete “${task.title}” from ${task.projectName}. This cannot be undone.`
    },
    run: async (input, ctx) => {
      const task = await resolveTask(String(input.id), ctx)
      await invokeChannel('task:delete', { id: task.id })
      return { deleted: task.title }
    }
  },
  {
    name: 'write_note',
    description:
      'Write a note on a project, or rewrite one that exists. Notes are Markdown. Pass an id to replace an existing note’s body.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        title: str('The note’s title.'),
        body: str('The note itself, as Markdown.'),
        id: optional('An existing note id to overwrite. Leave empty to write a new one.')
      },
      ['project', 'title', 'body']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const words = String(input.body).trim().split(/\s+/).filter(Boolean).length
      return input.id
        ? `Replace the note “${String(input.title)}” in ${project.name} with ${words} words.`
        : `Write a ${words}-word note, “${String(input.title)}”, in ${project.name}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const note = await invokeChannel('note:save', {
        id: input.id ? String(input.id) : undefined,
        projectId: project.id,
        title: String(input.title),
        body: String(input.body)
      })
      return { id: note.id, title: note.title }
    }
  },
  {
    name: 'write_meeting',
    description:
      'Record a meeting on a project: a Markdown write-up, who was there, and what it left owing. Pass an id to rewrite one.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        title: str('What the meeting was.'),
        occurredOn: optional('YYYY-MM-DD. Defaults to today.'),
        body: str('The write-up, as Markdown.'),
        attendees: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Who was there, by name or id. They must already exist in this workspace.'
        },
        todos: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'What the meeting left owing, one line each. These stay on the meeting, not the board.'
        },
        id: optional('An existing meeting id to rewrite.')
      },
      ['project', 'title', 'body']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const when = checkDate(input.occurredOn, 'occurredOn') ?? today()
      const people = (input.attendees ?? []) as string[]
      const todos = (input.todos ?? []) as string[]
      const parts = [`${input.id ? 'Rewrite' : 'Record'} the meeting “${String(input.title)}” on ${project.name}, dated ${when}`]
      if (people.length) parts.push(`${people.length} attendee${people.length === 1 ? '' : 's'}`)
      if (todos.length) parts.push(`${todos.length} to-do${todos.length === 1 ? '' : 's'}`)
      return `${parts.join(', with ')}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const attendeeIds: string[] = []
      for (const ref of (input.attendees ?? []) as string[]) {
        attendeeIds.push((await resolvePerson(String(ref), ctx)).id)
      }
      const meeting = await invokeChannel('meeting:save', {
        id: input.id ? String(input.id) : undefined,
        projectId: project.id,
        title: String(input.title),
        occurredOn: checkDate(input.occurredOn, 'occurredOn') ?? today(),
        body: String(input.body),
        attendeeIds
      })
      for (const text of (input.todos ?? []) as string[]) {
        if (String(text).trim()) {
          await invokeChannel('meetingTodo:save', { meetingId: meeting.id, text: String(text).trim() })
        }
      }
      return { id: meeting.id, title: meeting.title }
    }
  },
  {
    name: 'promote_meeting_todo',
    description:
      'Put one of a meeting’s to-do items onto the project board. It becomes a card, and the card is what says whether it is finished.',
    parameters: object({ id: str('The meeting to-do id, from get_project or get_document.') }, ['id']),
    writes: true,
    summary: async (input, ctx) => {
      const rows = await q<{ text: string; project_name: string }>(
        `SELECT mt.text, p.name AS project_name FROM meeting_todo mt
         JOIN meeting m ON m.id = mt.meeting_id JOIN project p ON p.id = m.project_id
         WHERE mt.id::text = $1 AND p.workspace_id = $2`,
        [String(input.id), ctx.workspaceId]
      )
      if (!rows[0]) throw new Error(`No meeting to-do ${String(input.id)} in this workspace.`)
      return `Put “${rows[0].text}” on ${rows[0].project_name}’s board as a card.`
    },
    run: async (input) => {
      const meeting = await invokeChannel('meetingTodo:promote', { id: String(input.id) })
      return { meetingId: meeting.id, todos: meeting.todos.length }
    }
  },
  {
    name: 'record_decision',
    description:
      'Log a decision on a project: what was decided, why, and what was turned down. This is the record you will want in three months.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        title: str('What was decided, in one line.'),
        rationale: optional('Why.'),
        alternatives: optional('What else was considered, and why it lost.'),
        decidedBy: optional('Who made the call.'),
        decidedOn: optional('YYYY-MM-DD. Defaults to today.')
      },
      ['project', 'title']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const when = checkDate(input.decidedOn, 'decidedOn') ?? today()
      return `Log the decision “${String(input.title)}” on ${project.name}, dated ${when}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const decision = await invokeChannel('decision:save', {
        projectId: project.id,
        title: String(input.title),
        rationale: input.rationale ? String(input.rationale) : undefined,
        alternatives: input.alternatives ? String(input.alternatives) : undefined,
        decidedBy: input.decidedBy ? String(input.decidedBy) : undefined,
        decidedOn: checkDate(input.decidedOn, 'decidedOn') ?? today()
      })
      return { id: decision.id, title: decision.title }
    }
  },
  {
    name: 'add_journal_entry',
    description: 'Add a dated line to a project’s journal — what happened, in your own words.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        body: str('The entry.'),
        occurredOn: optional('YYYY-MM-DD. Defaults to today.')
      },
      ['project', 'body']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const when = checkDate(input.occurredOn, 'occurredOn') ?? today()
      return `Add a journal entry to ${project.name}, dated ${when}: “${trim(String(input.body), 140)}”`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const entry = await invokeChannel('journal:save', {
        projectId: project.id,
        body: String(input.body),
        occurredOn: checkDate(input.occurredOn, 'occurredOn') ?? today()
      })
      return { id: entry.id }
    }
  },
  {
    name: 'add_link',
    description: 'Add a link to a project’s links hub — its repo, its board, its designs, wherever the work actually lives.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        label: str('What to call it.'),
        url: str('The URL.'),
        kind: {
          type: ['string', 'null'],
          enum: ['repo', 'board', 'design', 'docs', 'chat', 'drive', 'staging', 'other', null]
        }
      },
      ['project', 'label', 'url']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      return `Add the link “${String(input.label)}” (${String(input.url)}) to ${project.name}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const url = String(input.url)
      if (!/^https?:\/\//i.test(url)) throw new Error('A link must be an http or https URL.')
      const link = await invokeChannel('link:save', {
        projectId: project.id,
        label: String(input.label),
        url,
        kind: (input.kind as 'other') ?? 'other'
      })
      return { id: link.id, label: link.label }
    }
  },
  {
    name: 'create_project',
    description: 'Start a new project in this workspace. It arrives with the default board and you on it.',
    parameters: object(
      {
        name: str('The project’s name.'),
        summary: optional('One line saying what it is.'),
        deadline: optional('YYYY-MM-DD, the date the whole thing has to land.')
      },
      ['name']
    ),
    writes: true,
    summary: async (input) => {
      const deadline = checkDate(input.deadline, 'deadline')
      return `Create the project “${String(input.name)}”${deadline ? `, due ${deadline}` : ''}.`
    },
    run: async (input, ctx) => {
      const project = await invokeChannel('project:save', {
        workspaceId: ctx.workspaceId,
        name: String(input.name),
        summary: input.summary ? String(input.summary) : undefined,
        deadline: checkDate(input.deadline, 'deadline') ?? undefined
      })
      return { id: project.id, name: project.name }
    }
  },
  {
    name: 'update_project',
    description: 'Change a project’s name, one-line summary, status or deadline. Only the fields you pass change.',
    parameters: object(
      {
        project: str('The project id, or its name.'),
        name: optional('A new name.'),
        summary: optional('A new one-line summary.'),
        status: { type: ['string', 'null'], enum: ['active', 'paused', 'dormant', 'done', null] },
        deadline: optional('YYYY-MM-DD, or null to clear it.')
      },
      ['project']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const changes: string[] = []
      if (input.name) changes.push(`rename it to “${String(input.name)}”`)
      if (input.summary) changes.push('rewrite its summary')
      if (input.status) changes.push(`set it ${String(input.status)}`)
      if (input.deadline !== undefined) {
        const deadline = checkDate(input.deadline, 'deadline')
        changes.push(deadline ? `set its deadline to ${deadline}` : 'clear its deadline')
      }
      return `On ${project.name}: ${changes.length ? changes.join(', ') : 'save it unchanged'}.`
    },
    run: async (input, ctx) => {
      const project = await resolveProject(String(input.project), ctx)
      const saved = await invokeChannel('project:save', {
        id: project.id,
        name: input.name ? String(input.name) : undefined,
        summary: input.summary !== undefined && input.summary !== null ? String(input.summary) : undefined,
        status: (input.status as 'active') ?? undefined,
        deadline: input.deadline === undefined ? undefined : checkDate(input.deadline, 'deadline')
      })
      return { id: saved.id, name: saved.name }
    }
  },
  {
    name: 'add_person',
    description: 'Add somebody to this workspace’s people, or update what is known about them.',
    parameters: object(
      {
        name: str('Their name.'),
        org: optional('Where they work.'),
        email: optional('Their email.'),
        timezone: optional('Their timezone.'),
        howToWorkWith: optional('"prefers Slack", "no meetings before 10", "actually approves budget".'),
        notes: optional('Anything else.'),
        id: optional('An existing person id to update.')
      },
      ['name']
    ),
    writes: true,
    summary: async (input) =>
      input.id
        ? `Update what is recorded about ${String(input.name)}.`
        : `Add ${String(input.name)}${input.org ? ` (${String(input.org)})` : ''} to this workspace’s people.`,
    run: async (input, ctx) => {
      const person = await invokeChannel('person:save', {
        id: input.id ? String(input.id) : undefined,
        workspaceId: ctx.workspaceId,
        name: String(input.name),
        org: input.org ? String(input.org) : undefined,
        email: input.email ? String(input.email) : undefined,
        timezone: input.timezone ? String(input.timezone) : undefined,
        howToWorkWith: input.howToWorkWith ? String(input.howToWorkWith) : undefined,
        notes: input.notes ? String(input.notes) : undefined
      })
      return { id: person.id, name: person.name }
    }
  },
  {
    name: 'add_person_to_project',
    description: 'Put somebody on a project’s cast, with the hat they wear on it.',
    parameters: object(
      {
        person: str('Their id, or their name.'),
        project: str('The project id, or its name.'),
        role: optional('What they do here — "tech lead", "approves budget".'),
        note: optional('Anything worth knowing about them on this project specifically.')
      },
      ['person', 'project']
    ),
    writes: true,
    summary: async (input, ctx) => {
      const person = await resolvePerson(String(input.person), ctx)
      const project = await resolveProject(String(input.project), ctx)
      return `Put ${person.name} on ${project.name}${input.role ? ` as ${String(input.role)}` : ''}.`
    },
    run: async (input, ctx) => {
      const person = await resolvePerson(String(input.person), ctx)
      const project = await resolveProject(String(input.project), ctx)
      const member = await invokeChannel('membership:save', {
        personId: person.id,
        projectId: project.id,
        role: input.role ? String(input.role) : undefined,
        note: input.note ? String(input.note) : undefined
      })
      return { id: member.id, name: member.name, project: project.name }
    }
  }
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
