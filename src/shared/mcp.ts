/**
 * The contract between Neo and the MCP server that Claude Desktop runs.
 *
 * Claude Desktop starts an MCP server as a long-lived child process of its own and
 * keeps it alive for as long as it is open. That process must never open the
 * database: PGlite is in-process and has no lock, so a second reader would take the
 * `.lock` in the data folder and Neo itself would refuse to start — which is exactly
 * the damage the lock exists to prevent.
 *
 * So the MCP server holds nothing. It is a proxy: it speaks MCP on stdin and stdout,
 * and forwards every call over a local socket to the running app, which answers it
 * with the same `TOOLS` the in-app assistant uses, on the same channels, in the one
 * process that owns the database. When Neo is closed there is no socket to talk to
 * and the tools say so, rather than opening the folder behind its back.
 */

/** Bumped when the shape below changes, so a stale bundle says so instead of guessing. */
export const BRIDGE_PROTOCOL = 1

/**
 * Written to `<userData>/mcp.json` when the bridge starts and removed when it stops.
 * Its presence is what tells the MCP server that Neo is open, and where to knock.
 */
export interface BridgeEndpoint {
  protocol: number
  /** A Unix domain socket path, or a named pipe on Windows. Never a TCP port. */
  endpoint: string
  /**
   * Sent back on every request. The socket is already limited to this account by
   * its permissions; the token is what stops anything else on the machine that can
   * reach the socket from driving the app without having read the file first.
   */
  token: string
  /** The pid that owns it, so a file left behind by a crash can be recognised. */
  pid: number
}

/** One of the app's tools, as the MCP server advertises it. */
export interface BridgeTool {
  name: string
  /** The name in words, for the client's own list. */
  title: string
  description: string
  /** JSON Schema, verbatim from the tool, plus the `workspace` argument. */
  parameters: Record<string, unknown>
  /** Reads are marked read-only to the client; writes are not. */
  writes: boolean
  /** Removes something outright, so the client can warn before it runs. */
  destroys: boolean
}

export interface BridgeCall {
  tool: string
  arguments: Record<string, unknown>
}

export type BridgeResult =
  | {
      ok: true
      /** Which working life this answer came from, named in every reply so it is never implied. */
      workspace: string
      /** For a write, what it did in plain words, ids resolved to names. Null for a read. */
      summary: string | null
      result: unknown
    }
  | { ok: false; error: string }

export interface BridgeGreeting {
  app: 'neo'
  protocol: number
  version: string
  pid: number
  workspaces: { id: string; name: string; active: boolean }[]
}

/* ------------------------------------------------ setting Claude Desktop up */

/**
 * What the settings pane needs to tell you where you stand, and one button's worth
 * of what it would do. Claude Desktop keeps its servers in a JSON file of its own;
 * connecting means adding one entry to it, and this is that entry, resolved against
 * this copy of the app rather than described in the abstract.
 */
export interface McpEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpStatus {
  /** The bridge is listening, which it is whenever the app is open. */
  bridge: boolean
  /** Claude Desktop is installed on this machine. Nothing can be set up until it is. */
  claudeInstalled: boolean
  /** Claude Desktop's configuration already names Neo, and names *this* copy of it. */
  connected: boolean
  /** It names Neo, but a different copy — the app moved, or a second one is installed. */
  stale: boolean
  /** Claude Desktop's own configuration file, shown so it can be found by hand. */
  configPath: string
  /** The connector Claude Desktop would run. Empty when this build did not produce one. */
  connectorPath: string
  entry: McpEntry
}
