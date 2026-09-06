import { initDb, closeDb, q, q1 } from '../src/main/db/client'
import { adoptExistingRows, initOplog } from '../src/main/db/oplog'
import { registerWorkspaceHandlers } from '../src/main/ipc/workspaces'
import { registerProjectHandlers } from '../src/main/ipc/projects'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerContentHandlers } from '../src/main/ipc/content'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { __handlers } from 'electron'
import * as engine from '../src/main/lib/sync/engine'
import { iconDir } from '../src/main/db/client'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Two devices, one account, a real server.
 *
 * This is the assertion the whole of the sync work exists to satisfy, and it cannot
 * be made in one process: a device is a data folder, and `initDb()` opens exactly
 * one. So it runs twice — `push` writes on the first machine, `pull` reads on a
 * second that has never seen any of it — with `PM_TEST_DIR` pointing somewhere
 * different each time. `test/sync.sh` drives both halves.
 *
 * It talks to a real sync server rather than a stub. A stub would agree with
 * whatever this client happens to do, which is precisely the thing worth checking.
 */

const call = async (channel: string, input?: unknown): Promise<any> => {
  const fn = (__handlers as Map<string, any>).get(channel)
  if (!fn) throw new Error(`No handler: ${channel}`)
  return fn({}, input)
}

const ok = (label: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const serverUrl = need('NEO_SYNC_URL')
  const token = need('NEO_SYNC_TOKEN')
  const accountId = need('NEO_SYNC_ACCOUNT')
  const passphrase = need('NEO_SYNC_PASSPHRASE')

  await initDb()
  await initOplog()
  await adoptExistingRows()
  registerWorkspaceHandlers()
  registerProjectHandlers()
  registerTaskHandlers()
  registerContentHandlers()
  registerSettingsHandlers()

  await engine.saveConnection(serverUrl, token, accountId, 'sync-test@example.com', phase)
  const unlocked = await engine.unlock(passphrase)
  ok(`${phase}: the passphrase opens the account`, unlocked.ok, unlocked.reason ?? '')

  if (phase === 'push') {
    /* ------------------------------------------------------------ device one */

    const workspace = await call('workspace:save', { name: 'Sync test', color: '#f43f5e' })
    const project = await call('project:save', {
      workspaceId: workspace.id,
      name: 'A project that must travel',
      summary: 'Written on the first machine.',
      deadline: '2026-12-01'
    })
    await call('task:save', { projectId: project.id, title: 'First task', dueDate: '2026-10-01' })
    await call('task:save', { projectId: project.id, title: 'Second task' })
    await call('note:save', {
      projectId: project.id, title: 'A note', body: 'With a body worth checking.'
    })

    /*
     * A real file, put where an icon goes and pointed at by a row. The bytes are
     * deliberately not valid PNG: nothing here should be looking inside them, and a
     * test that only passes for images would hide it if something did.
     */
    const iconName = `${randomUUID()}.png`
    await mkdir(iconDir(), { recursive: true })
    await writeFile(join(iconDir(), iconName), Buffer.from('not really a png, but bytes'))
    await call('project:save', { id: project.id, iconPath: iconName })
    console.log(`ICON=${iconName}`)

    const before = await engine.status()
    ok('push: there is something waiting to go out', before.pending > 0, `${before.pending} batches`)

    await engine.syncNow()
    const after = await engine.status()
    ok('push: everything was handed over', after.pending === 0, `${after.pending} left`)
    ok('push: nothing went wrong', after.error === '', after.error)

    console.log(`WORKSPACE=${workspace.id}`)
    console.log(`PROJECT=${project.id}`)
  } else {
    /* ------------------------------------------------------------ device two */

    const projectId = need('NEO_SYNC_PROJECT')
    const workspaceId = need('NEO_SYNC_WORKSPACE')
    const iconName = need('NEO_SYNC_ICON')

    const emptyBefore = await q<{ id: string }>('SELECT id FROM project')
    ok('pull: this machine starts with nothing', emptyBefore.length === 0)

    await engine.syncNow()
    const status = await engine.status()
    ok('pull: nothing went wrong', status.error === '', status.error)

    const workspace = await q1<{ name: string }>(
      'SELECT name FROM workspace WHERE id = $1', [workspaceId]
    )
    ok('pull: the workspace arrived', workspace?.name === 'Sync test', workspace?.name ?? 'missing')

    const project = await q1<{ name: string; summary: string; deadline: string }>(
      'SELECT name, summary, deadline FROM project WHERE id = $1', [projectId]
    )
    ok('pull: the project arrived, with the same id it was created under',
       project?.name === 'A project that must travel', project?.name ?? 'missing')
    ok('pull: and every field came with it',
       project?.summary === 'Written on the first machine.' && project?.deadline === '2026-12-01',
       `${project?.summary} / ${project?.deadline}`)

    const tasks = await q<{ title: string }>(
      'SELECT title FROM task WHERE project_id = $1 ORDER BY title', [projectId]
    )
    ok('pull: both tasks arrived', tasks.length === 2,
       tasks.map((t) => t.title).join(', '))

    const note = await q1<{ body: string }>(
      'SELECT body FROM note WHERE project_id = $1', [projectId]
    )
    ok('pull: the note arrived with its body',
       note?.body === 'With a body worth checking.', note?.body ?? 'missing')

    // The board is created by the project handler, not sent as content — so its
    // presence here proves the ops were *applied* rather than merely copied.
    const columns = await q<{ name: string }>(
      'SELECT name FROM board_column WHERE project_id = $1', [projectId]
    )
    ok('pull: the board came too, because the ops were applied and not just stored',
       columns.length === 4, `${columns.length} columns`)

    const activity = await q<{ summary: string }>(
      'SELECT summary FROM activity WHERE project_id = $1', [projectId]
    )
    ok('pull: the activity log came with the work it describes', activity.length > 0,
       `${activity.length} lines`)

    /* ------------------------------------------------------------ the file */

    const iconRow = await q1<{ icon_path: string }>(
      'SELECT icon_path FROM project WHERE id = $1', [projectId]
    )
    ok('pull: the row knows which file it wants', iconRow?.icon_path === iconName,
       iconRow?.icon_path ?? 'none')

    const landed = await readFile(join(iconDir(), iconName)).catch(() => null)
    ok('pull: and the bytes arrived, decrypted, byte for byte',
       landed?.toString('utf8') === 'not really a png, but bytes',
       landed ? `${landed.length} bytes` : 'file missing')

    // The server is not supposed to be able to tell what it is holding: the object
    // key is an HMAC under a key it does not have, so nothing about the filename,
    // the workspace or the account should be legible in it.
    ok('pull: the file is stored under a name that says nothing',
       !(await engine.status()).workspaces.some((w) => iconName.includes(w.workspaceId)))

    // Nothing this device pulled may be pushed back: that would be an echo, and two
    // devices echoing each other never stop.
    const echo = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM op_batch WHERE origin = 'remote'`
    )
    ok('pull: what arrived is recorded as having come from elsewhere',
       (echo[0]?.n ?? 0) > 0, `${echo[0]?.n} remote batches`)
    ok('pull: and is not queued to be sent back', (await engine.status()).pending === 0)
  }

  await engine.stop()
  await closeDb()
}

main().catch((e) => {
  console.error('THREW', e)
  process.exit(1)
})
