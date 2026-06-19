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

/** Pull the spam texts out of a CAS `/check` body, degrading to [] on garbage. */
export const extractCasMessages = (body: unknown): string[] => {
  if (!isObject(body) || body.ok !== true || !isObject(body.result)) return []
  const messages = body.result.messages
  if (!Array.isArray(messages)) return []
  return messages.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
}

export const isHarvestableText = (text: string): boolean =>
  text.trim().length >= MIN_HARVEST_LENGTH

type FetchLike = (url: string) => Promise<{ json: () => Promise<unknown> }>

const CAS_CHECK_URL = (id: number): string => `https://api.cas.chat/check?user_id=${id}`

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

export interface HarvestStats {
  usersProcessed: number
  usersWithMessages: number
  textsLearned: number
  /** Last id actually processed — persist it as a resume cursor. */
  lastProcessedId: number | null
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
}): Promise<HarvestStats> => {
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5000) }))
  const maxPerUser = opts.maxPerUser ?? 10
  const delayMs = opts.delayMs ?? 100
  const stats: HarvestStats = { usersProcessed: 0, usersWithMessages: 0, textsLearned: 0, lastProcessedId: null }

  for (const id of opts.ids) {
    if (opts.shouldStop?.()) break

    let messages: string[] = []
    try {
      const res = await fetchImpl(CAS_CHECK_URL(id))
      messages = extractCasMessages(await res.json())
    } catch {
      messages = [] // a single unreachable user must not stop the harvest
    }

    const harvestable = messages.filter(isHarvestableText).slice(0, maxPerUser)
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
