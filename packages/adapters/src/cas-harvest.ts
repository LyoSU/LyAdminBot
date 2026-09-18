/**
 * CAS signature harvester — imports the spam *texts* that got accounts banned
 * in CAS into the local signature store. This is the second, batch-side role
 * of CAS (the live ban lookup lives in external-ban.ts): it feeds the
 * SignaturePort, not user.externalBan.
 *
 * Pure parsing/filtering here; the heavy resumable run is driven by the
 * tools/cas-harvest entry point so it never shares the bot's hot process.
 */

/** Texts shorter than this can never decide on their own (anti-poison guard,
 * matching MongoSignaturePort's MIN_DECIDE_LENGTH), so harvesting them is waste. */
const MIN_HARVEST_LENGTH = 25

/** CAS export.csv is one banned user id per line (a header/garbage line is fine). */
export const parseCasExport = (csv: string): number[] =>
  csv
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** What one CAS `/check` answer says about a banned account. */
export interface CasRecord {
  messages: string[]
  /** When CAS added the ban; null when the field is missing or unreadable. */
  timeAdded: Date | null
}

/**
 * Pull the spam texts and the ban time out of a CAS `/check` body, degrading
 * to an empty record on garbage.
 *
 * The time is what makes a walk over the export resumable by DATE rather than
 * by id: the export lists bans in the order they were added, so the tail is
 * the recent past, and a caller walking it backwards needs each record to say
 * when it stops being recent.
 */
export const extractCasRecord = (body: unknown): CasRecord => {
  if (!isObject(body) || body.ok !== true || !isObject(body.result)) return { messages: [], timeAdded: null }
  const messages = body.result.messages
  const texts = Array.isArray(messages)
    ? messages.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : []
  const raw = body.result.time_added
  const parsed = typeof raw === 'string' ? new Date(raw) : null
  const timeAdded = parsed !== null && Number.isFinite(parsed.getTime()) ? parsed : null
  return { messages: texts, timeAdded }
}

/** Pull the spam texts out of a CAS `/check` body, degrading to [] on garbage. */
export const extractCasMessages = (body: unknown): string[] => extractCasRecord(body).messages

export const isHarvestableText = (text: string): boolean =>
  text.trim().length >= MIN_HARVEST_LENGTH

type FetchLike = (url: string) => Promise<{ json: () => Promise<unknown> }>

const CAS_CHECK_URL = (id: number): string => `https://api.cas.chat/check?user_id=${id}`

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * The stop rule for a walk over the export from its tail.
 *
 * Anchored on the export, not on the clock: the file is regenerated rarely
 * (its `Last-Modified` on 2026-09-18 read 2026-08-23), so a window measured
 * back from now would end the walk on the first record whenever the file is
 * older than the window — and harvest nothing, ever, from a stale file. The
 * newest ban time actually seen is the anchor; the window is `sinceDays`
 * behind it, and `processedThrough` — the newest time a previous run
 * reached — raises the floor so covered ground is not walked twice.
 *
 * A record with no readable time neither anchors nor ends the walk.
 */
export const recentBans = (opts: {
  sinceDays: number
  processedThrough: Date | null
}): ((record: CasRecord) => boolean) => {
  let anchor: Date | null = null
  return (record) => {
    if (record.timeAdded === null) return false
    if (anchor === null) anchor = record.timeAdded
    const windowStart = new Date(anchor.getTime() - opts.sinceDays * 86_400_000)
    const floor = opts.processedThrough !== null && opts.processedThrough > windowStart
      ? opts.processedThrough
      : windowStart
    return record.timeAdded <= floor
  }
}

export interface HarvestStats {
  usersProcessed: number
  usersWithMessages: number
  textsLearned: number
  /** Last id actually processed — persist it as a resume cursor. */
  lastProcessedId: number | null
  /**
   * The newest ban time among the records walked, ISO — the cursor for a walk
   * that goes newest-first: the next run stops where this one began.
   */
  newestTimeAdded: string | null
}

/**
 * Walk the given banned ids, fetch each user's spam texts and feed the
 * qualifying ones to `learn`. A single failed lookup never aborts the run;
 * `shouldStop` lets the caller cut a long run short and resume later.
 */
export const harvestCas = async (opts: {
  ids: number[]
  learn: (text: string) => Promise<void>
  fetchImpl?: FetchLike
  maxPerUser?: number
  delayMs?: number
  shouldStop?: () => boolean
  /**
   * Where the walk ends: true for a record the caller has no use for and
   * every record after it — older than its window, or already covered by a
   * previous run. That record is not learned. A record with no readable time
   * should not end a walk, and a caller that checks `timeAdded !== null`
   * gets exactly that.
   */
  until?: (record: CasRecord & { id: number }) => boolean
}): Promise<HarvestStats> => {
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5000) }))
  const maxPerUser = opts.maxPerUser ?? 10
  const delayMs = opts.delayMs ?? 100
  const stats: HarvestStats = {
    usersProcessed: 0, usersWithMessages: 0, textsLearned: 0, lastProcessedId: null, newestTimeAdded: null
  }
  let newest: Date | null = null

  for (const id of opts.ids) {
    if (opts.shouldStop?.()) break

    let record: CasRecord = { messages: [], timeAdded: null }
    try {
      const res = await fetchImpl(CAS_CHECK_URL(id))
      record = extractCasRecord(await res.json())
    } catch {
      // a single unreachable user must not stop the harvest
    }

    if (opts.until?.({ ...record, id }) === true) break
    if (record.timeAdded !== null && (newest === null || record.timeAdded > newest)) {
      newest = record.timeAdded
      stats.newestTimeAdded = newest.toISOString()
    }

    const harvestable = record.messages.filter(isHarvestableText).slice(0, maxPerUser)
    if (harvestable.length > 0) stats.usersWithMessages += 1
    for (const text of harvestable) {
      try {
        await opts.learn(text)
        stats.textsLearned += 1
      } catch { /* one bad write must not stop the run */ }
    }

    stats.usersProcessed += 1
    stats.lastProcessedId = id
    await sleep(delayMs)
  }

  return stats
}
