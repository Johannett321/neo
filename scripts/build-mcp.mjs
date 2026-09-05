/**
 * Builds the MCP connector: one self-contained file that Claude Desktop can run.
 *
 * It happens in two passes, and the order is the point. The first bundles the tool
 * descriptions out of the app — with `electron` aliased to the test stub, the same
 * way `verify` runs the whole backend headlessly — and the second bakes that list
 * into the connector. So the tools the connector advertises are generated from
 * `TOOLS` by the build that ships it, and cannot be a stale second copy of them.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'out', 'mcp')

const shared = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' }
const alias = { '@shared': join(root, 'src', 'shared') }

mkdirSync(out, { recursive: true })

/* ------------------------------------------------------ what the tools look like */

await build({
  ...shared,
  entryPoints: [join(root, 'src', 'mcp', 'extract.ts')],
  outfile: join(out, 'extract.mjs'),
  alias: { ...alias, electron: join(root, 'test', 'electron-stub.mjs') },
  external: ['@electric-sql/pglite']
})

const tools = execFileSync(process.execPath, [join(out, 'extract.mjs')], {
  encoding: 'utf8',
  cwd: root
})
const parsed = JSON.parse(tools)
if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('No tools came out of the app.')

/* ------------------------------------------------------------- the connector */

await build({
  ...shared,
  entryPoints: [join(root, 'src', 'mcp', 'index.ts')],
  outfile: join(out, 'neo-mcp.mjs'),
  alias,
  // Nothing is left to resolve at run time: Claude Desktop runs this file on its own
  // built-in Node, in a folder with no node_modules beside it.
  packages: 'bundle',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __NEO_TOOLS__: JSON.stringify(parsed),
    __NEO_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    )
  }
})

writeFileSync(join(out, 'tools.json'), `${JSON.stringify(parsed, null, 2)}\n`)
console.log(`Built out/mcp/neo-mcp.mjs with ${parsed.length} tools.`)
