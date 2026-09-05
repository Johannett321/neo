import { addDays, exec, q1, today } from '../db/client'
import { mirrorAll } from './markdown'
import { ensureColumns } from './board'
import { ensureMe } from './profile'

/**
 * A realistic starting point, so the app is legible before you have typed anything.
 * Everything here is ordinary demo content — delete it from Settings when you are done.
 */

async function id(sql: string, params: unknown[]): Promise<string> {
  const row = await q1<{ id: string }>(`${sql} RETURNING id`, params)
  if (!row) throw new Error('Insert returned no row')
  return row.id
}

const workspace = (name: string, color: string, sort: number): Promise<string> =>
  id('INSERT INTO workspace (name, color, sort_order) VALUES ($1, $2, $3)', [name, color, sort])

interface ProjectSeed {
  workspaceId: string
  name: string
  summary: string
  status: string
  pinned?: boolean
  /** Left off, the project inherits its workspace's colour — which is the default. */
  color?: string
  deadlineInDays?: number
  activityDaysAgo?: number
  openedDaysAgo?: number
}

async function project(seed: ProjectSeed): Promise<string> {
  const projectId = await id(
    `INSERT INTO project
      (workspace_id, name, summary, status, is_pinned,
       last_activity_at, last_opened_at, previous_opened_at, deadline, color)
     VALUES ($1,$2,$3,$4,$5,
       now() - ($6 || ' days')::interval,
       now() - ($7 || ' days')::interval,
       now() - ($8 || ' days')::interval,
       $9, $10)`,
    [
      seed.workspaceId, seed.name, seed.summary, seed.status, seed.pinned ?? false,
      String(seed.activityDaysAgo ?? 1),
      String(seed.openedDaysAgo ?? 1),
      String((seed.openedDaysAgo ?? 1) + 7),
      seed.deadlineInDays === undefined ? null : addDays(today(), seed.deadlineInDays),
      seed.color ?? ''
    ]
  )
  await ensureColumns(projectId)
  return projectId
}

const person = (
  workspaceId: string, name: string, org: string, email: string, color: string,
  howToWorkWith: string, timezone = 'Europe/Oslo'
): Promise<string> =>
  id(
    `INSERT INTO person (workspace_id, name, org, email, avatar_color, how_to_work_with, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [workspaceId, name, org, email, color, howToWorkWith, timezone]
  )

const member = (personId: string, projectId: string, role: string, note = ''): Promise<void> =>
  exec(
    `INSERT INTO membership (person_id, project_id, role, note)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [personId, projectId, role, note]
  )

interface TaskSeed {
  projectId: string
  title: string
  assignee?: string
  column?: string
  kind?: string
  dueInDays?: number | null
  details?: string
  done?: boolean
  completedDaysAgo?: number
}

async function task(seed: TaskSeed): Promise<void> {
  const due = seed.dueInDays === null || seed.dueInDays === undefined ? null : addDays(today(), seed.dueInDays)
  const kind = seed.kind ?? 'task'
  const columnName = seed.done ? 'Done' : (seed.column ?? 'To do')
  const column = await q1<{ id: string }>(
    'SELECT id FROM board_column WHERE project_id = $1 AND name = $2',
    [seed.projectId, columnName]
  )
  await exec(
    `INSERT INTO task
      (project_id, title, details, kind, status, column_id, due_date,
       assignee_person_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
       CASE WHEN $9::text IS NULL THEN NULL ELSE now() - ($9 || ' days')::interval END)`,
    [
      seed.projectId, seed.title, seed.details ?? '',
      kind, seed.done ? 'done' : 'open', column?.id ?? null, due,
      seed.assignee ?? null,
      seed.done ? String(seed.completedDaysAgo ?? 2) : null
    ]
  )
}

const note = (projectId: string, title: string, body: string, pinned = false): Promise<void> =>
  exec('INSERT INTO note (project_id, title, body, is_pinned) VALUES ($1,$2,$3,$4)', [projectId, title, body, pinned])

const decision = (
  projectId: string, title: string, rationale: string, alternatives: string, by: string, daysAgo: number
): Promise<void> =>
  exec(
    `INSERT INTO decision (project_id, title, rationale, alternatives, decided_by, decided_on)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [projectId, title, rationale, alternatives, by, addDays(today(), -daysAgo)]
  )

const link = (projectId: string, label: string, url: string, kind: string, sort: number): Promise<void> =>
  exec('INSERT INTO link (project_id, label, url, kind, sort_order) VALUES ($1,$2,$3,$4,$5)', [
    projectId, label, url, kind, sort
  ])

async function meeting(
  projectId: string, daysAgo: number, title: string,
  attendees: string[], body: string, todos: string[]
): Promise<void> {
  const meetingId = await id(
    `INSERT INTO meeting (project_id, title, occurred_on, body) VALUES ($1,$2,$3,$4)`,
    [projectId, title, addDays(today(), -daysAgo), body]
  )
  for (const personId of attendees) {
    await exec('INSERT INTO meeting_attendee (meeting_id, person_id) VALUES ($1,$2)', [meetingId, personId])
  }
  for (const [index, text] of todos.entries()) {
    await exec('INSERT INTO meeting_todo (meeting_id, text, sort_order) VALUES ($1,$2,$3)', [
      meetingId, text, index
    ])
  }
}

const journal = (projectId: string, daysAgo: number, body: string): Promise<void> =>
  exec('INSERT INTO journal_entry (project_id, occurred_on, body) VALUES ($1,$2,$3)', [
    projectId, addDays(today(), -daysAgo), body
  ])

const activity = (projectId: string, kind: string, summary: string, daysAgo: number): Promise<void> =>
  exec(
    `INSERT INTO activity (project_id, kind, summary, created_at)
     VALUES ($1,$2,$3, now() - ($4 || ' days')::interval)`,
    [projectId, kind, summary, String(daysAgo)]
  )

/** You, in this workspace — created on demand so the sample cast includes you. */
async function me(workspaceId: string): Promise<string> {
  return ensureMe(workspaceId)
}

export async function loadSampleData(): Promise<void> {
  const existing = await q1<{ n: number }>('SELECT count(*)::int AS n FROM project')
  if (existing && existing.n > 0) return

  const nextSort = (await q1<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM workspace'))?.n ?? 0
  const dayJob = await workspace('Day job', '#6366f1', nextSort)
  const own = await workspace('My company', '#10b981', nextSort + 1)
  const consulting = await workspace('Consultancy', '#f59e0b', nextSort + 2)

  /* ---------------------------------------------------------------- people */
  const mari = await person(dayJob, 'Mari Aalborg', 'Acme Retail', 'mari@acme.example', '#6366f1',
    'Decides fast, but only in writing. Send the one-pager before you ask.')
  const jonas = await person(dayJob, 'Jonas Berg', 'Acme Retail', 'jonas@acme.example', '#0ea5e9',
    'Tech lead on Checkout. Prefers a Slack thread over a meeting; will say no clearly.')
  const priya = await person(dayJob, 'Priya Raman', 'Acme Retail', 'priya@acme.example', '#ec4899',
    'Design. Give her the problem, not the solution. No meetings before 10.')
  const tom = await person(dayJob, 'Tom Lie', 'Acme Retail', 'tom@acme.example', '#f97316',
    'QA lead. Wants the test plan a week ahead or it slips.')
  const ingrid = await person(dayJob, 'Ingrid Solheim', 'Acme Retail', 'ingrid@acme.example', '#8b5cf6',
    'Holds the payments budget. The actual approver, whatever the org chart says.')
  const erik = await person(own, 'Erik Hauge', 'Enthemed', 'erik@enthemed.example', '#10b981',
    'Co-founder. Best thinking happens on a walk, not in a doc.')
  const sofia = await person(own, 'Sofia Nilsen', 'Enthemed', 'sofia@enthemed.example', '#14b8a6',
    'Co-founder, handles the commercial side. Send numbers, not adjectives.')
  const daniel = await person(consulting, 'Daniel Vik', 'Nordic Retail AS', 'daniel@nordicretail.example', '#f59e0b',
    'Client contact. Responsive on email, invisible on Slack. Invoices go to accounts@, not to him.')
  const lena = await person(consulting, 'Lena Fossum', 'Nordic Retail AS', 'lena@nordicretail.example', '#eab308',
    'Their developer. Knows the legacy system better than anyone — ask before you assume.')

  /* ------------------------------------------------------------- day job 1 */
  const checkout = await project({
    workspaceId: dayJob,
    name: 'Checkout rewrite',
    summary: 'Replacing the legacy checkout with the new flow, one market at a time.',
    status: 'active', pinned: true, activityDaysAgo: 0, openedDaysAgo: 0, color: '#f43f5e',
    deadlineInDays: 38
  })

  await member(await me(dayJob), checkout, 'Project manager')
  await member(jonas, checkout, 'Tech lead, Release approver')
  await member(priya, checkout, 'Design, Content')
  await member(mari, checkout, 'Product owner, Stakeholder')
  await member(tom, checkout, 'QA')

  await task({ projectId: checkout, title: 'Sign off 50% traffic ramp for Norway', dueInDays: 0, column: 'In progress' })
  await task({ projectId: checkout, title: 'Error-state designs', kind: 'delegated', assignee: priya, dueInDays: 3 })
  await task({ projectId: checkout, title: 'Swedish tax rules — confirm with finance', dueInDays: -3, column: 'In progress', details: 'Jonas is blocked until this lands.' })
  await task({ projectId: checkout, title: 'Prepare the leadership demo', dueInDays: 4 })
  await task({ projectId: checkout, title: 'Load test the new payment adapter', dueInDays: 6, column: 'In progress', assignee: jonas })
  await task({ projectId: checkout, title: 'Write up the Denmark rollout options', dueInDays: 9 })
  await task({ projectId: checkout, title: 'Norway 25% ramp', done: true, completedDaysAgo: 2 })
  await task({ projectId: checkout, title: 'Test plan review with Tom', kind: 'delegated', dueInDays: 2, assignee: tom })

  await decision(checkout, 'Roll out market by market rather than all at once',
    'A single big-bang cutover puts every market at risk on the same night, and we cannot staff that. ' +
    'Sequential rollout costs about three extra weeks but keeps the blast radius to one country.',
    'Big-bang cutover; feature-flag by user segment instead of by market.', 'Mari, with Jonas', 22)
  await decision(checkout, 'Keep the legacy checkout running until Q2',
    'Rollback has to stay one config change away until every market has been stable for a full month.',
    'Delete it immediately after Norway went live.', 'Me', 9)

  await note(checkout, 'Sweden tax rules — what we know',
    'The rate depends on the delivery address, not the billing address, which the legacy system got wrong for ' +
    'about 4% of orders. Finance knows. Ingrid has the correct table but it lives in a spreadsheet.\n\n' +
    'Jonas needs this as a proper reference table before he can finish the adapter.', true)
  await note(checkout, 'Leadership demo — running order',
    '1. Why we are doing this (2 min)\n2. Norway numbers so far (3 min)\n3. Live walkthrough (5 min)\n' +
    '4. What is blocked and what I need (5 min)\n\nDo not demo the error states. They are not done.')

  await link(checkout, 'Jira board', 'https://example.atlassian.net/jira/software/board/1', 'board', 0)
  await link(checkout, 'Figma — checkout flow', 'https://figma.com/file/example', 'design', 1)
  await link(checkout, 'checkout-service repo', 'https://github.com/example/checkout-service', 'repo', 2)
  await link(checkout, '#checkout-rewrite', 'https://slack.com/app_redirect?channel=checkout-rewrite', 'chat', 3)
  await link(checkout, 'Staging', 'https://staging.example.com/checkout', 'staging', 4)

  await meeting(checkout, 3, 'Weekly checkout sync',
    [jonas, priya, tom],
    '## Norway ramp\n\nRamp to 25% held overnight with no incidents.\n\n## Sweden\n\n' +
    'Jonas walked through the tax problem — the legacy behaviour is wrong, so matching it is not an ' +
    'option.\n\n## Error states\n\nPriya has them half done and is waiting on copy.',
    ['Get the Swedish rules confirmed with Ingrid this week',
     'Priya: error states by Friday',
     'Tom: test plan draft for the 50% ramp'])
  await meeting(checkout, 17, 'Rollout planning',
    [mari, jonas],
    'Agreed market-by-market rather than a single cutover. Mari wants Norway first because support is ' +
    'strongest there.\n\n> Rollback has to stay one config change away.',
    ['Write up the Denmark options', 'Jonas: keep the legacy path behind a flag'])

  await journal(checkout, 2, 'Norway ramp to 25% went through with no incidents. Conversion is flat, which is the ' +
    'result we wanted — nobody notices a good checkout.')
  await journal(checkout, 6, 'Jonas raised the Swedish tax problem in standup. Bigger than it looked: the legacy ' +
    'behaviour was wrong, so "match the old system" is not an option.')
  await activity(checkout, 'task_completed', 'Completed: Norway 25% ramp', 2)
  await activity(checkout, 'decision', 'Decision: Keep the legacy checkout running until Q2', 9)

  /* ------------------------------------------------------------- day job 2 */
  const payments = await project({
    workspaceId: dayJob,
    name: 'Payments migration',
    summary: 'Moving off the old PSP before the contract ends.',
    status: 'active', activityDaysAgo: 5, openedDaysAgo: 5, color: '#0ea5e9',
    deadlineInDays: 12
  })
  await member(await me(dayJob), payments, 'Project manager')
  await member(ingrid, payments, 'Budget owner')
  await member(jonas, payments, 'Tech lead')
  await task({ projectId: payments, title: 'Read the old PSP termination clause', dueInDays: 4 })
  await task({ projectId: payments, title: 'Two developers named for the integration', kind: 'delegated', assignee: ingrid, dueInDays: -2 })
  await task({ projectId: payments, title: 'Draft the migration plan', dueInDays: -1 })
  await link(payments, 'Provider docs', 'https://example.com/psp/docs', 'docs', 0)
  await note(payments, 'Why this is riskier than it looks',
    'Nobody has read the old contract termination clause end to end. If there is a notice period we have already ' +
    'missed, the date is not March, it is sooner.')

  /* ------------------------------------------------------------- day job 3 */
  const tooling = await project({
    workspaceId: dayJob,
    name: 'Internal tooling',
    summary: 'The deploy dashboard and the on-call rota tool. I still write code on this one.',
    status: 'active', activityDaysAgo: 26, openedDaysAgo: 26
  })
  await member(await me(dayJob), tooling, 'Developer')
  await member(tom, tooling, 'Occasional contributor')
  await task({ projectId: tooling, title: 'Finish the rota CSV import', dueInDays: -18 })
  await task({ projectId: tooling, title: 'Upgrade the dashboard to the new auth', dueInDays: null })
  await link(tooling, 'internal-tools repo', 'https://github.com/example/internal-tools', 'repo', 0)
  await journal(tooling, 26, 'Got the import parsing correct but the deduplication is wrong when someone changes ' +
    'team mid-month. Left it half-done. Note to self: the failing case is in the test file already.')

  /* ------------------------------------------------------------ my company */
  const platform = await project({
    workspaceId: own,
    name: 'Enthemed platform',
    summary: 'The product itself. Erik on engineering, Sofia commercial, me in between.',
    status: 'active', pinned: true, activityDaysAgo: 1, openedDaysAgo: 1
  })
  await member(await me(own), platform, 'Co-founder, CEO')
  await member(erik, platform, 'Co-founder, engineering')
  await member(sofia, platform, 'Co-founder, commercial')
  await task({ projectId: platform, title: 'Monthly numbers to Sofia', kind: 'delegated', dueInDays: 0 })
  await task({ projectId: platform, title: 'App review submission', dueInDays: 3 })
  await task({ projectId: platform, title: 'Board pack ready', dueInDays: 7 })
  await task({ projectId: platform, title: 'Cost out the support automation', kind: 'delegated', assignee: erik, dueInDays: 2 })
  await decision(platform, 'Stay bootstrapped through this year',
    'Raising now prices the round off a revenue number we are not proud of yet. Another two quarters of growth ' +
    'changes the conversation entirely, and we can fund ourselves until then.',
    'Raise a small angel round now; take on debt against revenue.', 'Me, Erik and Sofia', 40)
  await meeting(platform, 6, 'Founders catch-up',
    [erik, sofia],
    'Support tickets are up and it is the same three questions every time. Erik thinks two of them are ' +
    'automatable in a week. Sofia would rather we hire part-time help so we keep hearing from customers.',
    ['Erik: cost out the automation', 'Decide by the board call'])
  await link(platform, 'Analytics', 'https://example.com/analytics', 'docs', 0)
  await link(platform, 'Repo', 'https://github.com/example/platform', 'repo', 1)
  await journal(platform, 1, 'Support tickets are up again and it is the same three questions. Automating those ' +
    'is worth more than any feature we could ship this month.')

  /* ----------------------------------------------------------- consultancy */
  const nordic = await project({
    workspaceId: consulting,
    name: 'Nordic Retail — integration',
    summary: 'Building the order sync between their ERP and the webshop. Fixed-price, phase two.',
    status: 'active', activityDaysAgo: 9, openedDaysAgo: 9,
    deadlineInDays: 54
  })
  await member(await me(consulting), nordic, 'Consultant, Developer')
  await member(daniel, nordic, 'Client contact', 'Signs off the invoices, not Lena.')
  await member(lena, nordic, 'Their developer')
  await task({ projectId: nordic, title: 'Phase-two quote to Daniel', dueInDays: 1 })
  await task({ projectId: nordic, title: 'Chase the phase-one invoice', kind: 'delegated', assignee: daniel, dueInDays: -6 })
  await task({ projectId: nordic, title: 'Document the edge cases Lena sent', dueInDays: 5 })
  await task({ projectId: nordic, title: 'Phase-two kickoff pack', dueInDays: 13 })
  await decision(nordic, 'Fixed price per phase, not per hour',
    'They wanted a single fixed price for the whole thing on a scope nobody could describe yet. Per-phase pricing ' +
    'keeps their budget predictable and stops me absorbing the discovery risk.',
    'Time and materials; one fixed price for everything.', 'Me and Daniel', 75)
  await note(nordic, 'Scope boundary — read before quoting',
    'Phase one covered order sync one way, ERP to webshop. Returns, partial shipments and the old order backfill ' +
    'were explicitly out. Everything Lena has raised since sits in that excluded list.', true)
  await link(nordic, 'Contract (Drive)', 'https://drive.example.com/nordic-contract', 'drive', 0)
  await link(nordic, 'Integration repo', 'https://github.com/example/nordic-sync', 'repo', 1)
  await journal(nordic, 9, 'Lena walked me through the returns flow. It is genuinely complicated and genuinely ' +
    'not what we agreed. Priced as a change request, not absorbed.')

  await mirrorAll()
}
