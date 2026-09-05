import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { app } from 'electron'
import {
  BRIDGE_PROTOCOL,
  type BridgeCall,
  type BridgeGreeting,
  type BridgeResult,
  type BridgeTool
} from '@shared/mcp'
import { TOOLS, TOOLS_BY_NAME, type Tool, type ToolContext } from '../ai/tools'
import { invokeChannel } from '../../ipc/util'

/**
 * The door Claude Desktop knocks on.
 *
 * This is the whole of the app's side of the MCP bridge, and it is deliberately
 * thin: it resolves which workspace a call is about, then hands the call to the
 * same `TOOLS` the assistant panel uses. There is no SQL here and no second set of
 * writes — a task Claude Desktop creates logs activity, bumps the project's clock
 * and lands in the Markdown mirror for the same reason an assistant-made one does,
 * because it is that code path rather than a copy of it.
 *
 * It listens on a Unix domain socket inside the app's own support folder, not a
 * port. Nothing on the network can reach it, the file's permissions keep it to this
 * account, and there is no port to collide with anything.
 */

let server: Server | null = null
let token = ''

const supportDir = (): string => app.getPath('userData')

/** Windows has no Unix sockets; a named pipe answers to the same `socketPath`. */
export const endpointPath = (): string =>
  process.platform === 'win32' ? '\\\\.\\pipe\\neo-mcp' : join(supportDir(), 'mcp.sock')

/** Where the MCP server looks to find out whether Neo is open, and how to reach it. */
export const endpointFile = (): string => join(supportDir(), 'mcp.json')

/** Whether anything is listening — which, the app being open, it should be. */
export const isBridgeOpen = (): boolean => server !== null

/* ------------------------------------------------------------------ describing */

/** `create_task` reads as "Create task" in a client's list of what it can do. */
const titleFor = (name: string): string => {
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Every scoped channel in this app names its workspace, and a call arriving from
 * outside it is no exception — so the argument is added to every tool's schema
 * rather than assumed. It is optional only because leaving it out means the one
 * workspace Neo is showing, which is a single workspace and not "all of them"; the
 * reply says which one it was, so the choice is never silent.
 */
const WORKSPACE_ARGUMENT = {
  type: 'string',
  description:
    'Which working life this is about: a workspace name, or its id. Leave it out to use the one Neo is currently showing.'
}

export function describeTool(tool: Tool): BridgeTool {
  const schema = tool.parameters as { properties?: Record<string, unknown> }
  return {
    name: tool.name,
    title: titleFor(tool.name),
    description: tool.description,
    parameters: {
      ...tool.parameters,
      properties: { ...(schema.properties ?? {}), workspace: WORKSPACE_ARGUMENT }
    },
    writes: tool.writes,
    destroys: Boolean(tool.destroys)
  }
}

export const describeTools = (): BridgeTool[] => TOOLS.map(describeTool)

/* -------------------------------------------------------------------- calling */

/**
 * A name is what a person says and an id is what a tool takes, so either will do —
 * resolved against the workspaces that are actually there, and reported by name in
 * the answer. An ambiguous name says so rather than picking one, exactly as the
 * tools themselves do when a project name matches twice.
 */
async function resolveWorkspace(ref: unknown): Promise<{ id: string; name: string }> {
  const all = (await invokeChannel('workspace:list')).filter((w) => !w.archivedAt)
  if (all.length === 0) throw new Error('Neo has no workspaces yet. Create one in the app first.')

  const text = typeof ref === 'string' ? ref.trim() : ''
  if (!text) {
    const activeId = (await invokeChannel('settings:get')).activeWorkspaceId
    const active = all.find((w) => w.id === activeId)
    return active ?? all[0]
  }

  const exact = all.filter((w) => w.id === text || w.name.toLowerCase() === text.toLowerCase())
  if (exact.length === 1) return exact[0]
  const loose = all.filter((w) => w.name.toLowerCase().includes(text.toLowerCase()))
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) {
    throw new Error(`"${text}" matches ${loose.map((w) => w.name).join(', ')}. Say which one is meant.`)
  }
  throw new Error(`No workspace called "${text}". There is ${all.map((w) => w.name).join(', ')}.`)
}

/**
 * Run one tool on behalf of a client outside the app.
 *
 * A write still builds its confirmation line first. Nothing shows it here — the
 * client did its own asking before the call arrived — but `summary()` validates as
 * it phrases, so a bad date or an id from another workspace fails before anything
 * is written rather than after, and the sentence it produces goes back with the
 * result so the transcript records what changed in words rather than in arguments.
 */
export async function callTool(call: BridgeCall): Promise<BridgeResult> {
  try {
    const tool = TOOLS_BY_NAME.get(call.tool)
    if (!tool) throw new Error(`Neo has no tool called "${call.tool}".`)

    const { workspace: ref, ...args } = call.arguments ?? {}
    const workspace = await resolveWorkspace(ref)
    const ctx: ToolContext = { workspaceId: workspace.id }

    const summary = tool.writes && tool.summary ? await tool.summary(args, ctx) : null
    const result = await tool.run(args, ctx)
    return { ok: true, workspace: workspace.name, summary, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* --------------------------------------------------------------------- serving */

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // A note or a meeting body can be long; a megabyte is far more than any of them.
    if (size > 1_048_576) throw new Error('That request is too large.')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function authorised(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers['x-neo-token'] ?? ''))
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

async function greeting(): Promise<BridgeGreeting> {
  const workspaces = (await invokeChannel('workspace:list')).filter((w) => !w.archivedAt)
  const activeId = (await invokeChannel('settings:get')).activeWorkspaceId
  return {
    app: 'neo',
    protocol: BRIDGE_PROTOCOL,
    version: app.getVersion(),
    pid: process.pid,
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, active: w.id === activeId }))
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) return send(res, 401, { error: 'Bad token.' })
  const path = (req.url ?? '').split('?')[0]

  if (req.method === 'GET' && path === '/') return send(res, 200, await greeting())
  if (req.method === 'GET' && path === '/tools') return send(res, 200, { tools: describeTools() })
  if (req.method === 'POST' && path === '/call') {
    const body = (await readBody(req)) as BridgeCall
    return send(res, 200, await callTool(body))
  }
  send(res, 404, { error: `No ${req.method} ${path}.` })
}

/**
 * Start listening. Failing to is never fatal: the app is a project tracker first,
 * and a bridge that cannot open is a feature that is off, not a launch that stops.
 */
export async function startBridge(): Promise<string | null> {
  if (server) return endpointPath()
  const path = endpointPath()

  // Only one Neo runs at a time — the single-instance lock and the data folder's own
  // lock both see to that — so a socket still sitting here was left by a crash.
  if (process.platform !== 'win32' && existsSync(path)) rmSync(path, { force: true })

  token = randomBytes(24).toString('hex')
  const listener = createServer((req, res) => {
    void route(req, res).catch((error: unknown) =>
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    )
  })
  listener.on('error', (error) => console.error('The Claude bridge stopped listening:', error))

  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(path, () => resolve())
    })
  } catch (error) {
    console.error('Could not open the Claude bridge:', error)
    return null
  }

  server = listener
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  writeFileSync(
    endpointFile(),
    `${JSON.stringify({ protocol: BRIDGE_PROTOCOL, endpoint: path, token, pid: process.pid }, null, 2)}\n`,
    { mode: 0o600 }
  )
  return path
}

/**
 * Take the door away on the way out. The file is what says "Neo is open", so it has
 * to go before the process does — otherwise the MCP server spends the next session
 * knocking on a socket nobody is behind.
 */
export async function stopBridge(): Promise<void> {
  const listener = server
  server = null
  token = ''
  try {
    rmSync(endpointFile(), { force: true })
  } catch {
    // Already gone.
  }
  if (!listener) return
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  if (process.platform !== 'win32') {
    try {
      rmSync(endpointPath(), { force: true })
    } catch {
      // Already gone.
    }
  }
}
