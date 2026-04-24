// Weekly-digest stats: compute + render.
//
// Pure module — no telegram side effects. Two entry points:
//   computeDigestStats(db, chatId, { since, now }) → structured stats
//   renderDigest(stats, { chatTitle, e, i18n })    → HTML string
//
// i18n is required for render — all user-visible text comes from locale
// files (see digest.* in locales/*.yaml). Callers pass either ctx.i18n
// (command path) or i18n.createContext(locale, {}) (scheduler path).

const { bot: log } = require('./logger')

// Events we aggregate. Keep this in sync with modLog.EVENT_TYPES.
const AUTO_EVENTS = ['auto_ban', 'auto_mute', 'auto_del']
const MANUAL_EVENTS = ['manual_ban', 'manual_mute', 'manual_kick', 'manual_del']
const EXTERNAL_EVENTS = ['external_ban', 'external_restrict', 'external_unban', 'external_unrestrict']

/**
 * Aggregate last-week stats for one chat. Returns a plain object — no db
 * references, safe to pass around/serialize.
 */
const computeDigestStats = async (db, chatId, { since, now = new Date() } = {}) => {
  if (!db || !db.ModLog || !chatId || !(since instanceof Date)) {
    return null
  }

  const base = { chatId, since, until: now }
  const empty = {
    ...base,
    autoBans: 0,
    autoMutes: 0,
    autoDeletes: 0,
    manualBans: 0,
    manualMutes: 0,
    manualKicks: 0,
    manualDeletes: 0,
    overrides: 0,
    votesResolved: 0,
    captchaPassed: 0,
    captchaFailed: 0,
    externalBans: 0,
    externalRestricts: 0,
    externalUnbans: 0,
    externalUnrestricts: 0,
    distinctExternalAdmins: 0,
    totalBotActions: 0,
    totalAdminActions: 0,
    totalEvents: 0
  }

  let rows
  try {
    rows = await db.ModLog.find(
      { chatId, timestamp: { $gte: since, $lte: now } },
      { eventType: 1, actorId: 1, _id: 0 }
    ).lean()
  } catch (err) {
    log.debug({ err: err.message, chatId }, 'digest: modlog query failed')
    return empty
  }

  const stats = { ...empty }
  const externalAdmins = new Set()

  for (const row of rows) applyRowToStats(stats, row, externalAdmins)

  stats.distinctExternalAdmins = externalAdmins.size
  stats.totalBotActions = AUTO_EVENTS.reduce((n, k) => n + stats[kebabToCamel(k)], 0)
  stats.totalAdminActions = MANUAL_EVENTS.reduce((n, k) => n + stats[kebabToCamel(k)], 0)

  return stats
}

// auto_ban → autoBans, manual_del → manualDeletes (special-case)
function kebabToCamel (t) {
  if (t === 'auto_del') return 'autoDeletes'
  if (t === 'manual_del') return 'manualDeletes'
  if (t === 'manual_kick') return 'manualKicks'
  const [a, b] = t.split('_')
  return a + b.charAt(0).toUpperCase() + b.slice(1) + 's'
}

/**
 * Slavic-style plural form picker. `n % 100` in [11, 14] is always 'many'.
 * Returns one of three i18n keys for the given noun family.
 *
 *   pluralKey(2, 'digest.plural.admins') → 'digest.plural.admins_few'
 */
const pluralKey = (n, baseKey) => {
  const abs = Math.abs(n) % 100
  const lastDigit = abs % 10
  if (abs >= 11 && abs <= 14) return `${baseKey}_many`
  if (lastDigit === 1) return `${baseKey}_one`
  if (lastDigit >= 2 && lastDigit <= 4) return `${baseKey}_few`
  return `${baseKey}_many`
}

const pluralText = (i18n, n, baseKey) => i18n.t(pluralKey(n, baseKey))

/**
 * Pick the single most interesting line to surface above the numeric table.
 * Returns either a localized string (HTML) or null if nothing stands out.
 *
 * Ordering reflects user-perceived novelty, not magnitude. Network-rep hits
 * rank first because they're the newest signal and most conversation-worthy.
 */
const pickFeature = (stats, i18n, e) => {
  if (stats.externalBans > 0 && stats.distinctExternalAdmins > 0) {
    return i18n.t('digest.feature.external_ban', {
      eyes: e.eyes || '👀',
      bans: stats.externalBans,
      chatsWord: pluralText(i18n, stats.externalBans, 'digest.plural.chats'),
      admins: stats.distinctExternalAdmins,
      adminsWord: pluralText(i18n, stats.distinctExternalAdmins, 'digest.plural.admins')
    })
  }
  const hotWeekTotal = stats.autoBans + stats.autoDeletes + stats.autoMutes
  if (hotWeekTotal >= 20) {
    return i18n.t('digest.feature.hot_week', {
      fire: e.fire || '🔥',
      n: hotWeekTotal
    })
  }
  if (stats.captchaFailed > 0 && stats.captchaPassed > 0) {
    const passRate = Math.round((stats.captchaPassed / (stats.captchaPassed + stats.captchaFailed)) * 100)
    return i18n.t('digest.feature.captcha_pass_rate', {
      check: e.check || '✅',
      passRate
    })
  }
  if (stats.votesResolved > 0 && stats.overrides === 0) {
    return i18n.t('digest.feature.votes_confirmed', {
      target: e.target || '🎯',
      n: stats.votesResolved,
      decisionsWord: pluralText(i18n, stats.votesResolved, 'digest.plural.decisions')
    })
  }
  if (stats.overrides > 0) {
    return i18n.t('digest.feature.overrides', {
      warn: e.warn || '⚠️',
      n: stats.overrides
    })
  }
  return null
}

/**
 * Render a digest into a Telegram-ready HTML string. All visible text comes
 * from locale keys — the caller decides the locale by passing either
 * ctx.i18n (command path) or i18n.createContext(locale, {}) (scheduler path).
 */
const renderDigest = (stats, { chatTitle = '', e = {}, i18n } = {}) => {
  if (!stats || !i18n) return ''

  const lines = []
  lines.push(i18n.t('digest.title', {
    chart: e.chart || '📊',
    chatTitle: escapeHtml(chatTitle)
  }))
  lines.push(i18n.t('digest.period', {
    from: formatDate(stats.since),
    to: formatDate(stats.until)
  }))
  lines.push('')

  const feature = pickFeature(stats, i18n, e)
  if (feature) {
    lines.push(feature)
    lines.push('')
  }

  // Core numeric table — render each row only if non-zero so we don't
  // bore admins with zeroes.
  const rows = []
  if (stats.autoDeletes > 0) {
    rows.push(i18n.t('digest.row.auto_del', { trash: e.trash || '🗑', n: stats.autoDeletes }))
  }
  if (stats.autoBans > 0) {
    rows.push(i18n.t('digest.row.auto_ban', { ban: e.ban || '🚫', n: stats.autoBans }))
  }
  if (stats.autoMutes > 0) {
    rows.push(i18n.t('digest.row.auto_mute', { lock: e.lock || '🔒', n: stats.autoMutes }))
  }
  if (stats.totalAdminActions > 0) {
    rows.push(i18n.t('digest.row.admin_actions', { crown: e.crown || '👑', n: stats.totalAdminActions }))
  }
  if (stats.captchaPassed + stats.captchaFailed > 0) {
    rows.push(i18n.t('digest.row.captcha', {
      check: e.check || '✅',
      passed: stats.captchaPassed,
      failed: stats.captchaFailed
    }))
  }
  if (stats.votesResolved > 0) {
    rows.push(i18n.t('digest.row.votes', { target: e.target || '🎯', n: stats.votesResolved }))
  }
  if (stats.externalBans > 0) {
    rows.push(i18n.t('digest.row.external', {
      eyes: e.eyes || '👀',
      n: stats.externalBans,
      admins: stats.distinctExternalAdmins,
      adminsWord: pluralText(i18n, stats.distinctExternalAdmins, 'digest.plural.admins')
    }))
  }

  if (rows.length === 0) {
    lines.push(i18n.t('digest.empty', { shield: e.shield || '🛡' }))
  } else {
    for (const r of rows) lines.push(r)
  }

  lines.push('')
  lines.push(i18n.t('digest.footer', { shield: e.shield || '🛡' }))

  return lines.join('\n')
}

function formatDate (d) {
  const date = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}`
}

function escapeHtml (s) {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Whether a digest is worth sending. Scheduler uses this to skip empty
 * weeks instead of spamming admins with "nothing happened".
 */
const isWorthSending = (stats) => {
  if (!stats) return false
  return stats.totalEvents > 0
}

/**
 * Batched version: aggregate stats across many chats in one ModLog query.
 * Used by the scheduler to build a COMBINED digest for an admin who moderates
 * multiple chats of ours — one PM instead of N.
 *
 * Returns `{ aggregate, perChat }`:
 *   aggregate  — same shape as computeDigestStats(), summed across chats.
 *                `chatId` is null and `distinctExternalAdmins` is the
 *                dedup'd count across ALL chats (not the sum of per-chat
 *                counts, which would overcount admins that act in ≥2 chats).
 *   perChat    — { [chatId]: stats } map for per-chat sections in the render.
 */
const computeDigestStatsForChats = async (db, chatIds, { since, now = new Date() } = {}) => {
  if (!db || !db.ModLog || !Array.isArray(chatIds) || chatIds.length === 0 || !(since instanceof Date)) {
    return { aggregate: null, perChat: {} }
  }

  const makeEmpty = (chatId) => ({
    chatId,
    since,
    until: now,
    autoBans: 0,
    autoMutes: 0,
    autoDeletes: 0,
    manualBans: 0,
    manualMutes: 0,
    manualKicks: 0,
    manualDeletes: 0,
    overrides: 0,
    votesResolved: 0,
    captchaPassed: 0,
    captchaFailed: 0,
    externalBans: 0,
    externalRestricts: 0,
    externalUnbans: 0,
    externalUnrestricts: 0,
    distinctExternalAdmins: 0,
    totalBotActions: 0,
    totalAdminActions: 0,
    totalEvents: 0
  })

  const perChat = {}
  for (const id of chatIds) perChat[id] = makeEmpty(id)
  const aggregate = makeEmpty(null)

  const perChatExternalAdmins = {}
  for (const id of chatIds) perChatExternalAdmins[id] = new Set()
  const aggregateExternalAdmins = new Set()

  let rows
  try {
    rows = await db.ModLog.find(
      { chatId: { $in: chatIds }, timestamp: { $gte: since, $lte: now } },
      { chatId: 1, eventType: 1, actorId: 1, _id: 0 }
    ).lean()
  } catch (err) {
    log.debug({ err: err.message, chatIds }, 'digest: batched modlog query failed')
    return { aggregate, perChat }
  }

  for (const row of rows) {
    const stats = perChat[row.chatId]
    if (!stats) continue
    applyRowToStats(stats, row, perChatExternalAdmins[row.chatId])
    applyRowToStats(aggregate, row, aggregateExternalAdmins)
  }

  for (const id of chatIds) {
    perChat[id].distinctExternalAdmins = perChatExternalAdmins[id].size
    perChat[id].totalBotActions = AUTO_EVENTS.reduce((n, k) => n + perChat[id][kebabToCamel(k)], 0)
    perChat[id].totalAdminActions = MANUAL_EVENTS.reduce((n, k) => n + perChat[id][kebabToCamel(k)], 0)
  }
  aggregate.distinctExternalAdmins = aggregateExternalAdmins.size
  aggregate.totalBotActions = AUTO_EVENTS.reduce((n, k) => n + aggregate[kebabToCamel(k)], 0)
  aggregate.totalAdminActions = MANUAL_EVENTS.reduce((n, k) => n + aggregate[kebabToCamel(k)], 0)

  return { aggregate, perChat }
}

// Single-row accumulator used by both single-chat and batched flows so the
// two paths produce identical event-type semantics by construction.
function applyRowToStats (stats, row, externalSet) {
  const t = row.eventType
  stats.totalEvents += 1
  if (t === 'auto_ban') stats.autoBans += 1
  else if (t === 'auto_mute') stats.autoMutes += 1
  else if (t === 'auto_del') stats.autoDeletes += 1
  else if (t === 'manual_ban') stats.manualBans += 1
  else if (t === 'manual_mute') stats.manualMutes += 1
  else if (t === 'manual_kick') stats.manualKicks += 1
  else if (t === 'manual_del') stats.manualDeletes += 1
  else if (t === 'override') stats.overrides += 1
  else if (t === 'vote_resolved') stats.votesResolved += 1
  else if (t === 'captcha_passed') stats.captchaPassed += 1
  else if (t === 'captcha_failed') stats.captchaFailed += 1
  else if (t === 'external_ban') {
    stats.externalBans += 1
    if (externalSet && row.actorId) externalSet.add(row.actorId)
  } else if (t === 'external_restrict') stats.externalRestricts += 1
  else if (t === 'external_unban') stats.externalUnbans += 1
  else if (t === 'external_unrestrict') stats.externalUnrestricts += 1
}

/**
 * Render a COMBINED digest spanning multiple chats into one HTML message.
 *
 *   aggregate  — from computeDigestStatsForChats(), null/treated-as-empty if
 *                nothing happened.
 *   perChat    — { [chatId]: stats } map.
 *   chats      — [{ group_id, title }, ...] ordering list (drives display
 *                order; chats omitted here are not rendered even if they
 *                have stats).
 *
 * Falls back to renderDigest() when there's exactly one chat — the combined
 * framing becomes noise when there's nothing to combine.
 */
const renderCombinedDigest = ({ aggregate, perChat, chats }, { e = {}, i18n } = {}) => {
  if (!aggregate || !i18n || !Array.isArray(chats) || chats.length === 0) return ''
  if (chats.length === 1) {
    const only = chats[0]
    return renderDigest(perChat[only.group_id], {
      chatTitle: only.title || '',
      e,
      i18n
    })
  }

  // Only include chats that had at least one event — a combined digest with
  // half-empty per-chat blocks reads sloppy. Aggregate stats still reflect
  // the full set (already computed).
  const interestingChats = chats.filter((c) => {
    const s = perChat[c.group_id]
    return s && s.totalEvents > 0
  })

  const lines = []
  lines.push(i18n.t('digest.combined.title', {
    chart: e.chart || '📊',
    n: chats.length,
    chatsWord: pluralText(i18n, chats.length, 'digest.plural.chats')
  }))
  lines.push(i18n.t('digest.period', {
    from: formatDate(aggregate.since),
    to: formatDate(aggregate.until)
  }))
  lines.push('')

  // Aggregate feature + totals block.
  const feature = pickFeature(aggregate, i18n, e)
  if (feature) {
    lines.push(feature)
    lines.push('')
  }

  lines.push(i18n.t('digest.combined.totals_header'))
  if (aggregate.autoDeletes > 0) {
    lines.push(i18n.t('digest.row.auto_del', { trash: e.trash || '🗑', n: aggregate.autoDeletes }))
  }
  if (aggregate.autoBans > 0) {
    lines.push(i18n.t('digest.row.auto_ban', { ban: e.ban || '🚫', n: aggregate.autoBans }))
  }
  if (aggregate.totalAdminActions > 0) {
    lines.push(i18n.t('digest.row.admin_actions', { crown: e.crown || '👑', n: aggregate.totalAdminActions }))
  }
  if (aggregate.externalBans > 0) {
    lines.push(i18n.t('digest.row.external', {
      eyes: e.eyes || '👀',
      n: aggregate.externalBans,
      admins: aggregate.distinctExternalAdmins,
      adminsWord: pluralText(i18n, aggregate.distinctExternalAdmins, 'digest.plural.admins')
    }))
  }
  lines.push('')

  // Per-chat breakdown. Compact one-liner per chat to keep the message
  // readable even for admins of 10+ chats.
  if (interestingChats.length > 0) {
    lines.push(i18n.t('digest.combined.per_chat_header'))
    for (const chat of interestingChats) {
      const s = perChat[chat.group_id]
      const parts = []
      if (s.autoDeletes > 0) parts.push(`${e.trash || '🗑'}${s.autoDeletes}`)
      if (s.autoBans > 0) parts.push(`${e.ban || '🚫'}${s.autoBans}`)
      if (s.externalBans > 0) parts.push(`${e.eyes || '👀'}${s.externalBans}`)
      if (s.votesResolved > 0) parts.push(`${e.target || '🎯'}${s.votesResolved}`)
      lines.push(i18n.t('digest.combined.per_chat_row', {
        title: escapeHtml(chat.title || String(chat.group_id)),
        summary: parts.join(' · ') || i18n.t('digest.combined.per_chat_quiet')
      }))
    }
    lines.push('')
  }

  lines.push(i18n.t('digest.footer', { shield: e.shield || '🛡' }))

  return lines.join('\n')
}

module.exports = {
  computeDigestStats,
  computeDigestStatsForChats,
  renderDigest,
  renderCombinedDigest,
  pickFeature,
  pluralKey,
  pluralText,
  isWorthSending,
  AUTO_EVENTS,
  MANUAL_EVENTS,
  EXTERNAL_EVENTS
}
