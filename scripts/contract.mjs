#!/usr/bin/env node
/**
 * The desktop app's half of the contract with Neo Cloud.
 *
 * Neo Cloud is the source of truth and publishes its OpenAPI spec at
 * `/openapi/neo-cloud.yaml`. This generates `src/main/lib/cloud/schema.ts` from it — the
 * types `api` sends with and `must()` returns — so a handler that disagrees with the API
 * does not compile.
 *
 *   node scripts/contract.mjs           regenerate schema.ts
 *   node scripts/contract.mjs --check   fail if the committed schema.ts is not what the spec generates
 *
 * `NEO_CLOUD_SPEC` points at another spec: a local server's, or a file in a server
 * checkout, for working against an API that is not deployed yet.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const spec = process.env.NEO_CLOUD_SPEC || 'https://sync.neomoon.io/openapi/neo-cloud.yaml'
const target = join(root, 'src/main/lib/cloud/schema.ts')
const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'openapi-typescript.cmd' : 'openapi-typescript')
const generate = (out) => execFileSync(bin, [spec, '-o', out], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })

if (!process.argv.includes('--check')) {
  generate(target)
  console.log(`schema.ts generated from ${spec}`)
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'neo-contract-'))
  try {
    const fresh = join(scratch, 'schema.ts')
    generate(fresh)
    if (readFileSync(fresh, 'utf8') !== readFileSync(target, 'utf8')) {
      console.error(`src/main/lib/cloud/schema.ts does not match ${spec}.\nRun \`npm run gen:api\`, then fix whatever no longer type-checks.`)
      process.exit(1)
    }
    console.log(`schema.ts matches ${spec}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
