/**
 * External ban databases (lols.bot + CAS) — pure parsing, TTL and guard
 * helpers. Kept free of IO so the brittle parts (third-party JSON shapes,
 * cache freshness, system-sender filtering) are testable without network.
 *
 * Reliability contract: every parser degrades to `null` on anything it does
 * not recognise — a garbage body never throws and never fabricates a ban.
 */

/** Normalised record persisted under `user.externalBan.{lols,cas}`. */
export interface ExternalBanRecord {
  banned: boolean
  spamFactor: number
  scammer: boolean
  checkedAt: Date
}

/** Re-check a cached result only after a week (see needsExternalRecheck). */
export const EXTERNAL_BAN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Telegram service / placeholder sender ids that must never be sent to a
 * third-party lookup: 777000 (Telegram service), 1087968824
 * (GroupAnonymousBot), 136817688 (Channel_Bot).
 */
const SYSTEM_SENDER_IDS = new Set([777000, 1087968824, 136817688])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const finiteNumber = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/**
 * lols.bot `/account` response: `{ ok, banned, spam_factor, scammer, ... }`.
 * `ok` means "valid response"; the ban status is the separate `banned` field,
 * so clean accounts are cached too (negative cache) to honour the TTL.
 */
export const parseLolsResponse = (body: unknown, now = new Date()): ExternalBanRecord | null => {
  if (!isObject(body) || body.ok !== true) return null
  return {
    banned: body.banned === true,
    spamFactor: finiteNumber(body.spam_factor),
    scammer: body.scammer === true,
    checkedAt: now
  }
}

/**
 * CAS `/check` response: `ok === true` IS the ban verdict (not a transport
 * flag). CAS exposes no spam factor, so banned accounts map to factor 0.
 */
export const parseCasResponse = (body: unknown, now = new Date()): ExternalBanRecord | null => {
  if (!isObject(body) || typeof body.ok !== 'boolean') return null
  return {
    banned: body.ok === true,
    spamFactor: 0,
    scammer: false,
    checkedAt: now
  }
}

/** True when a cached result is missing, unreadable, or older than the TTL. */
export const needsExternalRecheck = (
  checkedAt: Date | string | number | null | undefined,
  nowMs: number,
  ttlMs = EXTERNAL_BAN_TTL_MS
): boolean => {
  if (checkedAt === null || checkedAt === undefined) return true
  const t = new Date(checkedAt).getTime()
  if (!Number.isFinite(t)) return true
  return nowMs - t >= ttlMs
}

/** Guard: only ordinary positive user ids may be sent to a third-party API. */
export const isQueryableUserId = (id: number): boolean =>
  Number.isFinite(id) && id > 0 && !SYSTEM_SENDER_IDS.has(id)

/** Per-source lookup result; either side is null when that source failed. */
export interface ExternalBanLookup {
  lols: ExternalBanRecord | null
  cas: ExternalBanRecord | null
}

type FetchLike = (url: string) => Promise<{ json: () => Promise<unknown> }>

const LOLS_URL = (id: number): string => `https://api.lols.bot/account?id=${id}`
const CAS_URL = (id: number): string => `https://api.cas.chat/check?user_id=${id}`

const queryOne = async (
  url: string,
  fetchImpl: FetchLike,
  parse: (body: unknown, now: Date) => ExternalBanRecord | null,
  now: Date
): Promise<ExternalBanRecord | null> => {
  try {
    const res = await fetchImpl(url)
    return parse(await res.json(), now)
  } catch {
    return null // a source being down must never block the other or throw
  }
}

/**
 * Look a user up in both ban databases. Returns null only when the id is not
 * queryable (system/anonymous); otherwise an object whose sides are filled
 * independently, so one database failing never discards the other's answer.
 */
export const fetchExternalBan = async (
  userId: number,
  opts: { fetchImpl?: FetchLike; now?: Date } = {}
): Promise<ExternalBanLookup | null> => {
  if (!isQueryableUserId(userId)) return null
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }))
  const now = opts.now ?? new Date()
  const [lols, cas] = await Promise.all([
    queryOne(LOLS_URL(userId), fetchImpl, parseLolsResponse, now),
    queryOne(CAS_URL(userId), fetchImpl, parseCasResponse, now)
  ])
  return { lols, cas }
}
