import { MongoClient } from 'mongodb'
import { readFileSync } from 'node:fs'

// URI is read from .env and never printed.
const env = readFileSync('../../.env', 'utf8')
const pick = (name) => {
  for (const line of env.split('\n')) {
    const t = line.trim()
    if (t.startsWith('#') || !t) continue
    const i = t.indexOf('=')
    if (i > 0 && t.slice(0, i).trim() === name) return t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return null
}
const uri = pick('MONGODB_URI')
if (!uri) { console.log('NO_URI'); process.exit(1) }
console.log('host_shape:', uri.replace(/\/\/[^@]*@/, '//***@').replace(/\?.*$/, ''))

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 })
try {
  await client.connect()
  const db = client.db()
  console.log('db:', db.databaseName)
  const cols = await db.listCollections().toArray()
  const rows = []
  for (const c of cols) {
    let n = -1
    try { n = await db.collection(c.name).estimatedDocumentCount() } catch { /* view */ }
    rows.push([c.name, n])
  }
  rows.sort((a, b) => b[1] - a[1])
  for (const [n, c] of rows) console.log(String(c).padStart(9), n)
} catch (e) {
  console.log('ERR:', e.constructor.name, String(e.message).slice(0, 200))
} finally {
  await client.close().catch(() => {})
}
