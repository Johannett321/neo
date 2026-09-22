import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudeStatus } from '@shared/claude'
import { handle } from './util'

/**
 * Connecting Claude, from the desktop app's side — which is now almost nothing.
 *
 * Claude reaches Neo through the MCP server Neo Cloud hosts (`MCP_URL` in
 * `shared/claude.ts`), signed into with OAuth in the browser, so there is no connector
 * for this app to install and nothing for it to run. The settings pane shows the address
 * and the steps. What is left here is clearing up after older versions, which wrote a
 * `neo` entry into Claude Desktop's own `claude_desktop_config.json` that ran a local
 * connector inside Neo.app. That connector no longer exists, so the entry now starts a
 * process that fails on every launch of Claude Desktop.
 *
 * The file is Claude Desktop's, not ours. Removing the entry touches nothing else in
 * it, and a file that does not parse is refused rather than rewritten.
 */

/** Where Claude Desktop keeps the servers it runs. */
function configPath(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json')
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Read Claude Desktop's configuration without ever destroying it. A file we cannot
 * parse is a file someone edited by hand, and overwriting it to remove our own entry
 * would be taking their work away to save them a click.
 */
function readConfig(): ClaudeConfig | null {
  const path = configPath()
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as ClaudeConfig
  } catch {
    throw new Error(
      `Claude Desktop's configuration at ${path} is not valid JSON, so Neo has not touched it. ` +
        'Fix that file, or remove the "neo" entry from it by hand.'
    )
  }
}

/**
 * The old entry ran a program (`command`); a remote connector added by hand is a `url`.
 * Only the first is ours to remove — a `neo` entry pointing at Neo Cloud is the new way
 * in, and must be left alone.
 */
function isLegacy(entry: unknown): boolean {
  return Boolean(entry) && typeof entry === 'object' && typeof (entry as { command?: unknown }).command === 'string'
}

function status(): ClaudeStatus {
  let legacyEntry = false
  try {
    legacyEntry = isLegacy(readConfig()?.mcpServers?.neo)
  } catch {
    // An unreadable file is reported when you try to change it, not on every poll.
  }
  return {
    claudeInstalled: existsSync(dirname(configPath())),
    legacyEntry,
    configPath: configPath()
  }
}

export function registerClaudeHandlers(): void {
  handle('claude:status', () => status())

  handle('claude:removeLegacy', () => {
    const config = readConfig()
    // Nothing to remove means nothing written: the file is left byte for byte as it was.
    if (!config?.mcpServers || !isLegacy(config.mcpServers.neo)) return status()
    const { neo: _removed, ...rest } = config.mcpServers
    config.mcpServers = rest
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`)
    return status()
  })
}
