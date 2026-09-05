/**
 * Packs the connector into `dist/neo.mcpb` — the file Claude Desktop installs when
 * you drop it on its extensions pane.
 *
 * An .mcpb is a zip holding a manifest and the server, so the zip is written here
 * rather than shelled out to, for the same reason the icons are drawn rather than
 * fetched: there is nothing to install, and it behaves the same on every machine.
 * Stored and deflated entries are all the format needs, and both are a header away.
 */
import { crc32, deflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tools = JSON.parse(readFileSync(join(root, 'out', 'mcp', 'tools.json'), 'utf8'))
const server = readFileSync(join(root, 'out', 'mcp', 'neo-mcp.mjs'))

/* -------------------------------------------------------------------- manifest */

const manifest = {
  manifest_version: '0.3',
  name: 'neo',
  display_name: 'Neo',
  version: pkg.version,
  description: 'Your projects, meetings, decisions and people in Neo — read and written in place.',
  long_description:
    'Neo is a personal command centre for running several working lives at once. This ' +
    'connector lets Claude read what is in it and change it: the boards, the notes, the ' +
    'meetings and what they left owing, the decisions, the people and how to work with ' +
    'them. Everything happens through the app itself, so Neo must be open — nothing here ' +
    'touches the database directly, and every change is logged and mirrored to Markdown ' +
    'exactly as one made by hand.',
  author: { name: pkg.author },
  homepage: pkg.homepage,
  repository: { type: 'git', url: pkg.repository.url },
  license: pkg.license,
  icon: 'icon.png',
  keywords: ['projects', 'meetings', 'notes', 'local-first'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] }
  },
  tools_generated: false,
  tools: [
    { name: 'list_workspaces', description: 'The working lives Neo is keeping.' },
    ...tools.map((t) => ({ name: t.name, description: t.description }))
  ],
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=20.0.0' }
  }
}

/* ------------------------------------------------------------------------- zip */

const entries = [
  ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ['server/index.js', server],
  // The 512 the iconset already draws at that size, which is what Claude Desktop wants.
  ['icon.png', readFileSync(join(root, 'build', 'icon.iconset', 'icon_512x512.png'))]
]

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

const local = []
const central = []
let offset = 0

for (const [name, raw] of entries) {
  const filename = Buffer.from(name, 'utf8')
  const packed = deflateRawSync(raw, { level: 9 })
  // Deflating is only worth it when it actually made the entry smaller.
  const deflated = packed.length < raw.length
  const body = deflated ? packed : raw
  const sum = crc32(raw)

  // Fixed 1980-01-01, so the same input always packs to the same bytes.
  const header = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(deflated ? 8 : 0), u16(0), u16(33),
    u32(sum), u32(body.length), u32(raw.length), u16(filename.length), u16(0)
  ])
  local.push(header, filename, body)

  central.push(
    Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(deflated ? 8 : 0), u16(0), u16(33),
      u32(sum), u32(body.length), u32(raw.length), u16(filename.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), filename
    ])
  )
  offset += header.length + filename.length + body.length
}

const directory = Buffer.concat(central)
const zip = Buffer.concat([
  ...local,
  directory,
  Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0)
  ])
])

mkdirSync(join(root, 'dist'), { recursive: true })
const target = join(root, 'dist', 'neo.mcpb')
writeFileSync(target, zip)
console.log(`Packed ${target} — ${manifest.tools.length} tools, ${(zip.length / 1024).toFixed(0)} kB.`)
console.log('Install it by dropping it on Claude Desktop → Settings → Extensions.')
