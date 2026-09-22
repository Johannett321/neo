/**
 * Connecting Claude to Neo.
 *
 * Neo Cloud hosts the MCP server itself, at one address, signed into with OAuth like
 * any other remote connector — so Claude Desktop, claude.ai and Claude Code all reach
 * the account directly, and none of them needs this app to be open. There is nothing
 * left for the desktop app to run; what is left is telling you the address, and
 * tidying up after the connector older versions put in Claude Desktop's own file.
 */

/** Where Claude connects. The same address for every Claude, and for every account. */
export const MCP_URL = 'https://sync.neomoon.io/mcp'

/** The one line that adds it to Claude Code. */
export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http neo ${MCP_URL}`

export interface ClaudeStatus {
  /** Whether Claude Desktop's support folder exists on this machine. */
  claudeInstalled: boolean
  /**
   * An older Neo wrote a `neo` entry into `claude_desktop_config.json` that ran a
   * connector inside Neo.app. That connector is gone, so the entry now only starts a
   * process that fails. True while it is there.
   */
  legacyEntry: boolean
  /** Claude Desktop's configuration file, shown so the step can be done by hand. */
  configPath: string
}
