// Unified callback-toast helper (§18 of the UX spec).
//
// Centralizes the canonical short toasts that every menu screen fires:
//   saved / cancelled / only_admins / session_expired / loading
//
// Callers: `await toast(ctx, 'saved')`. Keeps each site from inventing its own
// ad-hoc text and keeps locales in lockstep (key added once, works everywhere).
//
// The helper does NOT swallow errors — answerCbQuery failures usually mean the
// callback expired, and callers should decide whether to retry. If you want
// to silently absorb, chain `.catch(() => {})` at the call site.

const CANONICAL_KEYS = new Set([
  'saved',
  'cancelled',
  'only_admins',
  'session_expired',
  'loading'
])

const keyFor = (key) => `menu.common.toast.${key}`

const toast = (ctx, key, params) => {
  if (!ctx || typeof ctx.answerCbQuery !== 'function') return Promise.resolve()
  const text = ctx.i18n.t(keyFor(key), params || {})
  return ctx.answerCbQuery(text)
}

module.exports = { toast, keyFor, CANONICAL_KEYS }
