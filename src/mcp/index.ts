import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type StandardSchemaWithJSON
} from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  BRIDGE_PROTOCOL,
  type BridgeEndpoint,
  type BridgeGreeting,
  type BridgeResult,
  type BridgeTool
} from '@shared/mcp'

/**
 * Neo, as Claude Desktop sees it.
 *
 * This process owns nothing. It speaks MCP on stdin and stdout, and every call it
 * receives it forwards over a local socket to the running app, which answers with
 * the same tools the assistant panel uses. It never opens the database — PGlite has
 * no lock, and a second process in that folder is the one thing that can damage it.
 *
 * Nothing here may ever write to stdout: that is the wire. Anything worth saying
 * goes to stderr, which the host collects into its own log.
 */

/**
 * The tools, as they stood when this was built.
 *
 * They are baked in rather than fetched, so the list is there the moment Claude
 * Desktop starts — which is routinely before Neo is open. It cannot drift, because
 * it is generated from `TOOLS` by the same build that produces this file. Calls are
 * dispatched by name in the app, so a Neo that is newer than this bundle still
 * answers correctly; only the descriptions would be a version behind.
 */
declare const __NEO_TOOLS__: BridgeTool[]

/** The app version this was built from, so the client and the manifest agree. */
declare const __NEO_VERSION__: string

const NOT_RUNNING =
  'Neo is not open, so there is nothing to read or change. Open Neo and try again — ' +
  'it holds the database, and this connection deliberately has no way in on its own.'

/* ----------------------------------------------------------------- connecting */

/** Where Electron puts the app's support folder, which is where the bridge leaves its key. */
function endpointFile(): string {
  if (process.env.NEO_BRIDGE) return process.env.NEO_BRIDGE
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Neo', 'mcp.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Neo', 'mcp.json')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Neo', 'mcp.json')
}

function endpoint(): BridgeEndpoint {
  let raw: string
  try {
    raw = readFileSync(endpointFile(), 'utf8')
  } catch {
    // The file is written when the bridge opens and removed when it closes, so its
    // absence is the ordinary "the app is shut" case and not a fault worth dressing up.
    throw new Error(NOT_RUNNING)
  }
  const info = JSON.parse(raw) as BridgeEndpoint
  if (info.protocol !== BRIDGE_PROTOCOL) {
    throw new Error(
      `This connector speaks version ${BRIDGE_PROTOCOL} of Neo's bridge and Neo is speaking ` +
        `${info.protocol}. Update whichever of the two is older.`
    )
  }
  return info
}

/** One request to the app, over its socket. No port is ever opened or dialled. */
async function ask<T>(path: string, payload?: unknown): Promise<T> {
  const info = endpoint()
  const body = payload === undefined ? null : JSON.stringify(payload)

  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: info.endpoint,
        path,
        method: body === null ? 'GET' : 'POST',
        headers: {
          'x-neo-token': info.token,
          ...(body === null
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new Error(`Neo answered with something that is not JSON: ${text.slice(0, 200)}`))
            return
          }
          const status = res.statusCode ?? 0
          if (status >= 400) {
            reject(new Error(String((parsed as { error?: string }).error ?? `Neo answered ${status}.`)))
            return
          }
          resolve(parsed as T)
        })
      }
    )

    req.on('error', (error: NodeJS.ErrnoException) => {
      // A socket that is not there, or is there but unattended, both mean the app went away.
      const gone = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
      reject(gone ? new Error(NOT_RUNNING) : error)
    })
    // Long enough for a real query, short enough that a wedged app does not hang the chat.
    req.setTimeout(120_000, () => req.destroy(new Error('Neo did not answer within two minutes.')))

    if (body !== null) req.write(body)
    req.end()
  })
}

/* --------------------------------------------------------------------- schemas */

type Json = Record<string, unknown>

/**
 * The tools' own JSON Schema, handed to the SDK unchanged.
 *
 * The SDK takes a Standard Schema so it can both advertise a shape and check what
 * arrives against it, and `fromJsonSchema` is its own way in for schemas that are
 * already written. Restating Neo's arguments in zod would be a second description
 * of them that could quietly disagree with the first; this way there is one, and it
 * is the one the app validates against. Everything a schema cannot express — a date
 * that is not a date, an id from another workspace, a name matching two projects —
 * the tool itself still catches, and says so far better.
 */
const validator = new AjvJsonSchemaValidator()
const schemaFor = (parameters: Json): StandardSchemaWithJSON<Json, Json> =>
  fromJsonSchema<Json>(parameters as JsonSchemaType, validator)

/* --------------------------------------------------------------------- serving */

const text = (body: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } =>
  isError ? { content: [{ type: 'text', text: body }], isError: true } : { content: [{ type: 'text', text: body }] }

/** What came back, with the workspace named and, for a write, what it did in words. */
function report(result: BridgeResult): ReturnType<typeof text> {
  if (!result.ok) return text(result.error, true)
  const lines = [`Workspace: ${result.workspace}`]
  if (result.summary) lines.push(`Done. ${result.summary}`)
  lines.push('', JSON.stringify(result.result, null, 2))
  return text(lines.join('\n'))
}

function build(): McpServer {
  const server = new McpServer(
    { name: 'neo', version: __NEO_VERSION__, title: 'Neo' },
    { capabilities: { tools: {} } }
  )

  /**
   * The one tool that is not the app's. Everything else takes an optional workspace
   * and falls back to the one Neo is showing; this is how you find out what the
   * others are, without a screen to look at.
   */
  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'The working lives Neo is keeping: a day job, your own company, a client. Every other tool takes one of these names as its `workspace`, and uses the one Neo is currently showing if you leave it out.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const greeting = await ask<BridgeGreeting>('/')
      return text(
        JSON.stringify(
          { neoVersion: greeting.version, workspaces: greeting.workspaces },
          null,
          2
        )
      )
    }
  )

  for (const tool of __NEO_TOOLS__) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: schemaFor(tool.parameters),
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.writes,
          destructiveHint: tool.destroys,
          // Nothing here reaches past the machine: it is one local app's own database.
          openWorldHint: false
        }
      },
      async (args) =>
        report(await ask<BridgeResult>('/call', { tool: tool.name, arguments: args ?? {} }))
    )
  }

  return server
}

serveStdio(build, {
  onerror: (error) => console.error('[neo]', error.message)
})
console.error(`[neo] connector ready — ${__NEO_TOOLS__.length + 1} tools, waiting on ${endpointFile()}`)
