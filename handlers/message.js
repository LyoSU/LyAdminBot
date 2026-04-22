const { detectAll } = require('tinyld')

// Map ISO-639-1 → legacy full-name used by the old `languagedetect`
// package, so existing per-group `removeLng` arrays in the DB
// (e.g. ['russian','belarusian']) continue to work without migration.
const ISO_TO_LEGACY_NAME = {
  en: 'english',
  ru: 'russian',
  uk: 'ukrainian',
  be: 'belarusian',
  bg: 'bulgarian',
  sr: 'serbian',
  mk: 'macedonian',
  pl: 'polish',
  cs: 'czech',
  sk: 'slovak',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  nl: 'dutch',
  sv: 'swedish',
  no: 'norwegian',
  da: 'danish',
  fi: 'finnish',
  et: 'estonian',
  lv: 'latvian',
  lt: 'lithuanian',
  ro: 'romanian',
  hu: 'hungarian',
  el: 'greek',
  tr: 'turkish',
  ar: 'arabic',
  fa: 'persian',
  he: 'hebrew',
  hi: 'hindi',
  bn: 'bengali',
  ur: 'urdu',
  ta: 'tamil',
  te: 'telugu',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
  th: 'thai',
  vi: 'vietnamese',
  id: 'indonesian',
  ms: 'malay'
}

// Match either shape the admin might have stored: legacy full name
// ('russian') or the new ISO-639-1 code ('ru').
const isRemoved = (removeLng, iso) => {
  if (!Array.isArray(removeLng) || !iso) return false
  if (removeLng.includes(iso)) return true
  const legacy = ISO_TO_LEGACY_NAME[iso]
  return Boolean(legacy && removeLng.includes(legacy))
}

/**
 * Generic message handler
 * - Detects and removes messages in banned languages (per-group setting)
 */
module.exports = async (ctx) => {
  if (ctx.chat.type === 'private') return
  if (!ctx.message || !ctx.message.text) return

  const removeLng = ctx.group && ctx.group.info && ctx.group.info.settings &&
    ctx.group.info.settings.removeLng
  if (!Array.isArray(removeLng) || removeLng.length === 0) return

  const results = detectAll(ctx.message.text)
  if (!results.length) return
  const top = results[0]
  // Require reasonable confidence — the old threshold was >0.3 on
  // languagedetect's frequency score; tinyld's `accuracy` is a
  // comparable 0..1 value, so we keep the same bar.
  if (!top || !top.lang || typeof top.accuracy !== 'number' || top.accuracy <= 0.3) return

  if (isRemoved(removeLng, top.lang)) {
    await ctx.deleteMessage().catch(() => { /* silently fail if no perm */ })
  }
}
