import { MongoClient } from 'mongodb'
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const uri = env.match(/^#\s*MONGODB_URI=([^\s"]+)/m)[1]
const c = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 })
await c.connect()
const db = c.db()
const stats = await db.stats()
console.log('=== database ===')
console.log('data', (stats.dataSize / 1048576).toFixed(1), 'MB | index',
  (stats.indexSize / 1048576).toFixed(1), 'MB | total',
  ((stats.dataSize + stats.indexSize) / 1048576).toFixed(1), 'MB of 512 MB')
console.log('\n=== per collection (data + index, MB) ===')
const rows = []
for (const { name } of await db.listCollections().toArray()) {
  try {
    const s = await db.command({ collStats: name })
    rows.push({ name, docs: s.count, data: s.size / 1048576, idx: (s.totalIndexSize ?? 0) / 1048576,
      nIdx: Object.keys(s.indexSizes ?? {}).length, avg: s.avgObjSize ?? 0 })
  } catch { /* view or restricted */ }
}
rows.sort((a, b) => (b.data + b.idx) - (a.data + a.idx))
console.log('collection'.padEnd(24), 'docs'.padStart(8), 'data'.padStart(8), 'index'.padStart(8),
  'idx#'.padStart(5), 'avgB'.padStart(6))
for (const r of rows)
  console.log(r.name.padEnd(24), String(r.docs).padStart(8), r.data.toFixed(1).padStart(8),
    r.idx.toFixed(1).padStart(8), String(r.nIdx).padStart(5), String(Math.round(r.avg)).padStart(6))
await c.close()
