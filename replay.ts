import { initDb, closeDb } from './src/main/db/client'
import { initOplog, replayLog } from './src/main/db/oplog'

async function main() {
  await initDb()
  await initOplog()
  const result = await replayLog()
  console.log('Replayed', result.batches, 'batches,', result.ops, 'ops,', result.dropped, 'dropped')
  await closeDb()
}

main().catch((e) => { console.error(e); process.exit(1) })
