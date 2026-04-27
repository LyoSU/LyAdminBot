// Weekly-digest scheduler — admin-centric flavour.
//
// Instead of per-chat "send digest for this chat to each admin", this
// scheduler groups chats BY ADMIN so each admin gets at most ONE PM per
// week even if they moderate 10 of our chats. The combined message has
// aggregate totals across all their chats plus a compact per-chat
// breakdown.
//
// Flow on each tick:
//   1. Check UTC hour window — skip silently outside 08:00-11:00 UTC so
//      we don't ping admins at 3am.
//   2. Find chats whose lastDigestSentAt is null or > 7d ago.
//   3. For each due chat, fetch admins (one getChatAdministrators call
//      per chat, paced to avoid rate limits).
//   4. Build Map<adminId, [{ group_id, title, locale }, ...]>.
//   5. For each admin:
//        - Skip if opted out (User.digestPreferences.optedOut)
//        - Skip if we PM'd them in the last 5 days (dedup — they might
//          admin multiple chats whose digests would otherwise stack)
//        - Run computeDigestStatsForChats() for ALL their due chats in
//          one query, then render combined digest
//        - Skip if aggregate.totalEvents === 0 (nothing to show)
//        - Send PM in admin's preferred locale (User.languageCode → en)
//        - Record delivery on User.digestPreferences.lastSentAt
//   6. Bump lastDigestSentAt on all due chats regardless of whether their
//      admins got anything — otherwise we'd re-query them every tick.
//
// Error handling: all per-chat/per-admin work is wrapped — any failure is
// logged, skipped, and the scheduler keeps going. A bot that drops one
// week's digest is fine; one that kills its own event loop is not.

const { computeDigestStatsForChats, renderCombinedDigest, isWorthSending } = require('./digest-stats')
const emojiMap = require('./emoji-map')
const { bot: log } = require('./logger')
const { safeInterval, safeTimeout } = require('./timers')

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_TICK_MS = 60 * 60 * 1000 // 1 hour
const ADMIN_PM_DELAY_MS = 200
const GETADMINS_DELAY_MS = 100
const RECENT_PM_DEDUP_MS = 5 * 24 * 60 * 60 * 1000

const ADMIN_STATUSES = new Set(['creator', 'administrator'])

// UTC hour window when delivery is allowed. 08:00-11:00 UTC ≈ 10:00-13:00
// Kyiv summer time — the sweet spot for admin attention without competing
// with the morning rush.
const WINDOW_START_UTC_HOUR = 8
const WINDOW_END_UTC_HOUR = 11

const runDigestPass = async ({ db, telegram, i18n, now = new Date(), skipWindowCheck = false } = {}) => {
  if (!db || !db.Group || !db.User || !db.ModLog || !i18n) {
    log.debug('digest-scheduler: db/i18n missing, skipping')
    return { dueChats: 0, adminsConsidered: 0, sent: 0, skipped: 0 }
  }

  if (!skipWindowCheck) {
    const h = now.getUTCHours()
    if (h < WINDOW_START_UTC_HOUR || h >= WINDOW_END_UTC_HOUR) {
      return { dueChats: 0, adminsConsidered: 0, sent: 0, skipped: 0, reason: 'outside_window' }
    }
  }

  const dueBefore = new Date(now.getTime() - WEEK_MS)

  let dueChats
  try {
    dueChats = await db.Group.find({
      $or: [
        { lastDigestSentAt: null },
        { lastDigestSentAt: { $lt: dueBefore } }
      ]
    }).select({ group_id: 1, title: 1, lastDigestSentAt: 1, 'settings.locale': 1 }).lean()
  } catch (err) {
    log.warn({ err: err.message }, 'digest-scheduler: fetching due chats failed')
    return { dueChats: 0, adminsConsidered: 0, sent: 0, skipped: 0 }
  }

  if (dueChats.length === 0) return { dueChats: 0, adminsConsidered: 0, sent: 0, skipped: 0 }

  const { adminToChats, chatsFetchedOk, chatsFetchedFailed } = await buildAdminToChatsMap(telegram, dueChats)

  const stat = {
    dueChats: dueChats.length,
    adminsConsidered: adminToChats.size,
    chatsFetchedOk: chatsFetchedOk.size,
    chatsFetchedFailed: chatsFetchedFailed.size,
    sent: 0,
    skipped: 0
  }

  // Guard against Telegram-wide outages: if ≥50% of getChatAdministrators
  // calls failed, this is likely a transient API issue and we should NOT
  // bump lastDigestSentAt — otherwise we'd silently skip digests for a
  // whole week because the API hiccupped for 10 minutes.
  const totalFetches = chatsFetchedOk.size + chatsFetchedFailed.size
  const outageLikely = totalFetches >= 4 && (chatsFetchedFailed.size / totalFetches) > 0.5
  if (outageLikely) {
    log.warn(stat, 'digest-scheduler: likely Telegram outage — skipping lastDigestSentAt bump')
  }

  for (const [adminId, chats] of adminToChats) {
    try {
      const delivered = await processAdmin({ db, telegram, i18n, adminId, chats, now })
      if (delivered) stat.sent += 1
      else stat.skipped += 1
    } catch (err) {
      log.warn({ err: err.message, adminId }, 'digest-scheduler: admin processing failed')
      stat.skipped += 1
    }
    await sleep(ADMIN_PM_DELAY_MS)
  }

  // Bump lastDigestSentAt ONLY for chats we successfully fetched admins
  // for. Failed-fetch chats stay due so the next tick retries — at weekly
  // cadence this is fine; on Telegram-wide outage (detected above) we skip
  // the whole bump so nobody's week gets silently dropped.
  if (!outageLikely && chatsFetchedOk.size > 0) {
    try {
      await db.Group.updateMany(
        { group_id: { $in: [...chatsFetchedOk] } },
        { $set: { lastDigestSentAt: now } }
      )
    } catch (err) {
      log.warn({ err: err.message }, 'digest-scheduler: bumping lastDigestSentAt failed')
    }
  }

  log.info(stat, 'digest-scheduler: tick done')
  return stat
}

/**
 * For each due chat, call getChatAdministrators. Accumulate per admin.
 * Bots are excluded — same rationale as chat-member.js external-mod
 * detection (their decisions are not independent admin judgement).
 */
const buildAdminToChatsMap = async (telegram, dueChats) => {
  const adminToChats = new Map()
  // Track which chats we actually reached vs which Telegram rejected — the
  // scheduler uses this to decide which chats get their lastDigestSentAt
  // bumped, so a 403/chat-not-found doesn't burn a week's worth of digest.
  const chatsFetchedOk = new Set()
  const chatsFetchedFailed = new Set()

  for (const chat of dueChats) {
    let admins
    try {
      admins = await telegram.getChatAdministrators(chat.group_id)
      chatsFetchedOk.add(chat.group_id)
    } catch (err) {
      log.debug({ err: err.message, chatId: chat.group_id }, 'digest-scheduler: getChatAdministrators failed')
      chatsFetchedFailed.add(chat.group_id)
      continue
    }
    for (const a of admins || []) {
      if (!a || !a.user || a.user.is_bot) continue
      if (!ADMIN_STATUSES.has(a.status)) continue
      const list = adminToChats.get(a.user.id) || []
      list.push({ group_id: chat.group_id, title: chat.title || '', locale: (chat.settings && chat.settings.locale) || null })
      adminToChats.set(a.user.id, list)
    }
    await sleep(GETADMINS_DELAY_MS)
  }

  return { adminToChats, chatsFetchedOk, chatsFetchedFailed }
}

const processAdmin = async ({ db, telegram, i18n, adminId, chats, now }) => {
  const gate = await shouldSendToUser(db, adminId, now)
  if (!gate) return false

  const chatIds = chats.map((c) => c.group_id)
  const since = new Date(now.getTime() - WEEK_MS)
  const { aggregate, perChat } = await computeDigestStatsForChats(db, chatIds, { since, now })

  if (!isWorthSending(aggregate)) return false

  const locale = await resolveAdminLocale(db, adminId, chats)
  const i18nAdmin = i18n.createContext(locale, {})

  const text = renderCombinedDigest(
    { aggregate, perChat, chats },
    { e: emojiMap, i18n: i18nAdmin }
  )

  const ok = await sendPM(telegram, adminId, text)
  if (ok) await recordDelivery(db, adminId, now)
  return ok
}

/**
 * Prefer the admin's own Telegram UI language (User.languageCode). If we
 * haven't seen them chat anywhere, fall back to the first non-empty chat
 * locale, then 'en'. Digest goes to a DM so chat-locale is a poor fit, but
 * it beats defaulting everyone to English.
 */
const resolveAdminLocale = async (db, adminId, chats) => {
  try {
    const user = await db.User.findOne({ telegram_id: adminId })
      .select({ languageCode: 1 }).lean()
    if (user && user.languageCode) return user.languageCode
  } catch (_err) { /* ignore */ }
  const chatLocale = (chats.find((c) => c.locale) || {}).locale
  return chatLocale || 'en'
}

const shouldSendToUser = async (db, userId, now) => {
  try {
    const user = await db.User.findOne({ telegram_id: userId })
      .select({ digestPreferences: 1 }).lean()
    if (!user) return true // Not in DB yet; default to send (first touch).
    const prefs = user.digestPreferences || {}
    if (prefs.optedOut) return false
    if (prefs.lastSentAt && (now - new Date(prefs.lastSentAt)) < RECENT_PM_DEDUP_MS) {
      return false
    }
    return true
  } catch (err) {
    log.debug({ err: err.message, userId }, 'digest-scheduler: shouldSendToUser failed')
    return true
  }
}

const recordDelivery = async (db, userId, now) => {
  try {
    // Upsert so brand-new admins (User doc never created because they're
    // admin-only and haven't sent a message we indexed) still get their
    // lastSentAt persisted. Without upsert, those users would loop getting
    // re-PM'd every tick because the dedup check reads an empty doc.
    await db.User.updateOne(
      { telegram_id: userId },
      { $set: { 'digestPreferences.lastSentAt': now } },
      { upsert: true }
    )
  } catch (err) {
    log.debug({ err: err.message, userId }, 'digest-scheduler: recordDelivery failed')
  }
}

const sendPM = async (telegram, userId, htmlText) => {
  try {
    await telegram.callApi('sendMessage', {
      chat_id: userId,
      text: htmlText,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true
    })
    return true
  } catch (err) {
    // 403 = admin never started DM with bot. 400 = bad chat id (never
    // existed). Both are "permanent for this user" — log at debug.
    // Everything else (429, 5xx, network) is transient and worth a warn
    // so ops can see scheduler health at a glance.
    const code = err && (err.code || (err.response && err.response.error_code))
    if (code === 403 || code === 400) {
      log.debug({ userId, code, msg: err.message }, 'digest-scheduler: sendPM permanent error')
    } else {
      log.warn({ userId, code, msg: err.message }, 'digest-scheduler: sendPM transient error')
    }
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start the periodic tick. Returns the interval handle so tests/callers
 * can clear it. First tick fires after `tickMs` — no immediate run on boot.
 */
const startDigestScheduler = ({ db, telegram, i18n, tickMs = DEFAULT_TICK_MS } = {}) => {
  if (!db || !telegram || !i18n) return null
  // Jitter the first tick by up to 0.5× tickMs. Without this, every fleet
  // deploy at the same time would storm Telegram at boot + 1h on the dot.
  const jitter = Math.floor(Math.random() * tickMs * 0.5)
  let interval = null
  const firstTimeout = safeTimeout(() => {
    runDigestPass({ db, telegram, i18n }).catch((err) => {
      log.warn({ err }, 'digest-scheduler: first-tick rejected')
    })
    interval = safeInterval(
      () => runDigestPass({ db, telegram, i18n }),
      tickMs,
      { log, label: 'digest-scheduler' }
    )
  }, tickMs + jitter, { log, label: 'digest-scheduler-first-tick' })
  return {
    stop: () => {
      if (firstTimeout) clearTimeout(firstTimeout)
      if (interval) clearInterval(interval)
    }
  }
}

module.exports = {
  startDigestScheduler,
  runDigestPass,
  shouldSendToUser,
  buildAdminToChatsMap,
  WINDOW_START_UTC_HOUR,
  WINDOW_END_UTC_HOUR
}
