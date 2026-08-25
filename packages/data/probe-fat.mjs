import { MongoClient } from 'mongodb'
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const uri = env.match(/^#\s*MONGODB_URI=([^\s"]+)/m)[1]
const c = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 })
await c.connect()
const db = c.db()
const bson = (v) => Buffer.byteLength(JSON.stringify(v ?? null))

for (const [coll, n] of [['users', 3000], ['groupmembers', 3000]]) {
  const sample = await db.collection(coll).aggregate([{ $sample: { size: n } }]).toArray()
  const cost = new Map()
  for (const d of sample) {
    for (const [k, v] of Object.entries(d)) {
      if (k === '_id') continue
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        for (const [k2, v2] of Object.entries(v)) {
          const key = `${k}.${k2}`
          cost.set(key, (cost.get(key) ?? 0) + bson(v2))
        }
      } else {
        cost.set(k, (cost.get(k) ?? 0) + bson(v))
      }
    }
  }
  const total = [...cost.values()].reduce((a, b) => a + b, 0)
  console.log(`\n=== ${coll}: where the bytes go (sample ${sample.length}) ===`)
  console.log('field'.padEnd(40), 'bytes/doc'.padStart(10), 'share'.padStart(7))
  for (const [k, v] of [...cost].sort((a, b) => b[1] - a[1]).slice(0, 16))
    console.log(k.padEnd(40), (v / sample.length).toFixed(0).padStart(10),
      (v / total * 100).toFixed(1).padStart(6) + '%')
  console.log('total per doc (json):', (total / sample.length).toFixed(0), 'bytes')
}
await c.close()
