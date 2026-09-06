import { ipcMain, __handlers, __notifications, __fetches } from 'electron'
import { initDb, closeDb, clearStrandedTriggers, orphanedForeignKeys } from '../src/main/db/client'
import { registerWorkspaceHandlers } from '../src/main/ipc/workspaces'
import { registerProjectHandlers } from '../src/main/ipc/projects'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerMeetingHandlers } from '../src/main/ipc/meetings'
import { registerNotificationHandlers } from '../src/main/ipc/notifications'
import { registerRecordingHandlers } from '../src/main/ipc/recordings'
import { registerPeopleHandlers } from '../src/main/ipc/people'
import { registerContentHandlers } from '../src/main/ipc/content'
import { registerDashboardHandlers } from '../src/main/ipc/dashboard'
import { registerSearchHandlers } from '../src/main/ipc/search'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { registerWeatherHandlers } from '../src/main/ipc/weather'
import { registerUpdateHandlers } from '../src/main/ipc/updates'
import { registerChatHandlers } from '../src/main/ipc/chat'
import { registerMcpHandlers } from '../src/main/ipc/mcp'
import { TOOLS } from '../src/main/lib/ai/tools'
import { PANELS, clampPanelWidth } from '../src/shared/panels'
import { callTool, describeTools, endpointFile, startBridge, stopBridge } from '../src/main/lib/mcp/bridge'
import { apiOnly } from '../src/main/lib/ai/run'
import { invokeChannel } from '../src/main/ipc/util'
import { announceChange, onChange } from '../src/main/lib/changes'
import { attentionReason } from '../src/main/lib/attention'
import { deliveryDue } from '../src/main/lib/notify'
import { deliverNotifications } from '../src/main/lib/notifier'
import { splashDocument } from '../src/main/lib/splash'
import { describeWeather } from '../src/shared/weather'
import {
  appImageSwapScript, changelogVersion, compareVersions, isNewer,
  macSwapScript, parseChangelog, parseRelease, pickAsset
} from '../src/main/lib/update'
import { changelogMedia, listChangelog, readChangelog } from '../src/main/lib/changelog'
import { checkForUpdate, setUpdatePreference, updateStatus } from '../src/main/lib/updater'
import { resolveTemperature } from '../src/shared/formats'
import { kick, reapDeadCaptures, recoverRecordings } from '../src/main/lib/recording/pipeline'
import { recapMarkdown } from '../src/main/lib/recording/summarise'
import { pruneRecordings, recordingDir } from '../src/main/lib/recording/store'
import { helperPath } from '../src/main/lib/recording/systemAudio'
import { addDays, exec, iconDir, q, today as todayDate } from '../src/main/db/client'
import { request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MARK } from '@shared/mark'
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

/** Today, at a given time, for asserting what happens at ten past nine. */
const at = (hours: number, minutes: number): Date => {
  const when = new Date()
  when.setHours(hours, minutes, 0, 0)
  return when
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
  registerNotificationHandlers()
  registerSearchHandlers()
  registerSettingsHandlers()
  registerWeatherHandlers()
  registerUpdateHandlers()
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

  /* -------------------------------------------------------------- collapsibles */

  /*
   * The other half of grouping: a named band on the page you are already on, which
   * folds shut rather than taking you somewhere. It is furniture, like the order of the
   * cards — nothing derives from it and nothing reaches the mirror — but one thing has
   * to hold or the two ways of grouping start disagreeing about where a card is: a band
   * is drawn at one level and holds only projects filed at that level.
   */
  ok('a workspace starts with no collapsibles',
     (await call('collapsible:list', { workspaceId: dayJob })).length === 0)

  const later = await call('collapsible:save', { workspaceId: dayJob, name: 'Later' })
  ok('a collapsible needs a name',
     await threw(() => call('collapsible:save', { workspaceId: dayJob, name: '  ' }), 'needs a name'))
  ok('collapsibles are fenced to their workspace like everything else',
     (await call('collapsible:list', { workspaceId: own })).length === 0)

  const grouped = await call('project:save', { workspaceId: dayJob, name: 'In a band', status: 'active' })
  const groupedNow = async (): Promise<any> =>
    (await call('project:list', { workspaceId: dayJob })).find((p: any) => p.id === grouped.id)
  await call('project:save', { id: grouped.id, collapsibleId: later.id })
  ok('a project can be put in a collapsible', (await groupedNow()).collapsibleId === later.id)
  ok('and the band counts what is in it',
     (await call('collapsible:list', { workspaceId: dayJob }))
       .find((c: any) => c.id === later.id).projectCount === 1)
  ok('folding one shut is remembered',
     (await call('collapsible:save', { id: later.id, isCollapsed: true })).isCollapsed)

  // The invariant the whole feature rests on, from both ends.
  const deepBand = await call('collapsible:save', { workspaceId: dayJob, name: 'Deep', folderId: acme.id })
  ok('a collapsible only holds projects filed at the level it is drawn at',
     await threw(() => call('project:save', { id: grouped.id, collapsibleId: deepBand.id }),
                 'level it is drawn at'))
  ok('and it never moves to another page, which would strand the cards in it',
     await threw(() => call('collapsible:save', { id: later.id, folderId: acme.id }),
                 'stays on the page'))
  const foreignBand = await call('collapsible:save', { workspaceId: own, name: 'Somewhere else' })
  ok('a project cannot be grouped in another workspace\u2019s collapsible',
     await threw(() => call('project:save', { id: grouped.id, collapsibleId: foreignBand.id }),
                 'another workspace'))
  await call('collapsible:delete', { id: foreignBand.id })

  // Filing is the stronger statement of the two: a card that has left the page has
  // left the band drawn on it, without anyone having to say so.
  await call('project:save', { id: grouped.id, folderId: acme.id })
  ok('filing a card into a folder takes it out of the band it was in',
     (await groupedNow()).collapsibleId === null)
  await call('project:save', { id: grouped.id, folderId: null, collapsibleId: later.id })
  ok('and it can be put back', (await groupedNow()).collapsibleId === later.id)

  await call('collapsible:delete', { id: later.id })
  ok('deleting a collapsible leaves its projects behind, ungrouped',
     (await groupedNow()) !== undefined && (await groupedNow()).collapsibleId === null)

  /*
   * A folder taking its bands with it as it goes up a level. The two have to travel
   * together: lifting the cards and leaving the bands would leave a project grouped on
   * a page it is no longer drawn on.
   */
  const shed = await call('folder:save', { workspaceId: dayJob, name: 'Shed' })
  const shedBand = await call('collapsible:save', { workspaceId: dayJob, name: 'Odds', folderId: shed.id })
  await call('project:save', { id: grouped.id, folderId: shed.id })
  await call('project:save', { id: grouped.id, collapsibleId: shedBand.id })
  await call('folder:delete', { id: shed.id })
  const lifted2 = (await call('collapsible:list', { workspaceId: dayJob }))
    .find((c: any) => c.id === shedBand.id)
  ok('deleting a folder lifts the bands on its page along with the cards in them',
     lifted2?.folderId === null && (await groupedNow()).collapsibleId === shedBand.id,
     JSON.stringify(lifted2))

  await call('project:delete', { id: grouped.id })
  await call('collapsible:delete', { id: shedBand.id })
  await call('collapsible:delete', { id: deepBand.id })
  ok('and the workspace is back to no collapsibles at all',
     (await call('collapsible:list', { workspaceId: dayJob })).length === 0)

  /*
   * Arranging the cards by hand. Zero means nobody has said, so a workspace nobody
   * has dragged anything in is ordered exactly as it always was; the first drop is
   * what turns that into an order of its own, and it has to survive everything the
   * page does around it.
   */
  const arrangeA = await call('project:save', { workspaceId: own, name: 'Arrange A', status: 'active' })
  const arrangeB = await call('project:save', { workspaceId: own, name: 'Arrange B', status: 'active' })
  const arrangeC = await call('project:save', { workspaceId: own, name: 'Arrange C', status: 'active' })
  const arranged = async (): Promise<string[]> =>
    (await call('project:list', { workspaceId: own }))
      .filter((p: any) => p.name.startsWith('Arrange '))
      .map((p: any) => p.name)
  ok('projects start unplaced, newest activity first',
     (await arranged()).join(' ') === 'Arrange C Arrange B Arrange A', (await arranged()).join(' '))

  await call('project:reorder', { ids: [arrangeA.id, arrangeC.id, arrangeB.id] })
  ok('and can be put in an order by hand',
     (await arranged()).join(' ') === 'Arrange A Arrange C Arrange B', (await arranged()).join(' '))

  // The point of the whole thing: a card stays where it was put even after the project
  // it belongs to moves, which is what the old ordering could not do.
  await call('task:save', { projectId: arrangeB.id, title: 'Something happening on B' })
  ok('a hand-placed order is not undone by activity',
     (await arranged()).join(' ') === 'Arrange A Arrange C Arrange B', (await arranged()).join(' '))

  // Pinning still lifts a card, but only among the ones nobody has placed: a pin that
  // could override a drop would mean cards that snap back the moment you let go.
  await call('project:save', { id: arrangeB.id, isPinned: true })
  ok('pinning does not override where a card was dropped',
     (await arranged()).join(' ') === 'Arrange A Arrange C Arrange B', (await arranged()).join(' '))
  await call('project:save', { id: arrangeB.id, isPinned: false })

  // Zero is left free by every hand-set order, which is what lets a project made
  // afterwards arrive at the top of an arrangement rather than the bottom of it.
  const arrangeD = await call('project:save', { workspaceId: own, name: 'Arrange D', status: 'active' })
  ok('a project made after an arrangement lands at the top of it',
     (await arranged()).join(' ') === 'Arrange D Arrange A Arrange C Arrange B',
     (await arranged()).join(' '))
  await call('project:delete', { id: arrangeD.id })

  // Filing a card somewhere else drops the place it had among its old neighbours: it
  // means nothing beside the new ones, and the top is where you look for it next.
  const shelf = await call('folder:save', { workspaceId: own, name: 'A shelf' })
  await call('project:save', { id: arrangeB.id, folderId: shelf.id })
  await call('project:save', { id: arrangeB.id, folderId: null })
  ok('a card filed elsewhere and back comes back unplaced, at the top',
     (await arranged()).join(' ') === 'Arrange B Arrange A Arrange C', (await arranged()).join(' '))

  for (const p of [arrangeA, arrangeB, arrangeC]) await call('project:delete', { id: p.id })
  await call('folder:delete', { id: shelf.id })

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

  /*
   * How a date, a clock and a temperature read is about the person at the machine
   * rather than about a working life, so it sits here beside the theme and not on a
   * workspace. Every one defaults to what the operating system says.
   */
  const formats = await call('settings:save', {
    clockFormat: '24', dateFormat: 'ymd', temperatureUnits: 'f'
  })
  ok('how a date, a clock and a temperature read is remembered on this machine',
     formats.clockFormat === '24' && formats.dateFormat === 'ymd' &&
     formats.temperatureUnits === 'f')
  ok('and a value that is not one of the choices falls back to the system\'s own',
     (await call('settings:save', { dateFormat: 'martian' })).dateFormat === 'system')
  ok('"system" degrees resolve to one a forecast can actually be asked for',
     ['c', 'f'].includes(resolveTemperature('system')) &&
     resolveTemperature('f') === 'f' && resolveTemperature('c') === 'c')

  // Put back, so the assertions below read dates the way the rest of the run does.
  await call('settings:save', { clockFormat: 'system', temperatureUnits: 'system' })

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

  /* ------------------------------------------- the Today page's own furniture */

  /*
   * All of this is decoration, and that is the point: nothing here is read by
   * attention, by the mirror or by anything that decides what to do next, which is
   * why it is the one part of the app the user gets to arrange. What it must still
   * do is behave like everything else — clean up after itself, stay inside its
   * workspace, and never make a network request nobody asked for.
   */
  mkdirSync(iconDir(), { recursive: true })
  const firstBanner = '11111111-1111-4111-8111-111111111111.png'
  const secondBanner = '22222222-2222-4222-8222-222222222222.png'
  for (const file of [firstBanner, secondBanner]) writeFileSync(join(iconDir(), file), 'x')

  const bannered = await call('workspace:save', { id: dayJob, bannerPath: firstBanner })
  ok('a banner comes back as a URL the renderer can draw and not as a path it could read',
     bannered.banner === `neo-media://banner/${firstBanner}` && !bannered.banner.includes(iconDir()),
     bannered.banner)

  await call('workspace:save', { id: dayJob, bannerPath: secondBanner })
  ok('replacing a banner takes the old file with it',
     !existsSync(join(iconDir(), firstBanner)) && existsSync(join(iconDir(), secondBanner)))

  const bare = await call('workspace:save', { id: dayJob, bannerPath: '' })
  ok('and removing one leaves nothing behind to draw',
     bare.banner === null && !existsSync(join(iconDir(), secondBanner)))

  const panned = await call('workspace:save', { id: dayJob, bannerX: 20, bannerY: 140 })
  ok('a banner remembers which part of it is seen, and cannot be moved off its own edge',
     panned.bannerX === 20 && panned.bannerY === 100)

  const bio = await call('workspace:save', { id: dayJob, bio: 'Three squads, one roadmap.' })
  ok('a workspace can say what you do in it', bio.bio === 'Three squads, one roadmap.')

  // A link belongs to the working life rather than to a piece of work, so it is
  // fenced to its workspace exactly as everything else scoped is.
  const typed = await call('workspaceLink:save', { workspaceId: dayJob, url: 'intranet.company.com' })
  ok('a link typed without a scheme is given one, and labels itself from the address',
     typed.url === 'https://intranet.company.com' && typed.label === 'intranet.company.com')

  const timesheet = await call('workspaceLink:save', {
    workspaceId: dayJob, label: 'Timesheet', url: 'https://time.example.com'
  })
  ok('a link with no address is refused rather than saved blank',
     await threw(() => call('workspaceLink:save', { workspaceId: dayJob, label: 'Nothing' }),
                 'needs an address'))

  await call('workspaceLink:reorder', { ids: [timesheet.id, typed.id] })
  const ordered = await call('workspaceLink:list', { workspaceId: dayJob })
  ok('links are drawn in the order they were put in',
     ordered.map((l: any) => l.id).join() === [timesheet.id, typed.id].join())
  ok('and one workspace never sees another one\'s links',
     (await call('workspaceLink:list', { workspaceId: own })).length === 0)

  await call('workspaceLink:delete', { id: typed.id })
  ok('a link can be taken off again',
     (await call('workspaceLink:list', { workspaceId: dayJob })).length === 1)

  const hidden = await call('workspace:save', {
    id: dayJob, todayShowWeather: false, todayShowSoon: false
  })
  ok('what Today shows is remembered per workspace',
     hidden.todayShowWeather === false && hidden.todayShowSoon === false &&
     hidden.todayShowAttention === true)

  /*
   * The weather is the only thing in this application that talks to the internet
   * without a key of yours, so switching it off has to mean *no request* rather
   * than a request whose answer is dropped. This assertion is what keeps that true:
   * it returns null, and it returns it without a socket, which is also why the whole
   * verify run stays offline.
   */
  ok('weather switched off asks nobody anything',
     (await call('weather:get', { workspaceId: dayJob })) === null)

  ok('a weather code becomes the same words and the same picture on both sides',
     describeWeather(0, true).icon === 'weatherSun' &&
     describeWeather(0, false).icon === 'weatherMoon' &&
     describeWeather(61).text === 'Light rain' &&
     describeWeather(-1).text === '')

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

  /*
   * Liquid Glass is a theme like any other as far as the database is concerned, and
   * one number beside it. The number is clamped on the way out rather than on the way
   * in, so a value written before the slider existed — or by hand — still draws.
   */
  ok('the glass amount defaults before it is ever set',
     settings.glassTransparency === 45, String(settings.glassTransparency))
  const glass = await call('settings:save', { theme: 'glass', glassTransparency: 80 })
  ok('the glass theme and its amount round-trip',
     glass.theme === 'glass' && glass.glassTransparency === 80)
  await call('settings:save', { glassTransparency: 999 as unknown as number })
  ok('an out-of-range glass amount is clamped rather than drawn',
     (await call('settings:get')).glassTransparency === 100)
  await call('settings:save', { theme: 'dark', glassTransparency: 45 })

  /*
   * Main's half of it. There is no vibrancy view in a headless test — and none on
   * Linux at all — so what is asserted is the contract rather than the appearance:
   * it answers with what this machine actually gave, never with what was asked for.
   */
  const material = (await call('window:glass', { on: true })).material
  ok('asking for glass says what was actually got',
     material === (process.platform === 'darwin' || process.platform === 'win32' ? 'window' : 'paint'),
     material)
  ok('turning glass off is never a window material',
     (await call('window:glass', { on: false })).material === 'paint')

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


  /* -------------------------------------------------------------- notifications */

  /*
   * Everything here is derived from a deadline or a due date, so this exercises it
   * the only honest way: put dates on real work and ask what the app would say.
   *
   * The workspace is its own, because the assertions are about the exact sentence
   * and the sample data has deadlines of its own scattered through it.
   */
  const quiet = await call('workspace:save', { name: 'Notified' })
  const now = todayDate()

  const rollout = await call('project:save', {
    workspaceId: quiet.id, name: 'Rollout', deadline: addDays(now, 7)
  })
  await call('project:save', {
    workspaceId: quiet.id, name: 'Next year', deadline: addDays(now, 30)
  })
  await call('task:save', { projectId: rollout.id, title: 'Book the room', dueDate: addDays(now, 1) })
  await call('task:save', { projectId: rollout.id, title: 'Send the deck', dueDate: now })
  await call('task:save', { projectId: rollout.id, title: 'Chase legal', dueDate: addDays(now, -1) })
  await call('task:save', { projectId: rollout.id, title: 'Chase finance', dueDate: addDays(now, -1) })

  const said = await call('notification:pending', { workspaceId: quiet.id })
  const of = (kind: string): any => said.find((n: any) => n.kind === kind)

  ok('a deadline exactly a week out is worth saying, and one a month out is not',
     of('project-ahead')?.title === "Rollout's deadline is in 7 days" &&
     said.filter((n: any) => n.kind === 'project-ahead').length === 1,
     said.map((n: any) => n.title).join(' | '))

  ok('one card due tomorrow is named',
     of('task-ahead')?.title === 'Book the room is due tomorrow', of('task-ahead')?.title)

  ok('and one due today says so, with the project it is in underneath',
     of('task-day')?.title === 'Send the deck is due today' &&
     of('task-day')?.body === 'Rollout · Notified', of('task-day')?.body)

  // Two of anything is one notification, never two. An app that puts four cards in
  // the notification centre is an app whose notifications get switched off.
  ok('several late items arrive as one sentence, not one each',
     of('task-after')?.title === '2 items were due yesterday' && of('task-after')?.count === 2,
     of('task-after')?.title)

  ok('a group inside one project opens that project, not the whole of Today',
     of('task-after')?.path === `/projects/${rollout.id}`, of('task-after')?.path)

  ok('nothing is said about a deadline that is neither today nor exactly the warning out',
     said.every((n: any) => !/Next year/.test(n.title)))

  // Paused is the one hand-set state, and this is the same thing it already does to
  // Today: a project you have put down stops asking, on screen and on the desktop.
  await call('project:save', { id: rollout.id, status: 'paused' })
  ok('a paused project says nothing at all',
     (await call('notification:pending', { workspaceId: quiet.id })).length === 0)
  await call('project:save', { id: rollout.id, status: 'active' })

  const fewer = await call('workspace:save', {
    id: quiet.id, notifyTaskDayAfter: false, notifyProjectAheadDays: 0
  })
  ok('a switch turned off silences its own kind and leaves the rest',
     fewer.notifyProjectAheadDays === 0 &&
     (await call('notification:pending', { workspaceId: quiet.id }))
       .every((n: any) => n.kind !== 'task-after' && n.kind !== 'project-ahead'))

  ok('how many days ahead cannot be set to something that would never fire',
     (await call('workspace:save', { id: quiet.id, notifyProjectAheadDays: 900 }))
       .notifyProjectAheadDays === 90)

  await call('workspace:save', {
    id: quiet.id, notifyTaskDayAfter: true, notifyProjectAheadDays: 7
  })

  ok('a workspace with notifications off is silent however much is overdue in it',
     (await call('workspace:save', { id: quiet.id, notify: false })).notify === false &&
     (await call('notification:pending', { workspaceId: quiet.id })).length === 0)
  await call('workspace:save', { id: quiet.id, notify: true })

  ok('and one workspace is never told about another one\'s work',
     (await call('notification:pending', { workspaceId: own }))
       .every((n: any) => !/Rollout|Book the room/.test(`${n.title} ${n.body}`)))

  /* the delivery itself */

  ok('nothing is delivered before the hour you asked for it',
     !deliveryDue(at(8, 59), '09:00', true) && deliveryDue(at(9, 0), '09:00', true))

  const saturday = new Date(2026, 0, 3, 10, 0)
  const monday = new Date(2026, 0, 5, 10, 0)
  ok('and nothing at the weekend unless you said so',
     !deliveryDue(saturday, '09:00', false) && deliveryDue(saturday, '09:00', true) &&
     deliveryDue(monday, '09:00', false))

  await call('settings:save', { notifications: false, notifyWeekends: true, onboardedAt: '' })
  ok('a machine that has never finished the introduction is never interrupted by one',
     (await deliverNotifications(at(10, 0))) === 0)

  await call('settings:save', { onboardedAt: new Date().toISOString() })
  ok('nor is one whose owner has turned notifications off',
     (await deliverNotifications(at(10, 0))) === 0 && __notifications.length === 0)

  await call('settings:save', { notifications: true })
  const delivered = await deliverNotifications(at(10, 0))
  ok('the morning delivery puts the day on the desktop', delivered > 0, `${delivered} shown`)
  ok('and what it showed is what the workspace said it would',
     __notifications.some((n: any) => n.title === 'Send the deck is due today'),
     __notifications.map((n: any) => n.title).join(' | '))

  // The whole of the once-a-day guarantee is a row and a unique index, so a machine
  // restarted four times before lunch is the same as one left running.
  const shownOnce = __notifications.length
  ok('running it again the same day says nothing twice',
     (await deliverNotifications(at(11, 30))) === 0 && __notifications.length === shownOnce)

  ok('what was said is written down, once per kind per day',
     (await q<{ n: number }>(
       `SELECT count(*)::int AS n FROM notification WHERE workspace_id = $1 AND on_date = $2`,
       [quiet.id, now]
     ))[0]?.n === said.length,
     `${said.length} kinds`)

  // Something new arriving after the delivery is still told, because its kind has
  // not been claimed today. What cannot happen is the same kind arriving twice.
  await call('workspace:save', { id: quiet.id, notifyTaskDayAfter: false })
  await exec('DELETE FROM notification WHERE workspace_id = $1 AND kind = $2', [quiet.id, 'task-day'])
  await call('task:save', { projectId: rollout.id, title: 'One more', dueDate: now })
  const laterThatDay = await deliverNotifications(at(12, 0))
  ok('a kind whose day has not been claimed is still delivered',
     laterThatDay === 1 && __notifications[__notifications.length - 1].title === '2 items are due today',
     __notifications[__notifications.length - 1]?.title)

  // The desktop's answer, not the fact that it was asked. `show()` resolves nothing
  // and throws nothing — a refusal arrives on an event a moment later — so reporting
  // straight away is how this came to say "Sent" while nothing appeared.
  const tested = await call('notification:test')
  ok('a test notification reports what the desktop did with it, not that it was tried',
     tested.shown === true && tested.reason === '' &&
     __notifications[__notifications.length - 1].title === 'Neo can reach you here',
     __notifications[__notifications.length - 1]?.title)

  ok('and it is a test rather than a delivery, so it claims no day',
     (await q<{ n: number }>(
       `SELECT count(*)::int AS n FROM notification WHERE title = 'Neo can reach you here'`))[0]?.n === 0)

  // Only macOS puts a question in front of an app before it may show one, and that is
  // the whole of what decides whether the first-run flow has a panel about it.
  const canNotify = await call('notification:capability')
  ok('the app reports whether this desktop asks permission before it will show one',
     canNotify.supported === true && canNotify.gated === (process.platform === 'darwin'),
     `${process.platform}: gated=${canNotify.gated}`)

  await call('workspace:delete', { id: quiet.id })
  ok('deleting the workspace takes what it was told with it',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM notification WHERE workspace_id = $1',
                             [quiet.id]))[0]?.n === 0)

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
   * thing under test: the environment is moved somewhere disposable for the length
   * of it.
   *
   * Every variable the three platforms consult has to move, not just HOME — Windows
   * reads its home from USERPROFILE, and both it and Linux prefer APPDATA and
   * XDG_CONFIG_HOME over the home directory anyway. Moving HOME alone left the two
   * of them writing into the machine's own configuration and reading a macOS-shaped
   * path back, so the assertions below held on one platform out of three and quietly
   * failed on the other two.
   */
  const movedEnv = ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME'] as const
  const realEnv = new Map(movedEnv.map((key) => [key, process.env[key]]))
  const fakeHome = mkdtempSync(join(tmpdir(), 'neo-claude-'))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  process.env.APPDATA = join(fakeHome, 'AppData', 'Roaming')
  process.env.XDG_CONFIG_HOME = join(fakeHome, '.config')

  // Where that leaves the file is the app's own answer, never a second copy of the
  // rule — asking it is also what proves the redirection took.
  const claudeConfig = (await call('mcp:status')).configPath
  ok('the file it would write is inside the disposable home, not the real one',
     claudeConfig.startsWith(fakeHome))
  mkdirSync(dirname(claudeConfig), { recursive: true })

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

  for (const [key, value] of realEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  await stopBridge()
  ok('closing the bridge takes the endpoint away, so the connector knows the app is shut',
     !existsSync(endpointFile()) && !existsSync(info.endpoint))

  /*
   * The splash screen is loaded as a `data:` URL before the database is open, so
   * anything it referenced would resolve against nothing and silently not appear —
   * and it has one job, which is to be on screen immediately.
   */
  const splash = splashDocument(false)
  ok('the splash screen references nothing it would have to fetch',
     // `url(#...)` is the gradient it defines itself, which is the one kind allowed.
     !/<script|<link|src=|@import|:\/\/|url\((?!#)/i.test(splash) && splash.includes('Neo'))
  ok('the splash screen draws the same mark the sidebar does',
     splash.includes(`rx="${MARK.face.r}"`) &&
     MARK.steps.every((s) => splash.includes(`x="${s.x}" y="${s.y}"`)))

  /*
   * A fresh install lands in the home directory, not in Documents. The database is
   * the application's working state rather than one of your files, and Documents on
   * a Mac may be an iCloud-synced folder — which is a poor place for something being
   * written to constantly. `verify:upgrade` asserts the other half: that an older
   * install is *moved* here rather than left behind.
   */
  const where = await call('settings:get')
  ok('a new install keeps its data in a dotfolder at home',
     // `basename`, not a trailing '/.neo': Windows separates with a backslash, and
     // the literal made this assertion unfailable there — it was simply always false.
     basename(where.dataDir) === '.neo' && where.markdownDir === join(where.dataDir, 'markdown'),
     where.dataDir)

  /* ------------------------------------------------------------------ updating */

  ok('versions sort the way a person reads them',
     compareVersions('1.2.0', '1.10.0') < 0 &&
     compareVersions('1.2.0', '1.2.0') === 0 &&
     compareVersions('v2.0.0', '1.99.99') > 0 &&
     // A missing segment is a zero, so these are the same version and not two.
     compareVersions('1.2.0', '1.2') === 0 &&
     // A pre-release comes before the version it is leading up to, never after it.
     compareVersions('1.2.0-beta.1', '1.2.0') < 0 &&
     isNewer('1.3.0', '1.2.9') && !isNewer('1.2.9', '1.2.9') && !isNewer('1.2.8', '1.2.9'))

  const assets = [
    { name: 'Neo-1.2.0-arm64.dmg', url: 'https://github.com/a/b/1', bytes: 1 },
    { name: 'Neo-1.2.0-arm64-mac.zip', url: 'https://github.com/a/b/2', bytes: 2 },
    { name: 'Neo-1.2.0-mac.zip', url: 'https://github.com/a/b/3', bytes: 3 },
    { name: 'Neo-Setup-1.2.0.exe', url: 'https://github.com/a/b/4', bytes: 4 },
    { name: 'Neo-1.2.0.AppImage', url: 'https://github.com/a/b/5', bytes: 5 }
  ]
  ok('each machine is offered the file that belongs on it',
     pickAsset(assets, 'darwin', 'arm64')?.name === 'Neo-1.2.0-arm64-mac.zip' &&
     // Intel is the name with no architecture in it, which is how electron-builder
     // writes it — and it must never be the answer for Apple silicon.
     pickAsset(assets, 'darwin', 'x64')?.name === 'Neo-1.2.0-mac.zip' &&
     pickAsset(assets, 'win32', 'x64')?.name === 'Neo-Setup-1.2.0.exe' &&
     pickAsset(assets, 'linux', 'x64')?.name === 'Neo-1.2.0.AppImage')

  /*
   * The failure this guards against is silent and permanent: an Apple silicon Mac
   * will happily run the Intel build under Rosetta, so a loose match would move
   * somebody onto the wrong architecture and nothing anywhere would say so.
   */
  ok('a Mac is never handed the wrong architecture',
     pickAsset(assets.filter((a) => !a.name.includes('arm64')), 'darwin', 'arm64') === null)

  ok('a release only offers assets from the place it lives',
     parseRelease({ tag_name: 'v1.3.0', body: 'x', assets: [
       { name: 'Neo-1.3.0-mac.zip', browser_download_url: 'https://example.com/evil.zip', size: 1 },
       { name: 'Neo-1.3.0-arm64-mac.zip', browser_download_url: 'https://github.com/a/b/z', size: 1 }
     ] })?.assets.length === 1 &&
     parseRelease({ tag_name: 'v1.3.0', prerelease: true, assets: [] }) === null &&
     parseRelease({ tag_name: 'v1.3.0', draft: true, assets: [] }) === null &&
     parseRelease({ tag_name: 'nightly', assets: [] }) === null)

  /*
   * Off means **no request**, exactly as it does for the weather, and this is the
   * assertion that keeps it true. It counts sockets rather than trusting a returned
   * value: a version that fetched and threw the answer away would pass any check
   * that only looked at what came back.
   */
  const before = __fetches.length
  setUpdatePreference('off')
  await checkForUpdate()
  ok('updates switched off ask nobody anything',
     __fetches.length === before && updateStatus().phase !== 'checking')

  ok('the swap waits for the app to go, and puts the old one back if it cannot land',
     (() => {
       const script = macSwapScript({
         app: '/Applications/Neo.app', staged: '/tmp/s/Neo.app', backup: '/tmp/s/previous.app', pid: 4242
       })
       return script.includes('kill -0 4242') &&
         // Moved aside, never deleted: a failed move must leave somebody running the
         // version they already had rather than nothing at all.
         script.includes('mv "$APP" "$BACKUP"') &&
         script.includes('mv "$BACKUP" "$APP"') &&
         // Opened before anything is tidied, so a slow disk cannot cost an app.
         script.indexOf('open "$APP"') < script.lastIndexOf('rm -rf "$BACKUP"') &&
         appImageSwapScript({ image: '/opt/Neo.AppImage', staged: '/tmp/n', pid: 7 })
           .includes('kill -0 7')
     })())

  /* ----------------------------------------------------------------- the changelog */

  ok('a changelog reads its front matter, and its heading when it has none',
     (() => {
       const full = parseChangelog('1.2.0', '---\ntitle: Big news\ndate: 2026-09-06\n---\n\nHello.')
       const heading = parseChangelog('1.1.0', '# From the heading\n\nBody.')
       const bare = parseChangelog('1.0.0', 'Just a sentence.')
       return full.title === 'Big news' && full.date === '2026-09-06' && full.body === 'Hello.' &&
         // The heading becomes the title and leaves the body, so it is not drawn twice.
         heading.title === 'From the heading' && heading.body === 'Body.' &&
         bare.title === 'Version 1.0.0' && bare.body === 'Just a sentence.'
     })())

  ok('a changelog illustration is pointed at the only scheme that can serve it',
     (() => {
       const entry = parseChangelog('1.2.0', '![How it works](media/how.svg)\n\n![Remote](https://x/y.png)')
       return entry.body.includes('![How it works](neo-media://changelog/media/how.svg)') &&
         // Left exactly as written, and therefore drawn as its alt text: the point of
         // bundling these is that they work with no network.
         entry.body.includes('![Remote](https://x/y.png)')
     })())

  ok('only a version-shaped name is a changelog',
     changelogVersion('1.2.0.md') === '1.2.0' && changelogVersion('README.md') === '' &&
     changelogVersion('../secrets.md') === '')

  /*
   * The release workflow refuses a tag with no changelog file, so this is the same
   * rule enforced a step earlier: saying what changed is part of shipping it, and
   * finding that out from a failed release is finding it out too late.
   */
  const version = (await call('settings:get')).appVersion
  const shipped = await readChangelog(version)
  const history = await listChangelog()
  ok('this version says what changed in it',
     Boolean(shipped?.body) || version === '0.0.0-test',
     version)
  ok('the changelog is newest first',
     history.length > 0 && history.every((entry: any, i: number) =>
       i === 0 || compareVersions(history[i - 1].version, entry.version) > 0))

  ok('a changelog illustration cannot be asked for outside its own folder',
     changelogMedia('media/how-an-update-arrives.svg') !== '' &&
     changelogMedia('../../package.json') === '' &&
     changelogMedia('../README.md') === '' &&
     // Only an image, whatever else is in there.
     changelogMedia('1.2.0.md') === '')

  const updateSettings = await call('settings:save', { updates: 'notify' })
  ok('how much updating happens by itself is remembered',
     updateSettings.updates === 'notify' &&
     (await call('settings:save', { updates: 'nonsense' })).updates === 'automatic')

  // Destructive, so it runs last.
  await call('workspace:delete', { id: consultancy })
  ok('a deleted active workspace falls back to a real one',
     [dayJob, own].includes((await call('settings:get')).activeWorkspaceId))

  await closeDb()
}

main().catch((e) => {
  console.error('THREW', e)
  /*
   * Leave at once, rather than setting an exit code and letting the loop drain.
   *
   * A throw part-way through skips `closeDb()`, and by then the MCP bridge is
   * listening on its socket — so nothing is left to finish but nothing lets go
   * either, and the process sits there forever. Locally that is a terminal you
   * press Ctrl-C in; on a runner it is six hours of a job nobody is watching,
   * billed at ten times the rate on macOS. A failed assertion says FAIL and
   * carries on; anything that reaches here has already given up, so there is
   * nothing left to tidy.
   */
  process.exit(1)
})
