#!/usr/bin/env node
/**
 * Move a Neo installation's local data into a Neo Cloud account. Run once.
 *
 * Before Neo kept everything in Neo Cloud it kept everything in `~/.neo`: a PGlite
 * database, the icons, the pictures and files, and the recordings' audio. This reads
 * all of it and puts it into an account that has nothing in it yet — the same ids, the
 * same text, the same files — so signing in to the new app finds a working life exactly
 * as it was left.
 *
 * It changes nothing on this machine. The database is copied to a temporary folder and
 * the copy is what is opened (PGlite writes to a folder just by opening it), and the
 * original folder is left where it is. Delete it yourself once you have looked around
 * in the app and are happy.
 *
 *   node scripts/import-local-data.mjs --username you [--data ~/.neo] [--server https://…]
 *
 * The password is asked for, and not echoed. NEO_PASSWORD may be set instead, for a
 * test. An account that only has a passkey can add a password in the app, under
 * Settings › Account, and use that here. Quit Neo first: the script refuses to run while a copy of the old app has the
 * folder open.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { PGlite } from '@electric-sql/pglite'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1]])
    return pairs
  }, [])
)

/** The temporary copy of the database, removed however the script ends. */
let copy = ''

const dataDir = (args.data ?? join(homedir(), '.neo')).replace(/^~/, homedir())
const server = (args.server ?? process.env.NEO_CLOUD_URL ?? 'https://sync.neomoon.io').replace(/\/+$/, '')
const username = args.username
if (!username) fail('Say which account to import into: --username <your username>')
if (!existsSync(join(dataDir, 'db'))) fail(`There is no Neo database in ${dataDir}.`)

/*
 * The old app wrote its process id into `.lock` while it had the folder open. A copy
 * taken while it is writing could be half of a transaction.
 */
try {
  const holder = Number(readFileSync(join(dataDir, '.lock'), 'utf8').trim())
  if (holder && holder !== process.pid) {
    process.kill(holder, 0)
    fail(`Neo is still open (process ${holder}). Quit it, then run this again.`)
  }
} catch (error) {
  if (error?.code !== 'ESRCH' && error?.code !== 'ENOENT') throw error
}

/** In foreign-key order: everything a row refers to arrives before the row. */
const TABLES = [
  'workspace', 'workspace_link', 'project_folder', 'project_collapsible', 'project', 'board_column',
  'person', 'membership', 'task', 'content_folder', 'note', 'canvas', 'note_image', 'meeting',
  'meeting_attendee', 'meeting_todo', 'decision', 'link', 'journal_entry', 'activity', 'setting',
  'notification', 'conversation', 'chat_message', 'chat_attachment', 'recording', 'recording_segment',
  'transcript_cue', 'summary_part'
]

const password = process.env.NEO_PASSWORD ?? (await ask(`Password for ${username} on ${server}: `))

copy = mkdtempSync(join(tmpdir(), 'neo-import-'))
try {
  console.log(`Copying the database out of ${dataDir}…`)
  cpSync(join(dataDir, 'db'), join(copy, 'db'), { recursive: true })
  const db = new PGlite(join(copy, 'db'))
  await db.waitReady

  const token = (await request('POST', '/v1/auth/password/login', {
    username, password, deviceName: 'Neo import', platform: process.platform
  })).token
  const authed = { Authorization: `Bearer ${token}` }

  const workspaces = await request('GET', '/v1/workspaces', undefined, authed)
  if (workspaces.length > 0) {
    fail(`${username} already has ${workspaces.length} workspace(s) in Neo Cloud. Import only goes into an empty account.`)
  }

  const existing = new Set((await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).rows.map((r) => r.table_name))

  const tables = {}
  for (const table of TABLES) {
    if (!existing.has(table)) continue
    tables[table] = (await db.query(`SELECT * FROM ${table}`)).rows.map(plain)
  }
  await db.close()

  /* ---------------------------------------------------------------- files */

  let sent = 0
  let missing = 0

  const put = async (name, kind, path) => {
    if (!existsSync(path)) {
      missing++
      console.warn(`  missing: ${path}`)
      return false
    }
    await upload(`/v1/files/${encodeURIComponent(name)}?kind=${kind}`, readFileSync(path), authed)
    sent++
    return true
  }

  console.log('Sending pictures and files…')
  const pictures = [
    ...(tables.workspace ?? []).flatMap((w) => [[w, 'icon_path', 'icon'], [w, 'banner_path', 'banner']]),
    ...(tables.project ?? []).map((p) => [p, 'icon_path', 'icon']),
    ...(tables.person ?? []).map((p) => [p, 'avatar_path', 'avatar'])
  ]
  const done = new Map()
  for (const [row, column, kind] of pictures) {
    const name = row[column]
    if (!name) continue
    if (!done.has(name)) done.set(name, await put(name, kind, join(dataDir, 'icons', name)))
    // A reference to a file that is gone is cleared rather than imported broken.
    if (!done.get(name)) row[column] = ''
  }
  for (const setting of tables.setting ?? []) {
    if (setting.key !== 'profileAvatarPath' || !setting.value) continue
    if (!done.has(setting.value)) done.set(setting.value, await put(setting.value, 'avatar', join(dataDir, 'icons', setting.value)))
    if (!done.get(setting.value)) setting.value = ''
  }
  for (const image of tables.note_image ?? []) {
    if (image.path) await put(image.path, 'image', join(dataDir, 'attachments', image.path))
  }
  for (const attachment of tables.chat_attachment ?? []) {
    if (attachment.path) await put(attachment.path, 'attachment', join(dataDir, 'attachments', attachment.path))
  }

  /*
   * Audio was a file named for its position inside a folder named for its recording.
   * In Neo Cloud a segment's file has a name of its own, so each is given one and the
   * row is told what it is.
   */
  console.log('Sending recordings…')
  for (const segment of tables.recording_segment ?? []) {
    if (!segment.path) continue
    const source = join(dataDir, 'recordings', segment.recording_id, segment.path)
    const name = `${randomUUID()}${extname(segment.path).toLowerCase() || '.webm'}`
    segment.path = (await put(name, 'audio', source)) ? name : ''
    if (!segment.path) segment.bytes = 0
  }

  /* ---------------------------------------------------------------- rows */

  console.log('Sending the work…')
  const result = await request('POST', '/v1/data/import', { tables }, authed)
  await request('POST', '/v1/auth/logout', undefined, authed).catch(() => {})

  console.log('\nImported:')
  for (const [table, count] of Object.entries(result.rows)) console.log(`  ${table.padEnd(22)} ${count}`)
  console.log(`  ${'files'.padEnd(22)} ${sent}${missing ? ` (${missing} missing on disk, skipped)` : ''}`)
  console.log(`\nDone. Sign in to Neo as ${username} to see it. ${dataDir} has not been changed;`)
  console.log('delete it yourself once you are happy with what is in Neo Cloud.')
} finally {
  rmSync(copy, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ helpers */

/** A row as JSON can carry it: dates as ISO strings, bigints as numbers. */
function plain(row) {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString()
    else if (typeof value === 'bigint') out[key] = Number(value)
    else out[key] = value
  }
  return out
}

async function request(method, path, body, headers = {}) {
  const response = await fetch(server + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : null
  if (!response.ok) fail(`${method} ${path}: ${parsed?.error ?? response.status}`)
  return parsed
}

async function upload(path, bytes, headers) {
  const response = await fetch(server + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: bytes
  })
  if (!response.ok) {
    const text = await response.text()
    fail(`PUT ${path}: ${(text && JSON.parse(text).error) || response.status}`)
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

function fail(message) {
  console.error(message)
  if (copy) rmSync(copy, { recursive: true, force: true })
  process.exit(1)
}
