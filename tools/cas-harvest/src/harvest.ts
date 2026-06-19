/**
 * CAS signature harvester (offline batch job — runs OUTSIDE the bot process).
 *
 * Pulls the CAS banned-account export, fetches the spam texts each account was
 * banned for, and imports the qualifying ones into the v2 signature store as
 * CONFIRMED signatures (source 'cas'). Resumable via a cursor in
 * `cas_harvest_state`, so repeated runs make forward progress over the (large)
 * export instead of re-scanning from the top.
 *
 * Usage:
 *   MONGODB_URI=... tsx src/harvest.ts
 *   MONGODB_URI=... CAS_HARVEST_MAX_USERS=2000 CAS_HARVEST_DELAY_MS=150 tsx src/harvest.ts
 */
import { MongoStore, MongoSignaturePort } from '@lyadmin/data'
import { parseCasExport, harvestCas } from '@lyadmin/adapters'

const CURSOR_KEY = 'cas'
const EXPORT_URL = 'https://api.cas.chat/export.csv'

const intEnv = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const main = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is required')
  const maxUsers = intEnv('CAS_HARVEST_MAX_USERS', 5000)
  const delayMs = intEnv('CAS_HARVEST_DELAY_MS', 100)

  const store = new MongoStore()
  await store.connect(uri)
  const signatures = new MongoSignaturePort(store)

  // Graceful stop: finish the current user, persist the cursor, exit.
  let stop = false
  process.on('SIGINT', () => { stop = true })
  process.on('SIGTERM', () => { stop = true })

  try {
    const res = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(60_000) })
    const csv = await res.text()
    const allIds = parseCasExport(csv).sort((a, b) => a - b)

    const cursor = await store.harvestState.findOne({ key: CURSOR_KEY })
    const lastProcessedId = Number((cursor as { lastProcessedId?: number } | null)?.lastProcessedId ?? 0)
    const pending = allIds.filter((id) => id > lastProcessedId).slice(0, maxUsers)

    console.log(JSON.stringify({
      msg: 'cas-harvest start', totalExport: allIds.length, lastProcessedId, batch: pending.length, maxUsers
    }))

    const stats = await harvestCas({
      ids: pending,
      learn: (text) => signatures.learn(text, 'cas', 'confirmed'),
      delayMs,
      shouldStop: () => stop
    })

    if (stats.lastProcessedId !== null) {
      await store.harvestState.updateOne(
        { key: CURSOR_KEY },
        { $set: { key: CURSOR_KEY, lastProcessedId: stats.lastProcessedId, updatedAt: new Date() } },
        { upsert: true }
      )
    }

    console.log(JSON.stringify({ msg: 'cas-harvest done', ...stats, stopped: stop }))
  } finally {
    await store.close().catch(() => { /* ignore */ })
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'cas-harvest failed', err: (err as Error).message }))
  process.exitCode = 1
})
