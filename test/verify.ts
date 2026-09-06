import { ipcMain, __handlers } from 'electron'
import { initDb, closeDb, clearStrandedTriggers, orphanedForeignKeys } from '../src/main/db/client'
import { registerWorkspaceHandlers } from '../src/main/ipc/workspaces'
import { registerProjectHandlers } from '../src/main/ipc/projects'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerMeetingHandlers } from '../src/main/ipc/meetings'
import { registerRecordingHandlers } from '../src/main/ipc/recordings'
import { registerPeopleHandlers } from '../src/main/ipc/people'
import { registerContentHandlers } from '../src/main/ipc/content'
import { registerDashboardHandlers } from '../src/main/ipc/dashboard'
import { registerSearchHandlers } from '../src/main/ipc/search'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { registerChatHandlers } from '../src/main/ipc/chat'
import { registerMcpHandlers } from '../src/main/ipc/mcp'
import { TOOLS } from '../src/main/lib/ai/tools'
import { PANELS, clampPanelWidth } from '../src/shared/panels'
import { callTool, describeTools, endpointFile, startBridge, stopBridge } from '../src/main/lib/mcp/bridge'
import { apiOnly } from '../src/main/lib/ai/run'
import { invokeChannel } from '../src/main/ipc/util'
import { announceChange, onChange } from '../src/main/lib/changes'
import { attentionReason } from '../src/main/lib/attention'
import { kick, reapDeadCaptures, recoverRecordings } from '../src/main/lib/recording/pipeline'
import { recapMarkdown } from '../src/main/lib/recording/summarise'
import { pruneRecordings, recordingDir } from '../src/main/lib/recording/store'
import { helperPath } from '../src/main/lib/recording/systemAudio'
import { exec, q } from '../src/main/db/client'
import { request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeEndpoint } from '@shared/mcp'

const call = async (channel: string, input?: unknown): Promise<any> => {
  const fn = (__handlers as Map<string, any>).get(channel)
  if (!fn) throw new Error(`No handler: ${channel}`)
  return fn({}, input)
}

/** Poll until something is ready, for the pipeline, which runs on its own clock. */
const until = async <T>(check: () => Promise<T | null>, tries = 60): Promise<T | null> => {
  for (let i = 0; i < tries; i++) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

/** True when the call failed with a message saying what it should have said. */
const threw = async (fn: () => Promise<unknown>, contains: string): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch (e) {
    return String((e as Error).message).includes(contains)
  }
}

const ok = (label: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

async function main(): Promise<void> {
  await initDb()
  void ipcMain
  registerWorkspaceHandlers()
  registerProjectHandlers()
  registerTaskHandlers()
  registerPeopleHandlers()
  registerContentHandlers()
  registerMeetingHandlers()
  registerRecordingHandlers()
  registerDashboardHandlers()
  registerSearchHandlers()
  registerSettingsHandlers()
  registerMcpHandlers()
  registerChatHandlers()

  ok('a fresh database has no workspaces', (await call('workspace:list')).length === 0)

  // What the first-run introduction is gated on. It has to be written down rather
  // than inferred from an empty database, because deleting your last workspace after
  // a year of use empties it too and must not re-pitch the app at you.
  ok('a fresh database has never been through onboarding',
     (await call('settings:get')).onboardedAt === '')
  const machineName = await call('profile:suggestName')
  ok('the machine offers a name to start the profile off with',
     typeof machineName.name === 'string', JSON.stringify(machineName.name))

  // A foreign-key trigger whose constraint has gone missing makes every insert into
  // that table fail with "cache lookup failed for constraint", and the database opens
  // perfectly beforehand — so the check that catches it has to run on every launch.
  ok('the schema leaves no foreign key without its constraint',
     (await orphanedForeignKeys()).length === 0, (await orphanedForeignKeys()).join(', '))

  await call('settings:loadSample')
  const workspaces = await call('workspace:list')
  ok('sample data creates its own workspaces', workspaces.length === 3,
     workspaces.map((w: any) => w.name).join(', '))

  const ws = (name: string): string => workspaces.find((w: any) => w.name === name).id
  const dayJob = ws('Day job')
  const own = ws('My company')
  const consultancy = ws('Consultancy')

  const projects = await call('project:list', { workspaceId: dayJob, status: 'all' })
  ok('project list is fenced to one workspace', projects.length === 3,
     projects.map((p: any) => p.name).join(', '))
  ok('the other workspaces hold the rest',
     (await call('project:list', { workspaceId: own, status: 'all' })).length === 1 &&
     (await call('project:list', { workspaceId: consultancy, status: 'all' })).length === 1)
  ok('projects carry a cast preview for their card',
     projects.every((p: any) => Array.isArray(p.castPreview)) &&
     projects.find((p: any) => p.name === 'Checkout rewrite').castPreview.length === 5)
  ok('projects report why they want a look, never a status someone typed',
     projects.every((p: any) => 'attention' in p))

  const flagged = projects.filter((p: any) => p.attention !== null)
  ok('some projects are asking for one', flagged.length > 0,
     flagged.map((p: any) => `${p.name}: ${p.attention}`).join(' | '))
  ok('an overdue project says how much is late',
     flagged.some((p: any) => /overdue item/.test(p.attention)),
     flagged.map((p: any) => p.attention).join(' | '))

  // Only the most pressing fact is reported, so the tiers below it are exercised
  // directly rather than by hunting for a sample project in each state.
  const reason = (over: number, still: number, deadline: number | null = null): string | null =>
    attentionReason({
      status: 'active', openTasks: 2, overdueTasks: over,
      worstOverdueDays: over > 0 ? 4 : 0, daysSinceActivity: still, deadlineDays: deadline
    })
  ok('overdue outranks everything else', /overdue item/.test(reason(2, 40, 1) ?? ''), String(reason(2, 40, 1)))
  ok('a near deadline comes next', /deadline in 3 days/.test(reason(0, 40, 3) ?? ''), String(reason(0, 40, 3)))
  ok('a project nobody has touched is standing still',
     reason(0, 12) === 'standing still for 12 days', String(reason(0, 12)))
  ok('a week is the line', reason(0, 6) === null && reason(0, 7) !== null)
  ok('a project doing fine says nothing at all', reason(0, 1, 60) === null, String(reason(0, 1, 60)))
  ok('and one paused on purpose is never dragged back',
     attentionReason({ status: 'paused', openTasks: 9, overdueTasks: 9, worstOverdueDays: 90,
                       daysSinceActivity: 90, deadlineDays: -5 }) === null)

  const idle = projects.find((p: any) => p.name === 'Internal tooling')

  // A colour is optional and inherited until set; it must survive a round trip.
  const painted = await call('project:save', { id: idle.id, color: '#0ea5e9' })
  ok('a project can be given its own colour', painted.color === '#0ea5e9', painted.color)

  /*
   * A task view carries its project's colour alongside its workspace's. On any
   * workspace-fenced list — which is every list there is — the workspace colour is
   * identical on every row, so it is the project's that tells one row from another.
   */
  const paintedTasks = await call('task:list', { projectId: idle.id })
  ok('a task carries the colour of the project it belongs to',
     paintedTasks.length > 0 && paintedTasks.every((t: any) => t.projectColor === '#0ea5e9'),
     `${paintedTasks.length} tasks`)

  ok('and can hand it back to the workspace',
     (await call('project:save', { id: idle.id, color: '' })).color === '')
  const unpaintedTasks = await call('task:list', { projectId: idle.id })
  ok('a task on a project with no colour of its own falls back to the workspace',
     unpaintedTasks.length > 0 &&
     unpaintedTasks.every((t: any) => t.projectColor === '' && t.workspaceColor !== ''))

  /* ------------------------------------------------------------------- folders */

  ok('a workspace starts with no folders', (await call('folder:list', { workspaceId: dayJob })).length === 0)

  const clients = await call('folder:save', { workspaceId: dayJob, name: 'Clients' })
  const acme = await call('folder:save', { workspaceId: dayJob, name: 'Acme', parentId: clients.id })
  const folderTree = await call('folder:list', { workspaceId: dayJob })
  ok('a folder can hold another folder',
     folderTree.length === 2 &&
     folderTree[0].id === clients.id && folderTree[0].depth === 0 &&
     folderTree[1].id === acme.id && folderTree[1].depth === 1,
     folderTree.map((f: any) => f.path.join('/')).join(', '))
  ok('and it comes back knowing where it sits',
     folderTree[1].path.join('/') === 'Clients/Acme')
  ok('folders are fenced to their workspace like everything else',
     (await call('folder:list', { workspaceId: own })).length === 0)
  ok('a folder needs a name', await threw(() => call('folder:save', { workspaceId: dayJob, name: '  ' }),
                                          'needs a name'))

  const filed = await call('project:save', { id: idle.id, folderId: acme.id })
  ok('a project can be filed in a folder', filed.folderId === acme.id)
  ok('and says so on the card it is drawn from',
     (await call('project:list', { workspaceId: dayJob })).find((p: any) => p.id === idle.id).folderId === acme.id)
  ok('the folder counts what is filed in it',
     (await call('folder:list', { workspaceId: dayJob })).find((f: any) => f.id === acme.id).projectCount === 1)

  // Workspace isolation is the one boundary nothing crosses, filing included.
  const elsewhere = await call('folder:save', { workspaceId: own, name: 'Somewhere else' })
  ok('a project cannot be filed in another workspace\u2019s folder',
     await threw(() => call('project:save', { id: idle.id, folderId: elsewhere.id }), 'another workspace'))
  ok('and a folder cannot be moved into one either',
     await threw(() => call('folder:save', { id: acme.id, parentId: elsewhere.id }), 'another workspace'))
  ok('a folder cannot be moved inside itself',
     await threw(() => call('folder:save', { id: clients.id, parentId: acme.id }), 'inside itself'))
  ok('nor inside itself directly',
     await threw(() => call('folder:save', { id: clients.id, parentId: clients.id }), 'inside itself'))
  // Left where it is on purpose: the assistant's own fencing is checked against it
  // further down, and a folder that has been deleted proves nothing.
  void elsewhere

  /*
   * Deleting a folder is undoing the filing and nothing else: what was inside comes
   * up a level. A folder that could take a project with it would be a second way to
   * lose one, hidden behind a word that sounds like tidying up.
   */
  const doomedFolder = await call('folder:save', { workspaceId: dayJob, name: 'Temporary' })
  await call('folder:save', { id: clients.id, parentId: doomedFolder.id })
  const spare = await call('project:save', { workspaceId: dayJob, name: 'Filed away', status: 'active' })
  await call('project:save', { id: spare.id, folderId: doomedFolder.id })
  await call('folder:delete', { id: doomedFolder.id })
  const lifted = await call('folder:list', { workspaceId: dayJob })
  ok('deleting a folder lifts its subfolders up rather than taking them with it',
     lifted.length === 2 && lifted.find((f: any) => f.id === clients.id)?.parentId === null)
  ok('and its projects come up with them, filed nowhere',
     (await call('project:list', { workspaceId: dayJob })).find((p: any) => p.id === spare.id).folderId === null)
  ok('the project itself is untouched',
     (await call('project:list', { workspaceId: dayJob })).some((p: any) => p.id === spare.id))
  await call('project:delete', { id: spare.id })

  const today = await call('dashboard:today', { workspaceId: dayJob })
  ok('today: overdue populated', today.overdue.length >= 3, `${today.overdue.length} overdue`)
  ok('today: due today populated', today.dueToday.length >= 1, `${today.dueToday.length} due today`)
  ok('every kind is either a task or delegated',
     [...today.overdue, ...today.dueToday, ...today.soon].every((t: any) => ['task', 'delegated'].includes(t.kind)))

  const dayJobNames = new Set(projects.map((p: any) => p.name))
  const everyTaskShown = [...today.overdue, ...today.dueToday, ...today.soon]
  ok('today shows nothing from another workspace',
     everyTaskShown.every((t: any) => dayJobNames.has(t.projectName)),
     everyTaskShown.map((t: any) => t.projectName).filter((n: string) => !dayJobNames.has(n)).join(', ') || 'clean')
  ok('needs-attention is fenced too',
     today.needsAttention.every((p: any) => dayJobNames.has(p.name)))
  ok('stats count only this workspace', today.stats.activeProjects === 3 && today.stats.peopleTracked === 6,
     `${today.stats.activeProjects} projects, ${today.stats.peopleTracked} people`)

  const checkout = projects.find((p: any) => p.name === 'Checkout rewrite')
  const payments = projects.find((p: any) => p.name === 'Payments migration')
  const detail = await call('project:get', { id: checkout.id })
  ok('project detail: cast with roles', detail.cast.length === 5,
     detail.cast.map((c: any) => `${c.name}=${c.role}`).join(', '))
  ok('you sort first in a project cast', detail.cast[0].isMe === true, detail.cast[0].name)
  ok('project detail: nobody carries a hand-set escalation flag any more',
     detail.cast.every((c: any) => !('isEscalation' in c)), Object.keys(detail.cast[0]).join(', '))
  let refusedSelfRemoval = false
  try {
    await call('membership:delete', { id: detail.cast[0].id })
  } catch {
    refusedSelfRemoval = true
  }
  ok('you cannot be removed from your own project', refusedSelfRemoval)
  ok('project detail: links', detail.links.length === 5)
  ok('project detail: decisions', detail.decisions.length === 2)
  ok('project detail: notes', detail.notes.length === 2 && detail.notes[0].isPinned === true)
  ok('project detail: journal', detail.journal.length === 2)
  ok('project detail: meetings with attendees', detail.meetings.length === 2 &&
     detail.meetings[0].attendees.length === 3,
     detail.meetings.map((m: any) => `${m.title}(${m.attendees.length})`).join(', '))
  ok('a meeting carries its to-do items, and says how many are still owed',
     detail.meetings[0].todos.length === 3 && detail.meetings[0].openTodos === 3 &&
     detail.meetings[0].todos.every((t: any) => t.taskId === null),
     detail.meetings[0].todos.map((t: any) => t.text).join(' | '))
  ok('meeting attendees carry their project role',
     detail.meetings[0].attendees.every((a: any) => typeof a.role === 'string') &&
     detail.meetings[0].attendees.some((a: any) => a.role.includes('Tech lead')),
     detail.meetings[0].attendees.map((a: any) => `${a.name}=${a.role}`).join(', '))
  ok('a project gets the default board', detail.columns.length === 4 &&
     detail.columns.map((c: any) => c.name).join(' > ') === 'To do > In progress > In review > Done',
     detail.columns.map((c: any) => c.name).join(' > '))
  ok('exactly one column is the finishing line',
     detail.columns.filter((c: any) => c.isDone).length === 1 &&
     detail.columns[3].isDone === true)
  ok('cards start on the board', detail.tasks.every((t: any) => t.columnId !== null))

  ok('project detail: brief has changes', detail.brief.changes.length > 0,
     `${detail.brief.changes.length} changes since previous visit`)

  const dormant = projects.find((p: any) => p.name === 'Internal tooling')
  const dormantDetail = await call('project:get', { id: dormant.id })
  ok('re-entry brief triggers on return', dormantDetail.brief.isReturning === true,
     `${dormantDetail.brief.daysSinceOpened} days since opened`)

  const openTask = detail.tasks.find((t: any) => t.status === 'open' && t.kind === 'task')
  await call('task:setStatus', { id: openTask.id, status: 'done' })
  const after = await call('project:get', { id: checkout.id })
  ok('completing a task logs activity',
     after.activity.some((a: any) => a.kind === 'task_completed' && a.summary.includes(openTask.title)))

  // The note writer saves itself while you type, so the log must not fill with a line
  // per keystroke — repeated saves of one note inside half an hour are a single line,
  // carrying whatever the note is called by the time you stop.
  const draft = await call('note:save', { projectId: checkout.id, title: 'Draft', body: 'first' })
  const afterFirst = await call('project:get', { id: checkout.id })
  ok('writing a note logs it',
     afterFirst.activity.filter((a: any) => a.kind === 'note' && a.summary.startsWith('Note: Draft')).length === 1,
     afterFirst.activity.filter((a: any) => a.kind === 'note').map((a: any) => a.summary).join(' | '))

  await call('note:save', { id: draft.id, projectId: checkout.id, title: 'Draft', body: 'second' })
  await call('note:save', { id: draft.id, projectId: checkout.id, title: 'Draft note', body: 'third' })
  const afterMore = await call('project:get', { id: checkout.id })
  ok('saving it again does not log it again',
     afterMore.activity.filter((a: any) => a.kind === 'note' && a.summary.startsWith('Note: Draft')).length === 1,
     afterMore.activity.filter((a: any) => a.kind === 'note').map((a: any) => a.summary).join(' | '))
  ok('and the one line follows the title',
     afterMore.activity.some((a: any) => a.summary === 'Note: Draft note'))

  const other = await call('note:save', { projectId: checkout.id, title: 'A different note', body: '' })
  const afterOther = await call('project:get', { id: checkout.id })
  ok('a different note is its own line',
     afterOther.activity.filter((a: any) => a.kind === 'note' && a.summary.startsWith('Note: ')).length === 2,
     afterOther.activity.filter((a: any) => a.kind === 'note').map((a: any) => a.summary).join(' | '))
  await call('note:delete', { id: draft.id })
  await call('note:delete', { id: other.id })

  const todoColumn = detail.columns[0]
  const doingColumn = detail.columns[1]
  const doneColumn = detail.columns[3]
  const boardTask = detail.tasks.find((t: any) => t.columnId === todoColumn.id && t.status === 'open')
  const moved = await call('task:setColumn', { id: boardTask.id, columnId: doneColumn.id })
  ok('dropping a card in the done column ticks the task',
     moved.columnId === doneColumn.id && moved.status === 'done')
  const movedBack = await call('task:setColumn', { id: boardTask.id, columnId: doingColumn.id })
  ok('dragging it back out reopens it',
     movedBack.columnId === doingColumn.id && movedBack.status === 'open')
  const ticked = await call('task:setStatus', { id: boardTask.id, status: 'done' })
  ok('ticking it elsewhere moves the card to the done column', ticked.columnId === doneColumn.id)
  await call('task:setStatus', { id: boardTask.id, status: 'open' })

  // --- columns are the project's own
  const extra = await call('column:save', { projectId: checkout.id, name: 'Blocked' })
  ok('a column can be added', extra.name === 'Blocked' && extra.sortOrder === 4)
  await call('column:save', { id: extra.id, name: 'On hold' })
  await call('column:reorder', {
    ids: [extra.id, ...detail.columns.map((c: any) => c.id)]
  })
  const reordered = (await call('project:get', { id: checkout.id })).columns
  ok('renamed and reordered', reordered[0].name === 'On hold', reordered.map((c: any) => c.name).join(' > '))

  await call('task:setColumn', { id: boardTask.id, columnId: extra.id })
  await call('column:delete', { id: extra.id })
  const afterColumnDelete = await call('project:get', { id: checkout.id })
  ok('deleting a column keeps its cards',
     afterColumnDelete.columns.length === 4 &&
     afterColumnDelete.tasks.some((t: any) => t.id === boardTask.id),
     `${afterColumnDelete.columns.length} columns, card survived`)
  ok('and moves them to the first column',
     afterColumnDelete.tasks.find((t: any) => t.id === boardTask.id).columnId ===
       afterColumnDelete.columns[0].id)

  let refusedLastColumn = false
  const soloProject = await call('project:save', { workspaceId: dayJob, name: 'Solo board', status: 'active' })
  const soloColumns = (await call('project:get', { id: soloProject.id })).columns
  for (const c of soloColumns.slice(1)) await call('column:delete', { id: c.id })
  try {
    await call('column:delete', { id: soloColumns[0].id })
  } catch {
    refusedLastColumn = true
  }
  ok('a board keeps at least one column', refusedLastColumn)
  await call('project:delete', { id: soloProject.id })

  const newMeeting = await call('meeting:save', {
    projectId: checkout.id,
    title: 'Verification stand-up',
    attendeeIds: detail.cast.slice(0, 2).map((c: any) => c.personId)
  })
  ok('a new meeting records who was there', newMeeting.attendees.length === 2,
     newMeeting.attendees.map((a: any) => a.name).join(', '))
  await call('meeting:delete', { id: newMeeting.id })
  ok('meetings can be removed',
     (await call('project:get', { id: checkout.id })).meetings.length === 2)

  // --- a meeting's to-do items, and the one that turns out to be real work
  const sync = detail.meetings[0]
  const withItem = await call('meetingTodo:save', { meetingId: sync.id, text: 'Chase the tax ruling' })
  ok('a to-do can be added to a meeting', withItem.todos.length === 4 &&
     withItem.todos[3].text === 'Chase the tax ruling',
     withItem.todos.map((t: any) => t.text).join(' | '))
  const item = withItem.todos[3]

  const tickedItem = await call('meetingTodo:save', { id: item.id, done: true })
  ok('a loose to-do answers for itself',
     tickedItem.todos[3].done === true && tickedItem.openTodos === 3)
  await call('meetingTodo:save', { id: item.id, done: false })

  const promoted = await call('meetingTodo:promote', { id: item.id })
  const card = promoted.todos[3]
  ok('a to-do can be put on the board', card.taskId !== null && card.taskColumn === 'To do',
     `${card.taskId} in ${card.taskColumn}`)
  const boardTasks = await call('task:list', { projectId: checkout.id })
  const promotedTask = boardTasks.find((t: any) => t.id === card.taskId)
  ok('and arrives as a real card that says where it came from',
     promotedTask?.title === 'Chase the tax ruling' &&
     /Weekly checkout sync/.test(promotedTask?.details ?? ''),
     promotedTask?.details)
  ok('promoting twice is not two cards',
     (await call('meetingTodo:promote', { id: item.id })).todos[3].taskId === card.taskId)

  // The card is the one that knows, so the two screens can never disagree.
  await call('task:setStatus', { id: card.taskId, status: 'done' })
  const afterBoard = (await call('project:get', { id: checkout.id })).meetings[0]
  ok('ticking the card ticks the item on the meeting',
     afterBoard.todos[3].done === true && afterBoard.todos[3].taskColumn === 'Done',
     JSON.stringify(afterBoard.todos[3]))
  const untickedHere = await call('meetingTodo:save', { id: item.id, done: false })
  ok('and unticking the item on the meeting reopens the card',
     untickedHere.todos[3].done === false &&
     (await call('task:list', { projectId: checkout.id }))
       .find((t: any) => t.id === card.taskId)?.status === 'open')

  const detached = await call('meetingTodo:save', { id: item.id, taskId: null })
  ok('an item can be taken off the board, and the card stays there',
     detached.todos[3].taskId === null &&
     (await call('task:list', { projectId: checkout.id })).some((t: any) => t.id === card.taskId))

  /* ------------------------------------------------------------------ recording
   *
   * The pipeline itself is not exercised here — it calls out to a transcription
   * service, and a test that needs one is a test that does not run. What *is*
   * exercised is everything that has to be true whether or not that service ever
   * answers: that the audio is on disk, that the timeline adds up, that a capture
   * cut off by a power failure comes back as something you can resume, and that a
   * transcript survives its audio being deleted.
   */
  const recMeeting = await call('meeting:save', {
    projectId: checkout.id,
    title: 'Recorded steering call',
    occurredOn: '2024-05-02'
  })

  const started = await call('recording:start', { meetingId: recMeeting.id })
  ok('recording a meeting starts one capture, still running',
     started.captureState === 'recording' && started.segmentCount === 0)
  ok('pressing record twice picks the same capture back up rather than opening a second',
     (await call('recording:start', { meetingId: recMeeting.id })).id === started.id)

  // What the renderer does every second: claim a file, hand over bytes, and be told
  // how big the file is now. Every byte is flushed before the call resolves.
  const seg1 = await call('recording:openSegment', { id: started.id })
  const appended = await call('recording:appendChunk', {
    segmentId: seg1.segmentId,
    data: Buffer.from('first-second-of-audio').toString('base64')
  })
  await call('recording:appendChunk', {
    segmentId: seg1.segmentId,
    data: Buffer.from('-and-the-next').toString('base64')
  })
  ok('audio is appended to the segment file and its size reported back',
     appended.bytes === 21 && existsSync(join(recordingDir(), started.id, '0000.webm')),
     `${appended.bytes} bytes after the first chunk`)

  await call('recording:closeSegment', { segmentId: seg1.segmentId, durationMs: 300_000 })
  const seg2 = await call('recording:openSegment', { id: started.id })
  await call('recording:appendChunk', {
    segmentId: seg2.segmentId,
    data: Buffer.from('after-the-rollover').toString('base64')
  })
  await call('recording:closeSegment', { segmentId: seg2.segmentId, durationMs: 120_000 })

  const twoParts = await call('recording:get', { meetingId: recMeeting.id })
  ok('a rolled-over recording is two files on one timeline',
     twoParts.recording.segments.length === 2 &&
     twoParts.recording.segments[0].offsetMs === 0 &&
     twoParts.recording.segments[1].offsetMs === 300_000 &&
     twoParts.recording.durationMs === 420_000,
     `${twoParts.recording.durationMs} ms across ${twoParts.recording.segments.length} parts`)
  ok('the size shown is the size on disk, summed over the parts',
     twoParts.recording.bytes === 34 + 18, String(twoParts.recording.bytes))

  // The machine loses power. Nothing gets to run; the rows are simply as they were.
  const interruptedCount = await recoverRecordings()
  const afterCrash = await call('recording:get', { meetingId: recMeeting.id })
  ok('a capture that was running when the app died comes back as interrupted, not lost',
     interruptedCount === 1 && afterCrash.recording.captureState === 'interrupted' &&
     afterCrash.recording.bytes === 52,
     afterCrash.recording.captureState)

  // ...and it can be picked back up, appending to the audio that is already there.
  await call('recording:resume', { id: started.id })
  const seg3 = await call('recording:openSegment', { id: started.id })
  await call('recording:appendChunk', {
    segmentId: seg3.segmentId,
    data: Buffer.from('the-meeting-carried-on').toString('base64')
  })
  await call('recording:closeSegment', { segmentId: seg3.segmentId, durationMs: 60_000 })
  const resumed = await call('recording:get', { meetingId: recMeeting.id })
  ok('resuming an interrupted capture keeps what was already recorded and adds to it',
     resumed.recording.segments.length === 3 &&
     resumed.recording.segments[2].offsetMs === 420_000 &&
     resumed.recording.durationMs === 480_000)

  // A renderer that dies without the app dying stops sending its heartbeat.
  await exec(`UPDATE recording SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [
    started.id
  ])
  await reapDeadCaptures()
  ok('a capture whose window went away is marked interrupted by main on its own',
     (await call('recording:get', { meetingId: recMeeting.id })).recording.captureState === 'interrupted')

  const stopped = await call('recording:stop', { id: started.id, durationMs: 480_000 })
  ok('stopping closes every open segment and hands the recording to the pipeline',
     stopped.captureState === 'stopped' &&
     (await q<any>('SELECT closed FROM recording_segment WHERE recording_id = $1', [stopped.id]))
       .every((row: any) => row.closed))

  /*
   * This workspace has no API key, so the pipeline that just picked the recording up
   * cannot transcribe it. What matters is that it stops and says why in words a
   * person can act on, rather than retrying a wrong key every twenty seconds until
   * the end of time.
   */
  const settled = await until(async () => {
    const row = (await q<any>('SELECT transcript_state, transcript_error FROM recording WHERE id = $1',
                              [stopped.id]))[0]
    return ['done', 'failed'].includes(row.transcript_state) ? row : null
  })
  ok('a recording it cannot transcribe fails once, permanently, and says what to fix',
     settled?.transcript_state === 'failed' && /API key/i.test(settled.transcript_error ?? ''),
     settled?.transcript_error)
  ok('a stopped recording refuses to be recorded over',
     await threw(() => call('recording:start', { meetingId: recMeeting.id }), 'already has a recording'))
  // Deleting the audio is only ever a trade of sound for words. Before the words
  // exist there is nothing to trade, so it is refused rather than quietly obeyed.
  ok('audio cannot be thrown away before it has been turned into words',
     await threw(() => call('recording:deleteAudio', { id: stopped.id }), 'not been transcribed'))

  // Stand in for the transcription and the recap, which need a service to produce.
  const recordingId = stopped.id
  for (const [i, line] of ['Shall we ship on Friday?', 'Yes. I will do the release notes.'].entries()) {
    await exec(
      `INSERT INTO transcript_cue (recording_id, ord, start_ms, end_ms, speaker, text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [recordingId, i, i * 5000, i * 5000 + 4000, `Speaker ${i + 1}`, line]
    )
  }
  await exec(
    `UPDATE recording SET transcript_state = 'done', transcript_model = 'whisper-1',
            speaker_state = 'done', speakers = $2::jsonb, summary_state = 'done',
            summary = $3, recap = $4::jsonb
     WHERE id = $1`,
    [
      recordingId,
      JSON.stringify({ 'Speaker 1': { name: '', personId: null }, 'Speaker 2': { name: '', personId: null } }),
      'A short call about the release.',
      JSON.stringify({
        decisions: [{ what: 'Ship on Friday', who: 'Ida' }],
        commitments: [{ who: 'Ida', what: 'Write the release notes', due: '' }],
        insights: ['Nobody has checked the migration yet.']
      })
    ]
  )

  const speakerNamed = await call('recording:nameSpeaker', {
    id: recordingId,
    label: 'Speaker 2',
    name: 'Ida Berg'
  })
  ok('a speaker is named once, against the label rather than against every line',
     speakerNamed.speakers['Speaker 2'].name === 'Ida Berg' &&
     (await q<any>('SELECT speaker FROM transcript_cue WHERE recording_id = $1 ORDER BY ord', [recordingId]))[1]
       .speaker === 'Speaker 2')

  /*
   * A recap that sits behind a button on a second screen is a recap nobody reads, so
   * the pipeline folds it into the meeting itself the moment it is written: into the
   * write-up, onto the name if there is not one, and onto the to-do list for every
   * commitment somebody made out loud. All of it through the ordinary channels, so
   * what arrives is indistinguishable from what you would have typed.
   */
  await exec(`UPDATE recording SET suggested_title = 'Friday release call' WHERE id = $1`, [
    recordingId
  ])
  await exec(`UPDATE meeting SET title = '' WHERE id = $1`, [recMeeting.id])

  ok('a recap that has not been folded into its meeting yet says so',
     (await call('recording:get', { meetingId: recMeeting.id })).recording.recapWrittenAt === null)

  const applied = await call('recording:applyRecap', { id: recordingId })
  ok('the recap lands in the write-up on its own, as ordinary Markdown',
     applied.body.includes('Ship on Friday') && applied.body.includes('release notes'),
     applied.body.replace(/\n/g, ' ').slice(0, 70))
  ok('and a meeting nobody named is given the name the recap suggested',
     applied.title === 'Friday release call', applied.title)
  ok('someone saying they will do something becomes one of the meeting\'s to-do items',
     applied.todos.some((t: any) => t.text.includes('Write the release notes') && t.text.includes('Ida')),
     applied.todos.map((t: any) => t.text).join(' | '))

  ok('and once it has been, it says that instead',
     (await call('recording:get', { meetingId: recMeeting.id })).recording.recapWrittenAt !== null)

  const again = await call('recording:applyRecap', { id: recordingId })
  ok('folding it in twice changes nothing — after the first time the write-up is yours',
     again.body === applied.body && again.todos.length === applied.todos.length)

  // A name you typed is never replaced by one a model came up with.
  await exec(
    `UPDATE recording SET recap_written_at = NULL, suggested_title = 'Something else' WHERE id = $1`,
    [recordingId]
  )
  await exec(`UPDATE meeting SET title = 'The name I gave it' WHERE id = $1`, [recMeeting.id])
  const renamed = await call('recording:applyRecap', { id: recordingId })
  ok('a meeting you have named keeps the name you gave it', renamed.title === 'The name I gave it')
  ok('and a commitment already on the list is not added to it again',
     renamed.todos.filter((t: any) => t.text.includes('release notes')).length === 1,
     renamed.todos.map((t: any) => t.text).join(' | '))

  /*
   * The same thing again, but the way it actually happens: nobody calls the channel.
   * A recap sitting in the database with neither marker set is a row the runner finds
   * and finishes on its own — which is what carries a recap written by an older build,
   * or one whose meeting was busy at the time, over the line.
   */
  await exec(
    `UPDATE recording SET recap_written_at = NULL, recap_todos_at = NULL, recap = $2::jsonb
     WHERE id = $1`,
    [
      recordingId,
      JSON.stringify({
        decisions: [],
        commitments: [{ who: 'Tom', what: 'Book the migration window', due: '' }],
        insights: []
      })
    ]
  )
  await exec(`UPDATE meeting SET body = '' WHERE id = $1`, [recMeeting.id])
  kick()

  const folded = await until(async () => {
    const view = await call('recording:get', { meetingId: recMeeting.id })
    return view.recording.recapWrittenAt ? view : null
  })
  const byRunner = await call('project:get', { id: checkout.id, touch: false })
  const runnerMeeting = byRunner.meetings.find((m: any) => m.id === recMeeting.id)
  ok('the runner folds a waiting recap in on its own, with nobody pressing anything',
     Boolean(folded) && runnerMeeting.body.includes('Book the migration window') &&
     runnerMeeting.todos.some((t: any) => t.text.includes('Book the migration window')),
     runnerMeeting?.todos.map((t: any) => t.text).join(' | '))

  /*
   * The two halves are marked off separately, and this is why: a to-do list that
   * failed to be written must be retried without the write-up gaining a second copy
   * of the recap. Clearing only the to-do marker is exactly that situation.
   */
  const bodyOnce = runnerMeeting.body
  await exec(`UPDATE recording SET recap_todos_at = NULL WHERE id = $1`, [recordingId])
  await call('recording:applyRecap', { id: recordingId })
  const retried = (await call('project:get', { id: checkout.id, touch: false }))
    .meetings.find((m: any) => m.id === recMeeting.id)
  ok('retrying the to-do half does not append the recap to the write-up twice',
     retried.body === bodyOnce &&
     retried.todos.filter((t: any) => t.text.includes('Book the migration window')).length === 1)

  // Asking for the recap again means you want the new answer on the to-do list — but
  // not a second copy of it in a write-up you have been editing.
  await call('recording:retry', { id: recordingId, step: 'summary' })
  const afterRetry = (await q<any>(
    'SELECT recap_written_at, recap_todos_at FROM recording WHERE id = $1', [recordingId]
  ))[0]
  ok('asking for the recap again reopens the to-do list but not the write-up',
     afterRetry.recap_written_at !== null && afterRetry.recap_todos_at === null)
  // Put it back the way it was: what follows is about a finished recording, and a
  // test that leaves the world half-rewritten behind it is a test that fails the
  // next one for reasons that have nothing to do with the next one.
  await exec(
    `UPDATE recording SET summary_state = 'done', recap_todos_at = now() WHERE id = $1`,
    [recordingId]
  )

  ok('a meeting carries its recording, so a list can say what state it is in',
     (await call('project:get', { id: checkout.id, touch: false }))
       .meetings.find((m: any) => m.id === recMeeting.id)?.recording?.summaryState === 'done')

  /*
   * A cascade in the database frees no disk. Deleting a meeting takes its recording
   * row with it through the foreign keys, and the audio — the only large thing this
   * app writes — would sit in the folder forever if nothing went and got it.
   */
  const mistake = await call('meeting:save', {
    projectId: checkout.id,
    title: 'Recorded by mistake',
    occurredOn: '2024-05-03'
  })
  const scrap = await call('recording:start', { meetingId: mistake.id })
  const scrapSegment = await call('recording:openSegment', { id: scrap.id })
  await call('recording:appendChunk', {
    segmentId: scrapSegment.segmentId,
    data: Buffer.from('forty-minutes-of-a-keyboard').toString('base64')
  })
  const scrapDir = join(recordingDir(), scrap.id)
  ok('a recording in progress has a folder of its own on disk', existsSync(scrapDir))

  await call('meeting:delete', { id: mistake.id })
  ok('deleting a meeting takes its audio off the disk, not just its rows',
     !existsSync(scrapDir))

  // The backstop, for audio orphaned by a route that forgot to sweep — and it must
  // only ever take the folders that no row answers for.
  const orphan = join(recordingDir(), '00000000-0000-4000-8000-00000000dead')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, '0000.webm'), 'stale')
  const survivor = join(recordingDir(), recordingId)
  const swept = await pruneRecordings()
  ok('the sweep removes audio no recording answers for, and only that',
     swept === 1 && !existsSync(orphan) && existsSync(survivor),
     `${swept} folder(s) swept`)

  // The whole point of keeping the words separately from the sound.
  const stripped = await call('recording:deleteAudio', { id: recordingId })
  const stillThere = await call('recording:get', { meetingId: recMeeting.id })
  ok('deleting the audio frees the disk and keeps every word of the transcript',
     stripped.bytes === 0 && stripped.audioDeletedAt !== null &&
     !existsSync(join(recordingDir(), recordingId)) &&
     stillThere.cues.length === 2 && stillThere.recording.summary !== '',
     `${stillThere.cues.length} lines kept`)

  ok('the recap renders the same Markdown everywhere it is written',
     recapMarkdown('A short call.', {
       decisions: [{ what: 'Ship on Friday', who: 'Ida' }],
       commitments: [{ who: 'Ida', what: 'Write the release notes', due: '2024-05-03' }],
       insights: []
     }).includes('- **Ida**: Write the release notes (by 2024-05-03)'))

  /*
   * The native audio tap: a helper binary, not a module, so the question the app has
   * to answer before it offers anything is simply whether the file is there. In a
   * headless test it is — the build put it in `out/native` — and the answer must not
   * depend on `app.isPackaged`, which lies in development because dev-branding
   * renames the executable.
   */
  ok('the app can say whether it is able to record the computer\'s own sound',
     typeof (await call('systemAudio:available')).available === 'boolean')
  ok('and finds the helper by looking for the file rather than by asking if it is packaged',
     process.platform !== 'darwin' || existsSync(helperPath()) === (await call('systemAudio:available')).available,
     helperPath() || '(no helper built)')

  // What a recording listens to is about this machine, not about a working life, so
  // it lives in app settings beside the theme rather than on the workspace.
  const audio = await call('settings:save', {
    captureSystemAudio: false,
    systemAudioDevice: 'BlackHole 2ch'
  })
  ok('what a recording listens to is remembered on this machine',
     audio.captureSystemAudio === false && audio.systemAudioDevice === 'BlackHole 2ch')
  ok('and trying to catch the computer\'s own sound is on until it is turned off',
     (await call('settings:save', { captureSystemAudio: true })).captureSystemAudio === true)

  const engines = await call('workspace:save', {
    id: dayJob,
    transcribeEngine: 'local',
    transcribeBaseUrl: 'http://127.0.0.1:9000/v1',
    recapPrompt: 'Only the decisions, nothing else.'
  })
  ok('a workspace chooses its own engines, and they come back on the workspace',
     engines.transcribeEngine === 'local' &&
     engines.transcribeBaseUrl === 'http://127.0.0.1:9000/v1' &&
     engines.recapPrompt === 'Only the decisions, nothing else.')

  // A to-do agreed in a room is on no board and carries no date, so nothing else on
  // Today would ever raise it. The workspace screen carries it up itself.
  const owedNow = await call('dashboard:today', { workspaceId: dayJob })
  const owedHere = owedNow.owedFromMeetings.find((m: any) => m.meetingId === withItem.id)
  ok('Today carries what a meeting still owes',
     Boolean(owedHere) && owedHere.openTodos === 4 && owedHere.projectName === 'Checkout rewrite',
     `${owedHere?.openTodos} owing on "${owedHere?.title}"`)

  // Promoted items are answered by their card here too, exactly as the meeting list
  // counts them — asking the row's own `done` would report closed work as owing.
  await call('meetingTodo:promote', { id: item.id })
  const promotedCard = (await call('project:get', { id: checkout.id, touch: false }))
    .meetings[0].todos[3]
  await call('task:setStatus', { id: promotedCard.taskId, status: 'done' })
  const afterClosing = await call('dashboard:today', { workspaceId: dayJob })
  ok('closing the card it became stops Today counting it',
     afterClosing.owedFromMeetings.find((m: any) => m.meetingId === withItem.id)?.openTodos === 3,
     `${afterClosing.owedFromMeetings.find((m: any) => m.meetingId === withItem.id)?.openTodos} left`)

  ok('what a meeting owes never crosses a workspace',
     (await call('dashboard:today', { workspaceId: own }))
       .owedFromMeetings.every((m: any) => m.projectId !== checkout.id))

  await call('task:setStatus', { id: promotedCard.taskId, status: 'open' })
  await call('meetingTodo:save', { id: item.id, taskId: null })
  await call('task:delete', { id: promotedCard.taskId })

  await call('meetingTodo:delete', { id: item.id })
  ok('a to-do can be removed',
     (await call('project:get', { id: checkout.id })).meetings[0].todos.length === 3)
  await call('task:delete', { id: card.taskId })

  const created = await call('task:save', { projectId: checkout.id, title: 'Lands in the first column' })
  ok('a new task lands in the first column', created.columnId === detail.columns[0].id)

  const hits = await call('search:query', { workspaceId: dayJob, q: 'tax' })
  ok('search finds across types', hits.length >= 2, hits.map((h: any) => `${h.kind}:${h.title}`).join(' | '))
  ok('search finds people', (await call('search:query', { workspaceId: dayJob, q: 'Priya' }))
     .some((h: any) => h.kind === 'person'))
  ok('search cannot reach another workspace',
     (await call('search:query', { workspaceId: dayJob, q: 'Lena' })).length === 0 &&
     (await call('search:query', { workspaceId: consultancy, q: 'Lena' })).length > 0)

  const dayJobPeople = await call('person:list', { workspaceId: dayJob })
  ok('people are fenced to their workspace',
     dayJobPeople.length === 6 &&
     (await call('person:list', { workspaceId: own })).length === 3 &&
     (await call('person:list', { workspaceId: consultancy })).length === 3,
     `${dayJobPeople.length} in Day job`)

  // Assigning work offers the project's cast, not everyone in the workspace: an item
  // belongs to one project, so the people who can own it are the people on it.
  const checkoutDetail = await call('project:get', { id: checkout.id, touch: false })
  const checkoutCast = await call('person:list', { workspaceId: dayJob, projectId: checkout.id })
  ok('person:list narrows to a project\'s cast',
     checkoutCast.length === checkoutDetail.cast.length &&
     checkoutCast.length < dayJobPeople.length &&
     checkoutCast.every((p: any) => checkoutDetail.cast.some((c: any) => c.personId === p.id)),
     `${checkoutCast.length} on the project, ${dayJobPeople.length} in the workspace`)

  ok('you are always among them, so work can be kept',
     checkoutCast.some((p: any) => p.isMe))

  // Somebody in the workspace but not on this project must not be offered for it.
  const offProject = dayJobPeople.find(
    (p: any) => !checkoutCast.some((c: any) => c.id === p.id))
  ok('a workspace colleague who is not on the project is not offered',
     Boolean(offProject) && !checkoutCast.some((p: any) => p.id === offProject.id),
     offProject?.name)

  // The project id is joined back to the workspace rather than trusted, so one from
  // another workspace narrows the list to nothing instead of widening it.
  const foreign = await call('person:list', { workspaceId: own, projectId: checkout.id })
  ok('a project from another workspace matches nobody', foreign.length === 0,
     `${foreign.length} returned`)

  const person = dayJobPeople.find((p: any) => p.name === 'Jonas Berg')
  const personDetail = await call('person:get', { id: person.id })
  ok('person shows every project and role', personDetail.projects.length === 2,
     personDetail.projects.map((p: any) => `${p.projectName}=${p.role}`).join(', '))

  const reopened = await call('project:get', { id: dormant.id })
  ok('brief survives an immediate re-open',
     reopened.brief.changes.length === dormantDetail.brief.changes.length &&
     reopened.brief.isReturning === dormantDetail.brief.isReturning,
     'previous_opened_at not rolled within the same visit')

  // The hand-maintained where-we-are block is gone; nothing on a project is a field
  // you have to keep rewriting, so a save must not smuggle one back in.
  const saved = await call('project:save', { id: checkout.id, summary: 'Rewritten by the verification run.' })
  ok('a project carries no hand-maintained state block',
     !('currentState' in saved) && !('nextAction' in saved) && !('openQuestions' in saved),
     Object.keys(saved).join(', '))
  ok('the summary is what a project says about itself',
     saved.summary === 'Rewritten by the verification run.')

  /*
   * A killed process can leave a foreign-key trigger behind whose constraint is gone.
   * The table then refuses every insert with "cache lookup failed for constraint N"
   * and keeps refusing, so the repair has to tell two cases apart: debris left by a
   * table that no longer exists, which is safe to remove, and a real foreign key that
   * lost its row, which must not be quietly abandoned.
   */
  {
    const { PGlite } = await import('@electric-sql/pglite')
    const scratch = new PGlite()
    await scratch.waitReady
    await scratch.exec(`
      CREATE TABLE parent (id int PRIMARY KEY);
      CREATE TABLE gone (id int PRIMARY KEY);
      CREATE TABLE child (
        id int PRIMARY KEY,
        parent_id int REFERENCES parent(id),
        gone_id int REFERENCES gone(id)
      );
      INSERT INTO parent VALUES (1);
    `)
    // Debris: the constraint row goes, and the table it referenced is no longer
    // anything pg_class answers to — which is what a dropped table leaves behind.
    const goneFk = (await scratch.query<any>(
      `SELECT oid FROM pg_constraint WHERE conname = 'child_gone_id_fkey'`)).rows[0].oid
    // A dropped table takes its own two triggers with it; the two on the other side
    // are the ones left stranded, which is exactly the shape the real damage had.
    await scratch.query(`DELETE FROM pg_trigger WHERE tgconstraint = $1 AND tgrelid = 'gone'::regclass`, [goneFk])
    await scratch.query(`UPDATE pg_trigger SET tgconstrrelid = 999999 WHERE tgconstraint = $1`, [goneFk])
    await scratch.query(`DELETE FROM pg_constraint WHERE oid = $1`, [goneFk])
    // A real one: the referenced table is alive, only the constraint row is missing.
    await scratch.query(`DELETE FROM pg_constraint WHERE conname = 'child_parent_id_fkey'`)

    const before = await orphanedForeignKeys(scratch)
    ok('a lost foreign key is noticed', before.includes('child'), before.join(', '))

    const cleared = await clearStrandedTriggers(scratch)
    ok('only the debris is removed', cleared === 2, `${cleared} trigger(s)`)
    ok('a foreign key whose table still exists is left alone, not silently abandoned',
       (await orphanedForeignKeys(scratch)).includes('child'))

    const survivors = await scratch.query<any>(
      `SELECT count(*)::int AS n FROM pg_trigger t
       WHERE t.tgrelid = 'child'::regclass AND t.tgconstraint <> 0`)
    ok('the surviving triggers are the real key\'s', survivors.rows[0].n === 2, String(survivors.rows[0].n))
    await scratch.close()
  }

  const settings = await call('settings:save', { theme: 'dark', activeWorkspaceId: consultancy })
  ok('settings round-trip', settings.theme === 'dark' && settings.activeWorkspaceId === consultancy)

  // Every side panel remembers its own width, and each one falls back to its own
  // default rather than to whatever the last panel written happened to be.
  const widths = await call('settings:save', { sidebarWidth: 264, meetingWidth: 380 })
  ok('every panel width is remembered separately',
     widths.sidebarWidth === 264 &&
     widths.meetingWidth === 380 &&
     widths.assistantWidth === PANELS.assistant.default,
     `${widths.sidebarWidth}/${widths.assistantWidth}/${widths.meetingWidth}`)
  ok('a dragged width survives a reload',
     (await call('settings:get')).sidebarWidth === 264)
  ok('a panel is clamped to its own bounds, and to the window',
     clampPanelWidth('assistant', 10_000, 4000) === PANELS.assistant.max &&
     clampPanelWidth('sidebar', 10, 4000) === PANELS.sidebar.min &&
     clampPanelWidth('meeting', 520, 900) === 400)

  const finished = new Date().toISOString()
  await call('settings:save', { onboardedAt: finished })
  ok('finishing onboarding is remembered across launches',
     (await call('settings:get')).onboardedAt === finished)
  ok('the app version is reported, not stored',
     settings.appVersion === '0.0.0-test' &&
     (await call('settings:save', { appVersion: '9.9.9' } as any)).appVersion === '0.0.0-test')

  const throwaway = await call('workspace:save', { name: 'Throwaway', color: '#000000' })
  ok('a new workspace starts empty apart from you',
     (await call('project:list', { workspaceId: throwaway.id, status: 'all' })).length === 0 &&
     (await call('person:list', { workspaceId: throwaway.id })).length === 1 &&
     (await call('person:list', { workspaceId: throwaway.id }))[0].isMe === true)
  await call('project:save', { workspaceId: throwaway.id, name: 'Doomed', status: 'active' })
  await call('person:save', { workspaceId: throwaway.id, name: 'Doomed Person' })
  await call('workspace:delete', { id: throwaway.id })
  const afterDelete = await call('workspace:list')
  const dayJobPeopleAfter = await call('person:list', { workspaceId: dayJob })
  ok('deleting a workspace takes its projects and people with it',
     afterDelete.length === 3 && dayJobPeopleAfter.length === 6,
     `${afterDelete.length} workspaces (${afterDelete.map((w: any) => w.name).join('/')}), ${dayJobPeopleAfter.length} day-job people`)

  // --- you, as a person in every workspace
  const profile = await call('profile:get')
  ok('there is a profile', typeof profile.name === 'string', profile.name)
  const renamedProfile = await call('profile:save', { name: 'Johan' })
  ok('the profile can be renamed', renamedProfile.name === 'Johan')
  for (const ws of [dayJob, own, consultancy]) {
    const mine = (await call('person:list', { workspaceId: ws })).filter((p: any) => p.isMe)
    ok(`exactly one of you exists in each workspace`, mine.length === 1 && mine[0].name === 'Johan',
       `${mine.length} in one workspace`)
  }
  ok('you are listed first among people',
     (await call('person:list', { workspaceId: dayJob }))[0].isMe === true)
  const mePerson = (await call('person:list', { workspaceId: dayJob })).find((p: any) => p.isMe)
  let refusedSelfDelete = false
  try {
    await call('person:delete', { id: mePerson.id })
  } catch {
    refusedSelfDelete = true
  }
  ok('you cannot delete yourself', refusedSelfDelete)

  ok('you carry roles on a project', checkout.myRoles === 'Project manager', checkout.myRoles)
  const mineUpdated = await call('membership:saveMine', {
    projectId: checkout.id, role: 'Project manager, Release approver'
  })
  ok('and can edit them', mineUpdated.role === 'Project manager, Release approver')
  ok('which shows up on the project card',
     (await call('project:list', { workspaceId: dayJob }))
       .find((p: any) => p.id === checkout.id).myRoles === 'Project manager, Release approver')

  const freshProject = await call('project:save', { workspaceId: dayJob, name: 'Brand new', status: 'active' })
  ok('a new project already has you on it',
     (await call('project:get', { id: freshProject.id })).cast.some((c: any) => c.name === 'Johan'))
  await call('project:delete', { id: freshProject.id })

  // --- tasks can be assigned, including to yourself
  const assigned = await call('task:save', {
    projectId: checkout.id, title: 'Assigned to me', assigneePersonId: mePerson.id
  })
  ok('a task can be assigned', assigned.assigneePersonId === mePerson.id)
  const assignedView = (await call('project:get', { id: checkout.id })).tasks
    .find((t: any) => t.id === assigned.id)
  ok('and the assignee comes back resolved',
     assignedView.assigneeName === 'Johan' && assignedView.assigneeIsMe === true,
     `${assignedView.assigneeName}, isMe=${assignedView.assigneeIsMe}`)
  await call('task:delete', { id: assigned.id })

  // --- people, roles and deadlines
  ok('a person carries multiple roles on a project',
     detail.cast.find((c: any) => c.name === 'Jonas Berg').role === 'Tech lead, Release approver')
  const roleVocabulary = await call('membership:roles', { workspaceId: dayJob })
  ok('roles used in the workspace are offered back as suggestions',
     roleVocabulary.includes('Tech lead') && roleVocabulary.includes('Release approver') &&
     roleVocabulary.length === new Set(roleVocabulary).size,
     roleVocabulary.join(' | '))
  ok('role suggestions do not leak between workspaces',
     !(await call('membership:roles', { workspaceId: consultancy })).includes('Release approver'))

  const reusable = (await call('person:list', { workspaceId: dayJob }))
    .find((p: any) => p.name === 'Tom Lie')
  await call('membership:save', {
    personId: reusable.id, projectId: payments.id, role: 'QA, Release approver'
  })
  const payDetail = await call('project:get', { id: payments.id })
  ok('an existing person can be reused on another project without duplicating them',
     payDetail.cast.some((c: any) => c.personId === reusable.id) &&
     (await call('person:list', { workspaceId: dayJob })).length === 6)
  ok('and keeps their own identity while taking a different role there',
     payDetail.cast.find((c: any) => c.personId === reusable.id).role === 'QA, Release approver' &&
     detail.cast.find((c: any) => c.personId === reusable.id).role === 'QA')

  ok('projects carry a deadline', checkout.deadline !== null, String(checkout.deadline))
  ok('a project with work behind it reports that, deadline or no deadline',
     /overdue item/.test(payDetail.project.attention ?? ''), String(payDetail.project.attention))
  const cleared = await call('project:save', { id: payments.id, deadline: null })
  ok('and can be cleared', cleared.deadline === null)

  ok('people expose an avatar field everywhere they appear',
     'avatar' in detail.cast[0] && 'avatar' in detail.meetings[0].attendees[0] &&
     'avatar' in projects[0].castPreview[0])

  // --- pausing
  //
  // Paused is the one state the user sets by hand, and the whole of what it buys is
  // that Today stops asking. So the assertion is about the screen, not the column.
  const beforePause = await call('dashboard:today', { workspaceId: dayJob })
  const itsWork = [...beforePause.overdue, ...beforePause.dueToday, ...beforePause.soon]
    .filter((t: any) => t.projectName === 'Payments migration')
  const openInIt = (await call('project:list', { workspaceId: dayJob }))
    .find((p: any) => p.id === payments.id).openTasks
  ok('a project has work on Today before it is paused', itsWork.length > 0, `${itsWork.length} items`)

  await call('project:save', { id: payments.id, status: 'paused' })
  const whilePaused = await call('dashboard:today', { workspaceId: dayJob })
  ok('pausing a project takes every one of its items off Today',
     ![...whilePaused.overdue, ...whilePaused.dueToday, ...whilePaused.soon]
       .some((t: any) => t.projectName === 'Payments migration'))
  ok('and stops it asking to be looked at',
     !whilePaused.needsAttention.some((p: any) => p.id === payments.id))
  ok('and what a meeting left owing in it goes too',
     !whilePaused.owedFromMeetings.some((m: any) => m.projectId === payments.id))
  ok('and the count in the header drops by exactly what it held',
     whilePaused.stats.openTasks === beforePause.stats.openTasks - openInIt,
     `${whilePaused.stats.openTasks} of ${beforePause.stats.openTasks}, minus ${openInIt}`)
  ok('and it is no longer counted as an active project',
     whilePaused.stats.activeProjects === beforePause.stats.activeProjects - 1)
  ok('the log says when it was put down',
     (await call('project:get', { id: payments.id, touch: false }))
       .activity.some((a: any) => a.summary === 'Paused'))
  ok('but its own screens still hold everything',
     (await call('project:get', { id: payments.id, touch: false })).tasks.length > 0)

  await call('project:save', { id: payments.id, status: 'active' })
  const afterPause = await call('dashboard:today', { workspaceId: dayJob })
  ok('picking it back up brings its work straight back',
     afterPause.stats.openTasks === beforePause.stats.openTasks &&
     [...afterPause.overdue, ...afterPause.dueToday, ...afterPause.soon]
       .filter((t: any) => t.projectName === 'Payments migration').length === itsWork.length)
  ok('and the log says that too',
     (await call('project:get', { id: payments.id, touch: false }))
       .activity.some((a: any) => a.summary === 'Picked back up'))
  await call('project:save', { id: payments.id, status: 'active' })
  ok('and a save that sends the same status again writes nothing at all',
     (await call('project:get', { id: payments.id, touch: false })).activity
       .filter((a: any) => a.summary === 'Picked back up').length === 1)

  // --- archiving and deleting
  const tooling = projects.find((p: any) => p.name === 'Internal tooling')
  await call('project:setArchived', { id: tooling.id, archived: true })
  const visible = await call('project:list', { workspaceId: dayJob })
  ok('an archived project leaves the project list', !visible.some((p: any) => p.id === tooling.id),
     visible.map((p: any) => p.name).join(', '))
  ok('and can be listed on its own',
     (await call('project:list', { workspaceId: dayJob, archived: true }))
       .some((p: any) => p.id === tooling.id))
  const archivedToday = await call('dashboard:today', { workspaceId: dayJob })
  ok('an archived project drops out of Today',
     ![...archivedToday.overdue, ...archivedToday.dueToday, ...archivedToday.soon]
       .some((t: any) => t.projectName === 'Internal tooling'))
  ok('and out of the project count Today reports',
     archivedToday.stats.activeProjects === today.stats.activeProjects - 1,
     `${archivedToday.stats.activeProjects} of ${today.stats.activeProjects}`)
  ok('and out of search',
     (await call('search:query', { workspaceId: dayJob, q: 'rota' })).length === 0)
  ok('but it still opens', (await call('project:get', { id: tooling.id })).project.name === 'Internal tooling')

  await call('project:setArchived', { id: tooling.id, archived: false })
  ok('restoring brings it back',
     (await call('project:list', { workspaceId: dayJob })).some((p: any) => p.id === tooling.id) &&
     (await call('search:query', { workspaceId: dayJob, q: 'rota' })).length > 0)

  const archivedWorkspace = await call('workspace:setArchived', { id: own, archived: true })
  ok('a workspace can be archived', archivedWorkspace.archivedAt !== null)
  ok('its data is untouched while archived',
     (await call('project:list', { workspaceId: own, status: 'all' })).length === 1)
  ok('restoring a workspace clears the flag',
     (await call('workspace:setArchived', { id: own, archived: false })).archivedAt === null)

  const doomed = await call('project:save', { workspaceId: dayJob, name: 'Doomed project', status: 'active' })
  await call('project:delete', { id: doomed.id })
  ok('a project can be deleted outright',
     !(await call('project:list', { workspaceId: dayJob, status: 'all' })).some((p: any) => p.id === doomed.id))

  /*
   * The assistant. Everything except the model call itself is exercised here: the
   * conversations, the tools, and the workspace fence they all sit behind. What is
   * deliberately *not* tested is the run loop, which needs a key and a network.
   */
  const otherProject = (await call('project:list', { workspaceId: own, status: 'all' }))[0]

  ok('a workspace starts with no key and no conversations',
     (await call('workspace:list')).every((w: any) => w.aiKeySet === false) &&
     (await call('chat:list', { workspaceId: dayJob })).length === 0)

  await call('chat:setKey', { workspaceId: dayJob, apiKey: 'sk-test-not-a-real-key' })
  const keyed = (await call('workspace:list')).find((w: any) => w.id === dayJob)
  ok('a saved key is reported as set but never handed back',
     keyed.aiKeySet === true && !('aiApiKey' in keyed) && JSON.stringify(keyed).indexOf('sk-test') === -1)

  ok('sending without a key says so rather than failing obscurely',
     await threw(() => call('chat:send', { workspaceId: own, text: 'hello' }), 'no API key'))

  // Conversations are rows like anything else, so they are checked without a model.
  const conversation = await q<{ id: string }>(
    'INSERT INTO conversation (workspace_id, title) VALUES ($1, $2) RETURNING id', [dayJob, 'A chat'])
  const conversationId = conversation[0].id
  ok('conversations are listed in their own workspace only',
     (await call('chat:list', { workspaceId: dayJob })).length === 1 &&
     (await call('chat:list', { workspaceId: own })).length === 0)

  await exec(
    `INSERT INTO chat_message (conversation_id, role, blocks, tools, sort_order)
     VALUES ($1, 'user', $2::jsonb, '{}'::jsonb, 0)`,
    [conversationId, JSON.stringify([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])])
  const loaded = await call('chat:get', { id: conversationId })
  ok('a conversation replays its turns as the API sent them',
     loaded.messages.length === 1 && loaded.messages[0].blocks[0].content[0].text === 'hi')

  /*
   * The SDK's stream helper returns a parsed response, hanging `parsed_arguments` on
   * every function call and `parsed` on every text part. Those are the client's, not
   * the wire's, and echoing one back is a 400 on the *second* request of a turn — so
   * a conversation with no tool call in it looks entirely healthy and the bug only
   * shows the first time the assistant looks something up.
   */
  const parsed = [
    { type: 'function_call', call_id: 'c1', name: 'today', arguments: '{}', parsed_arguments: { a: 1 } },
    { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', parsed: { b: 2 } }] }
  ]
  const cleaned = apiOnly(parsed)
  ok('the SDK\'s own fields are stripped before a turn goes back to the API',
     !('parsed_arguments' in cleaned[0]) && !('parsed' in cleaned[1].content[0]),
     JSON.stringify(cleaned))
  ok('and everything the API does want survives that',
     cleaned[0].call_id === 'c1' && cleaned[0].arguments === '{}' &&
     cleaned[1].content[0].text === 'hello')
  ok('stripping does not mutate what it was given',
     'parsed_arguments' in parsed[0] && 'parsed' in (parsed[1] as any).content[0])

  ok('a conversation can be renamed',
     (await call('chat:rename', { id: conversationId, title: 'Renamed' })).title === 'Renamed')

  // Tool catalogue. A write with no confirmation line is the one bug in this feature
  // that would matter, so it is asserted rather than trusted.
  ok('every tool has a name, a description and a schema',
     TOOLS.every((t) => t.name && t.description && t.parameters.type === 'object'))
  ok('no two tools share a name', new Set(TOOLS.map((t) => t.name)).size === TOOLS.length)
  ok('every tool that writes can say what it is about to do',
     TOOLS.filter((t) => t.writes).every((t) => typeof t.summary === 'function'),
     TOOLS.filter((t) => t.writes && !t.summary).map((t) => t.name).join(', '))
  ok('reads never ask for confirmation',
     TOOLS.filter((t) => !t.writes).every((t) => t.summary === undefined))

  const tool = (name: string): any => TOOLS.find((t) => t.name === name)
  const dayJobCtx = { workspaceId: dayJob }

  const listed = await tool('list_projects').run({}, dayJobCtx)
  ok('a tool sees only its own workspace', listed.length === 3 &&
     !listed.some((p: any) => p.id === otherProject.id))

  ok('a project in another workspace is simply not found',
     await threw(() => tool('get_project').run({ project: otherProject.name }, dayJobCtx),
                 'No project in this workspace'))

  const seenProject = await tool('get_project').run({ project: 'Checkout rewrite' }, dayJobCtx)
  ok('get_project carries the board, the people and the write-ups',
     seenProject.board.length > 0 && seenProject.people.length > 0 && Array.isArray(seenProject.meetings))

  // Reading a project must not count as visiting it — the re-entry brief measures
  // the gap since *you* last opened it, and the assistant is not you.
  const clockBefore = await q<{ last_opened_at: string | null }>(
    'SELECT last_opened_at FROM project WHERE id = $1', [seenProject.id])
  await tool('get_project').run({ project: 'Checkout rewrite' }, dayJobCtx)
  const clockAfter = await q<{ last_opened_at: string | null }>(
    'SELECT last_opened_at FROM project WHERE id = $1', [seenProject.id])
  ok('the assistant reading a project does not roll the re-entry clock',
     String(clockBefore[0].last_opened_at) === String(clockAfter[0].last_opened_at))

  ok('an ambiguous name is reported rather than guessed at',
     await threw(() => tool('get_project').run({ project: 'e' }, dayJobCtx), 'Ask which one'))

  const summary = await tool('create_task').summary(
    { project: 'Checkout rewrite', title: 'Draft the brief', dueDate: '2026-10-01' }, dayJobCtx)
  ok('a confirmation names the project rather than quoting an id',
     summary.includes('Draft the brief') && summary.includes('Checkout rewrite') &&
     summary.includes('2026-10-01') && !summary.includes(seenProject.id), summary)

  ok('a bad date is refused before anything is written',
     await threw(() => tool('create_task').summary(
       { project: 'Checkout rewrite', title: 'x', dueDate: 'next Friday' }, dayJobCtx), 'YYYY-MM-DD'))

  // The whole point of routing writes through the app's own channels: a task the
  // assistant makes has to be indistinguishable from one made by a click.
  const activityBefore = (await call('dashboard:activity', { workspaceId: dayJob })).length
  const made = await tool('create_task').run(
    { project: 'Checkout rewrite', title: 'Written by the assistant', dueDate: '2026-10-01' }, dayJobCtx)
  const madeTask = (await call('task:list', { projectId: seenProject.id })).find((t: any) => t.id === made.id)
  ok('a task the assistant writes lands on the board like any other',
     Boolean(madeTask) && madeTask.columnId !== null && madeTask.dueDate === '2026-10-01')
  ok('and logs activity, because it went through the same channel',
     (await call('dashboard:activity', { workspaceId: dayJob })).length === activityBefore + 1)

  /*
   * A tool's write has nobody in the renderer waiting on it, so the screen is told
   * separately or it shows yesterday's board until you navigate away and back. The
   * signal comes from the database having actually changed, which is what a read has
   * to be checked against: announcing on every tool call would refetch the whole app
   * every time the assistant looked something up.
   */
  let announced = 0
  const stopWatching = onChange(() => { announced += 1 })
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
  // The task made just above is still in the coalescing window; let it land first.
  await settle()
  announced = 0

  await tool('list_projects').run({}, dayJobCtx)
  await tool('get_project').run({ project: 'Checkout rewrite' }, dayJobCtx)
  await settle()
  ok('the assistant reading things does not make the screen refetch', announced === 0)

  await tool('create_task').run(
    { project: 'Checkout rewrite', title: 'Watched for', dueDate: '2026-10-02' }, dayJobCtx)
  await settle()
  ok('a task made by a tool tells the screen to catch up', announced === 1)

  // Several writes close together are one refetch, not one each — a tool that saves a
  // project, moves a card and logs activity must not make the app reload three times.
  announced = 0
  announceChange()
  announceChange()
  announceChange()
  await settle()
  ok('a burst of writes is folded into one refetch', announced === 1, String(announced))

  announced = 0
  await threw(() => tool('create_task').run({ project: 'Nowhere at all', title: 'x' }, dayJobCtx),
              'No project in this workspace')
  await settle()
  ok('a tool that refused before writing anything says nothing either', announced === 0)
  stopWatching()

  await tool('set_task_status').run({ id: made.id, status: 'done' }, dayJobCtx)
  const tickedCard = (await call('task:list', { projectId: seenProject.id })).find((t: any) => t.id === made.id)
  ok('ticking a card off through a tool also moves it to the done column',
     tickedCard.status === 'done' && tickedCard.columnId !== madeTask.columnId)

  const foreignTask = (await invokeChannel('task:list', { projectId: otherProject.id }))[0]
  const refused = await threw(
    () => tool('set_task_status').run({ id: foreignTask.id, status: 'done' }, dayJobCtx),
    'in this workspace')
  const stillOpen = (await invokeChannel('task:list', { projectId: otherProject.id }))
    .find((t: any) => t.id === foreignTask.id)
  ok('a task in another workspace cannot be touched by id, even a real one',
     refused && stillOpen?.status === foreignTask.status)

  await call('chat:delete', { id: conversationId })
  ok('deleting a conversation takes its turns with it',
     (await call('chat:list', { workspaceId: dayJob })).length === 0 &&
     (await q('SELECT id FROM chat_message WHERE conversation_id = $1', [conversationId])).length === 0)

  /* --------------------------------------------------- folders, from the assistant */

  const toolFolders = await tool('list_folders').run({}, dayJobCtx)
  ok('the assistant sees the folder tree as paths, not ids',
     toolFolders.some((f: any) => f.path === 'Clients / Acme'),
     toolFolders.map((f: any) => f.path).join(', '))
  ok('and a project says which folder it is filed in',
     (await tool('list_projects').run({}, dayJobCtx)).find((p: any) => p.id === idle.id).folder === 'Clients / Acme')

  ok('a folder is named the way a person names one',
     (await tool('file_project').summary({ project: 'Internal tooling', folder: 'clients/acme' }, dayJobCtx))
       .includes('Clients / Acme'))
  ok('taking one out says so plainly',
     (await tool('file_project').summary({ project: 'Internal tooling', folder: null }, dayJobCtx))
       .includes('out of its folder'))
  ok('a folder that is not there fails before the question is asked',
     await threw(() => tool('file_project').summary({ project: 'Internal tooling', folder: 'Nowhere' }, dayJobCtx),
                 'No folder in this workspace'))
  ok('deleting a folder says what survives it',
     (await tool('delete_folder').summary({ folder: 'Clients' }, dayJobCtx))
       .includes('move up a level'))
  ok('and a move that cannot be made is refused while it is still a question',
     await threw(() => tool('update_folder').summary({ folder: 'Clients', parent: 'Clients' }, dayJobCtx),
                 'inside itself'))

  await tool('create_folder').run({ name: 'Archive box' }, dayJobCtx)
  await tool('file_project').run({ project: 'Internal tooling', folder: 'Archive box' }, dayJobCtx)
  ok('the assistant files a project through the same channel a drag does',
     (await call('project:list', { workspaceId: dayJob })).find((p: any) => p.id === idle.id).folderId ===
       (await call('folder:list', { workspaceId: dayJob })).find((f: any) => f.name === 'Archive box').id)
  await tool('file_project').run({ project: 'Internal tooling', folder: 'Clients / Acme' }, dayJobCtx)
  await tool('delete_folder').run({ folder: 'Archive box' }, dayJobCtx)
  ok('and puts it back, and clears up after itself',
     (await call('project:list', { workspaceId: dayJob })).find((p: any) => p.id === idle.id).folderId === acme.id &&
     !(await call('folder:list', { workspaceId: dayJob })).some((f: any) => f.name === 'Archive box'))
  ok('a folder in another workspace is invisible to a tool',
     await threw(() => tool('update_folder').summary({ folder: 'Somewhere else' }, dayJobCtx),
                 'No folder in this workspace'))

  const md = await call('settings:exportMarkdown')
  ok('markdown mirror writes files', md.files >= 20, `${md.files} files`)
  const filedOverview = join((await call('settings:get')).markdownDir,
                             'Day job', 'Clients', 'Acme', 'Internal tooling', '_overview.md')
  ok('a filed project is mirrored inside its folders on disk', existsSync(filedOverview), filedOverview)
  const json = await call('settings:exportJson')
  ok('json export writes', typeof json.path === 'string', json.path)

  /* ------------------------------------------------------- a project's start date */

  const born = await call('project:save', { id: seenProject.id, createdAt: '2026-03-09' })
  ok('a project can be told when it actually began',
     born.createdAt.slice(0, 10) === '2026-03-09', born.createdAt)
  ok('and it is stored at noon, so the date reads the same everywhere on earth',
     born.createdAt.includes('T12:00:00'), born.createdAt)
  ok('a start date that is not a date is refused',
     await threw(() => call('project:save', { id: seenProject.id, createdAt: 'last spring' }),
                 'YYYY-MM-DD'))
  ok('changing the start date leaves the rest of the project alone',
     born.name === seenProject.name && born.deadline === seenProject.deadline)

  /* ------------------------------------------------- the bridge Claude Desktop uses */

  const described = describeTools()
  ok('every tool the bridge offers names its workspace explicitly',
     described.length === TOOLS.length &&
     described.every((t) => Boolean((t.parameters as any).properties?.workspace)))
  ok('reads are offered as read-only and deleting is offered as destructive',
     described.find((t) => t.name === 'list_projects')!.writes === false &&
     described.find((t) => t.name === 'create_task')!.writes === true &&
     described.find((t) => t.name === 'delete_task')!.destroys === true &&
     described.find((t) => t.name === 'delete_folder')!.destroys === true &&
     described.filter((t) => t.destroys).length === 2)

  const activeId = (await call('settings:get')).activeWorkspaceId
  const activeName = (await call('workspace:list')).find((w: any) => w.id === activeId)?.name
  const noWorkspace = await callTool({ tool: 'list_projects', arguments: {} })
  ok('a call that names no workspace uses the one the app is showing, and says which',
     noWorkspace.ok && noWorkspace.workspace === activeName, activeName)

  const named = await callTool({ tool: 'list_projects', arguments: { workspace: 'My company' } })
  ok('a call can name its workspace, and gets that one',
     named.ok && named.workspace === 'My company' &&
     (named.result as any[]).some((p) => p.id === otherProject.id))

  const wrongWorkspace = await callTool({
    tool: 'set_task_status',
    arguments: { workspace: 'Day job', id: (await invokeChannel('task:list', { projectId: otherProject.id }))[0].id, status: 'done' }
  })
  ok('the workspace fence holds through the bridge as it does in the panel',
     !wrongWorkspace.ok && wrongWorkspace.error.includes('in this workspace'))

  const madeOverBridge = await callTool({
    tool: 'create_task',
    arguments: { workspace: 'Day job', project: 'Checkout rewrite', title: 'Written through the bridge', dueDate: '2026-10-02' }
  })
  ok('a write over the bridge reports what it did in plain words',
     madeOverBridge.ok && (madeOverBridge.summary ?? '').includes('Checkout rewrite') &&
     (madeOverBridge.summary ?? '').includes('Written through the bridge'))

  // The confirmation line is built before the write, so bad input fails before it lands.
  const tasksBefore = (await call('task:list', { projectId: seenProject.id })).length
  const badDate = await callTool({
    tool: 'create_task',
    arguments: { workspace: 'Day job', project: 'Checkout rewrite', title: 'x', dueDate: 'next Friday' }
  })
  ok('a bad date over the bridge is refused before anything is written',
     !badDate.ok && badDate.error.includes('YYYY-MM-DD') &&
     (await call('task:list', { projectId: seenProject.id })).length === tasksBefore)

  const unknownWorkspace = await callTool({ tool: 'list_projects', arguments: { workspace: 'Nowhere' } })
  ok('a workspace that does not exist is named as such, with the ones that do',
     !unknownWorkspace.ok && unknownWorkspace.error.includes('Day job'))

  ok('an unknown tool is refused by name',
     !(await callTool({ tool: 'drop_everything', arguments: {} })).ok)

  /* The socket itself: what the connector actually talks to. */

  const socket = await startBridge()
  const info = JSON.parse(readFileSync(endpointFile(), 'utf8')) as BridgeEndpoint
  ok('starting the bridge leaves an endpoint for the connector to find',
     Boolean(socket) && info.endpoint === socket && info.token.length > 0 && info.pid === process.pid)

  const knock = async (token: string, path = '/tools'): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath: info.endpoint, path, method: 'GET', headers: { 'x-neo-token': token } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
          })
        }
      )
      req.on('error', reject)
      req.end()
    })

  const served = await knock(info.token)
  ok('the bridge serves the tool list over its socket',
     served.status === 200 && served.body.tools.length === TOOLS.length)

  const greeted = await knock(info.token, '/')
  ok('the bridge names the workspaces so a client can choose one',
     greeted.status === 200 && greeted.body.app === 'neo' &&
     greeted.body.workspaces.some((w: any) => w.name === 'Day job'))

  ok('a caller without the token gets nothing',
     (await knock('not-the-token')).status === 401)

  const mcp = await call('mcp:status')
  ok('the connector reports where Claude Desktop keeps its configuration',
     mcp.configPath.endsWith('claude_desktop_config.json'))
  ok('and offers an entry that runs on a runtime we know exists',
     mcp.entry.command === process.execPath && mcp.entry.env.ELECTRON_RUN_AS_NODE === '1')

  /*
   * Connecting writes into a file Claude Desktop owns, so the real one is never the
   * thing under test: HOME is moved somewhere disposable for the length of it.
   */
  const realHome = process.env.HOME
  const fakeHome = mkdtempSync(join(tmpdir(), 'neo-claude-'))
  process.env.HOME = fakeHome
  const claudeDir = join(fakeHome, 'Library', 'Application Support', 'Claude')
  mkdirSync(claudeDir, { recursive: true })
  const claudeConfig = join(claudeDir, 'claude_desktop_config.json')

  ok('with nothing in that file yet, Neo reports itself as not connected',
     (await call('mcp:status')).connected === false)

  // Somebody else's file, with their own server and their own settings in it.
  writeFileSync(claudeConfig, JSON.stringify({
    globalShortcut: 'Alt+Space',
    mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] } }
  }, null, 2))

  const connected = await call('mcp:connect')
  const written = JSON.parse(readFileSync(claudeConfig, 'utf8'))
  ok('connecting adds Neo to Claude Desktop and says so',
     connected.connected === true && Boolean(written.mcpServers.neo))
  ok('and leaves everything else in that file exactly as it was',
     written.globalShortcut === 'Alt+Space' && written.mcpServers.filesystem.command === 'npx')
  ok('the entry runs the connector on this copy of the app',
     written.mcpServers.neo.env.ELECTRON_RUN_AS_NODE === '1' &&
     written.mcpServers.neo.args[0].endsWith('neo-mcp.mjs'))

  // A copy of Neo that moved leaves an entry pointing at where it used to be.
  writeFileSync(claudeConfig, JSON.stringify({
    mcpServers: { ...written.mcpServers, neo: { ...written.mcpServers.neo, args: ['/gone/neo-mcp.mjs'] } }
  }, null, 2))
  const relocated = await call('mcp:status')
  ok('an entry pointing at another copy of Neo is reported as stale, not as connected',
     relocated.stale === true && relocated.connected === false)

  await call('mcp:connect')
  const disconnected = await call('mcp:disconnect')
  const remaining = JSON.parse(readFileSync(claudeConfig, 'utf8'))
  ok('disconnecting takes Neo out again and leaves the other server behind',
     disconnected.connected === false && remaining.mcpServers.neo === undefined &&
     Boolean(remaining.mcpServers.filesystem))

  writeFileSync(claudeConfig, '{ this is not json')
  ok('a configuration file we cannot parse is reported, never overwritten',
     await threw(() => call('mcp:connect'), 'not valid JSON') &&
     readFileSync(claudeConfig, 'utf8') === '{ this is not json')

  process.env.HOME = realHome

  await stopBridge()
  ok('closing the bridge takes the endpoint away, so the connector knows the app is shut',
     !existsSync(endpointFile()) && !existsSync(info.endpoint))

  // Destructive, so it runs last.
  await call('workspace:delete', { id: consultancy })
  ok('a deleted active workspace falls back to a real one',
     [dayJob, own].includes((await call('settings:get')).activeWorkspaceId))

  await closeDb()
}

main().catch((e) => {
  console.error('THREW', e)
  process.exitCode = 1
})
