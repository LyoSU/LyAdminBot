/**
 * CAS signature harvester (offline batch job — runs OUTSIDE the bot process).
 *
 * Pulls the CAS banned-account export, fetches the spam texts each account was
 * banned for, and imports the qualifying ones into the v2 signature store as
 * CONFIRMED signatures (source 'cas').
 *
 * The export lists bans in the order they were added — measured 2026-09-18:
 * ids are not sorted, `time_added` rises from head to tail, about 5–8 thousand
 * a day — so the walk goes from the TAIL, newest ban first, and ends at the
 * first record that is either older than the window or already covered by a
 * previous run (`processedThrough` in `cas_harvest_state`). Until this date
 * the ids were sorted ascending and walked by id, which starts at the oldest
 * accounts in the file and never reaches the current campaigns; and the job
 * had never been run against production at all (0 signatures of source
 * 'cas', no cursor).
 *
 * The window is measured back from the newest ban IN THE FILE, not from now
 * (`recentBans`): the export is regenerated rarely, and a file whose
 * `Last-Modified` has not moved since the last run is not fetched twice.
 *
 * With `QDRANT_URL` and `OPENAI_API_KEY` set, each text also teaches the
 * vector store, so a paraphrase of a harvested advert is found as well as a
 * copy; without them, signatures only.
 *
 * Usage:
 *   MONGODB_URI=... tsx src/harvest.ts
 *   MONGODB_URI=... CAS_HARVEST_SINCE_DAYS=1 CAS_HARVEST_MAX_USERS=20000 CAS_HARVEST_DELAY_MS=150 tsx src/harvest.ts
 */
import { MongoStore, MongoSignaturePort, QdrantVectorPort } from '@lyadmin/data'
import { parseCasExport, harvestCas, recentBans } from '@lyadmin/adapters'

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
  const sinceDays = intEnv('CAS_HARVEST_SINCE_DAYS', 7)

  const store = new MongoStore()
  await store.connect(uri)
  const signatures = new MongoSignaturePort(store)
  const qdrantUrl = process.env['QDRANT_URL'] ?? null
  const openaiApiKey = process.env['OPENAI_API_KEY'] ?? null
  const vectors = qdrantUrl !== null && openaiApiKey !== null
    ? new QdrantVectorPort({ qdrantUrl, qdrantApiKey: process.env['QDRANT_API_KEY'] ?? undefined, openaiApiKey })
    : null

  // Graceful stop: finish the current user, persist the cursor, exit.
  let stop = false
  process.on('SIGINT', () => { stop = true })
  process.on('SIGTERM', () => { stop = true })

  try {
    const cursor = await store.harvestState.findOne({ key: CURSOR_KEY }) as
      { processedThrough?: string; exportModified?: string } | null
    const processedThrough = typeof cursor?.processedThrough === 'string' &&
      Number.isFinite(new Date(cursor.processedThrough).getTime())
      ? new Date(cursor.processedThrough)
      : null

    const res = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(60_000) })
    const exportModified = res.headers.get('last-modified')
    if (exportModified !== null && exportModified === cursor?.exportModified && processedThrough !== null) {
      console.log(JSON.stringify({ msg: 'cas-harvest skip', reason: 'export unchanged', exportModified }))
      return
    }
    const csv = await res.text()
    // Export order, reversed: the newest ban first.
    const newestFirst = parseCasExport(csv).reverse()
    const pending = newestFirst.slice(0, maxUsers)

    console.log(JSON.stringify({
      msg: 'cas-harvest start', totalExport: newestFirst.length, batch: pending.length, maxUsers, sinceDays,
      processedThrough: processedThrough?.toISOString() ?? null, exportModified, vectors: vectors !== null
    }))

    const stats = await harvestCas({
      ids: pending,
      learn: async (text) => {
        await signatures.learn(text, 'cas', 'confirmed')
        // Best-effort: a vector that fails to embed loses one paraphrase match,
        // not the signature already written.
        if (vectors !== null) await vectors.learn(text, 'cas', 'confirmed').catch(() => null)
      },
      delayMs,
      shouldStop: () => stop,
      until: recentBans({ sinceDays, processedThrough })
    })

    // The cursor only ever moves forward in time; a run cut short by a stop
    // signal still covered everything newer than what it reached. The file's
    // own stamp is kept beside it so an unchanged file is not walked again.
    const advanced = stats.newestTimeAdded !== null &&
      (processedThrough === null || new Date(stats.newestTimeAdded) > processedThrough)
    if (advanced || (!stop && exportModified !== null)) {
      await store.harvestState.updateOne(
        { key: CURSOR_KEY },
        {
          $set: {
            key: CURSOR_KEY,
            ...(advanced ? { processedThrough: stats.newestTimeAdded } : {}),
            ...(stop || exportModified === null ? {} : { exportModified }),
            updatedAt: new Date()
          }
        },
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
