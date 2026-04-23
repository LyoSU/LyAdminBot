// /settings → ⚙️ Діагностика (§5.7 of UX design).
//
// Live status page. Checks run in parallel, each wrapped in Promise.race with
// a short timeout. Any check that throws degrades to 🔴 + short class name —
// the panel MUST never crash.
//
// Timeouts picked to keep the page snappy even when a backend is wedged:
//   Telegram API → 3s (the bot's session is already alive; getMe is cheap)
//   Qdrant       → 3s
//   OpenAI/OR    → 5s (these are optional & may be globally slow)
//   MongoDB      → no timeout; readyState is synchronous.
//
// Each check returns { label, status: '🟢'|'🟡'|'🔴', value }. The render
// function joins them with newlines. Access: `group_admin` — diagnostics are
// admin-only (exposes env presence of API keys).

const { registerMenu } = require('../registry')
const { cb, btn, row, backBtn } = require('../keyboard')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'settings.diagnostics'

const TIMEOUT_TG_MS = 3000
const TIMEOUT_QDRANT_MS = 3000
const TIMEOUT_LLM_MS = 5000

// ---- tiny helpers ---------------------------------------------------------

const raceTimeout = (promise, ms, label = 'timeout') => {
  let timer
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}

const humanUptime = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || (!d && !h)) parts.push(`${m}m`)
  return parts.join(' ')
}

// Tag each check with a status emoji by latency / presence.
const grade = (ms, { green = 300, yellow = 1500 } = {}) => {
  if (ms === null || ms === undefined) return '🔴'
  if (ms < green) return '🟢'
  if (ms < yellow) return '🟡'
  return '🔴'
}

const errClass = (err) => {
  if (!err) return 'Error'
  if (err.name && err.name !== 'Error') return err.name
  if (err.message) {
    if (/timeout/i.test(err.message)) return 'Timeout'
    return err.message.split(':')[0].slice(0, 24)
  }
  return 'Error'
}

// ---- individual checks ----------------------------------------------------

const checkTelegram = async (ctx) => {
  const t0 = Date.now()
  try {
    await raceTimeout(ctx.telegram.callApi('getMe'), TIMEOUT_TG_MS, 'timeout')
    const ms = Date.now() - t0
    return { key: 'telegram', status: grade(ms), value: `${ms}ms` }
  } catch (err) {
    return { key: 'telegram', status: '🔴', value: errClass(err) }
  }
}

const checkMongo = async () => {
  try {
    // Require lazily — keeps this module testable without a Mongo connection.
    const mongoose = require('mongoose')
    const state = mongoose.connection && mongoose.connection.readyState
    return {
      key: 'mongo',
      status: state === 1 ? '🟢' : '🔴',
      value: state === 1 ? 'OK' : `state=${state}`
    }
  } catch (err) {
    return { key: 'mongo', status: '🔴', value: errClass(err) }
  }
}

const checkOpenAI = async () => {
  if (!process.env.OPENAI_API_KEY) {
    return { key: 'openai', status: '🟡', value: 'no key' }
  }
  // Softer reporting: we don't actually ping OpenAI here — a models.list
  // round-trip on every refresh would add $ noise. We report presence of
  // the key and recent cache size (non-zero = requests happening).
  try {
    const llmCache = require('../../llm-cache')
    if (llmCache && typeof llmCache.size === 'function') {
      const n = llmCache.size()
      return {
        key: 'openai',
        status: n > 0 ? '🟢' : '🟡',
        value: n > 0 ? `${n} cached` : 'no recent calls'
      }
    }
    return { key: 'openai', status: '🟢', value: 'configured' }
  } catch (_err) {
    return { key: 'openai', status: '🟡', value: 'no recent calls' }
  }
}

const checkOpenRouter = () => {
  if (!process.env.OPENROUTER_API_KEY) {
    return { key: 'openrouter', status: '🟡', value: 'no key' }
  }
  return { key: 'openrouter', status: '🟢', value: 'configured' }
}

const checkQdrant = async () => {
  if (!process.env.QDRANT_URL && !process.env.QDRANT_API_KEY) {
    return { key: 'qdrant', status: '🟡', value: 'not configured' }
  }
  try {
    const { client } = require('../../qdrant-client')
    const t0 = Date.now()
    await raceTimeout(client.getCollections(), TIMEOUT_QDRANT_MS, 'timeout')
    const ms = Date.now() - t0
    return { key: 'qdrant', status: grade(ms, { green: 500, yellow: 2000 }), value: `${ms}ms` }
  } catch (err) {
    return { key: 'qdrant', status: '🔴', value: errClass(err) }
  }
}

const checkQueue = () => {
  // No in-memory job queue exists in this codebase (velocity uses a Map as
  // a tracker, not a queue). Report 0 pending — wire up a real queue-length
  // counter here if/when one appears.
  return { key: 'queue', status: '🟢', value: '0 pending' }
}

const checkUptime = () => ({
  key: 'uptime',
  status: '🟢',
  value: humanUptime(process.uptime())
})

// Wrap a check so it can never throw.
const safe = (fn) => async (...args) => {
  try {
    const result = await fn(...args)
    return result
  } catch (err) {
    log.debug({ err: err.message }, 'diagnostics: check threw')
    return { key: 'unknown', status: '🔴', value: errClass(err) }
  }
}

// ---- render ---------------------------------------------------------------

const LABEL_KEY_BY_CHECK = {
  telegram: 'menu.settings.diagnostics.row.telegram',
  mongo: 'menu.settings.diagnostics.row.mongo',
  openai: 'menu.settings.diagnostics.row.openai',
  openrouter: 'menu.settings.diagnostics.row.openrouter',
  qdrant: 'menu.settings.diagnostics.row.qdrant',
  queue: 'menu.settings.diagnostics.row.queue',
  uptime: 'menu.settings.diagnostics.row.uptime'
}

const renderRow = (ctx, check) => {
  const labelKey = LABEL_KEY_BY_CHECK[check.key] || 'menu.settings.diagnostics.row.unknown'
  return ctx.i18n.t('menu.settings.diagnostics.row_fmt', {
    status: check.status,
    label: ctx.i18n.t(labelKey),
    value: check.value
  })
}

const runAllChecks = async (ctx) => {
  return Promise.all([
    safe(checkTelegram)(ctx),
    safe(checkMongo)(),
    safe(checkOpenAI)(),
    safe(checkOpenRouter)(),
    safe(checkQdrant)(),
    safe(checkQueue)(),
    safe(checkUptime)()
  ])
}

const render = async (ctx) => {
  const checks = await runAllChecks(ctx)
  const lines = checks.map(c => renderRow(ctx, c)).join('\n')
  const text = ctx.i18n.t('menu.settings.diagnostics.text', { list: lines })
  const keyboard = {
    inline_keyboard: [
      row(btn(ctx.i18n.t('menu.settings.diagnostics.btn.refresh'), cb(SCREEN_ID, 'refresh'))),
      row(backBtn('settings.root', { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const handle = async (_ctx, action) => {
  if (action === 'refresh') return 'render'
  return { render: false }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'group_admin',
    render,
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  TIMEOUT_TG_MS,
  TIMEOUT_QDRANT_MS,
  TIMEOUT_LLM_MS,
  humanUptime,
  grade,
  errClass,
  raceTimeout,
  checkTelegram,
  checkMongo,
  checkOpenAI,
  checkOpenRouter,
  checkQdrant,
  checkQueue,
  checkUptime,
  safe,
  runAllChecks,
  render,
  handle
}
