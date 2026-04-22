// Pure inline-keyboard builders for the unified Menu Router.
// All callback_data strings start with the prefix `m:v1:`.

const PREFIX = 'm:v1:'
const NOOP = `${PREFIX}_noop`
const CLOSE = `${PREFIX}_close`
const MAX_CB_BYTES = 64

const cb = (...parts) => {
  const raw = PREFIX + parts.filter(p => p !== undefined && p !== null).join(':')
  if (Buffer.byteLength(raw, 'utf8') <= MAX_CB_BYTES) return raw
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(`callback_data exceeds ${MAX_CB_BYTES} bytes (${Buffer.byteLength(raw, 'utf8')}): ${raw}`)
  }
  // Production safety net: truncate without splitting a multibyte char.
  const buf = Buffer.from(raw, 'utf8')
  let end = MAX_CB_BYTES
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--
  return buf.slice(0, end).toString('utf8')
}

const btn = (text, callbackData, opts = {}) => {
  const o = { text }
  if (opts.url) {
    o.url = opts.url
  } else if (callbackData !== undefined && callbackData !== null) {
    o.callback_data = callbackData
  } else {
    throw new Error(`btn: missing both callback_data and opts.url for "${text}"`)
  }
  if (opts.iconEmojiId) o.icon_custom_emoji_id = opts.iconEmojiId
  if (opts.loginUrl) o.login_url = opts.loginUrl
  return o
}

const row = (...buttons) => buttons.filter(Boolean)

const backBtn = (toScreenId, opts = {}) => btn(
  opts.label || '← Назад',
  cb(toScreenId, 'open')
)

const closeBtn = (opts = {}) => btn(opts.label || '✕ Закрити', CLOSE)

const toggleBtn = ({ label, on, callback, iconEmojiId }) => btn(
  `${on ? '🟢' : '🔴'} ${label}`,
  callback,
  iconEmojiId ? { iconEmojiId } : {}
)

const paginated = ({ items, page = 0, perPage = 10, screenId }) => {
  const total = Math.max(1, Math.ceil(items.length / perPage))
  const safePage = Math.max(0, Math.min(page, total - 1))
  const start = safePage * perPage
  const pageItems = items.slice(start, start + perPage)

  if (total <= 1) {
    return { pageItems, page: safePage, totalPages: total, nav: [] }
  }

  const prevCb = safePage > 0 ? cb(screenId, 'page', String(safePage - 1)) : NOOP
  const nextCb = safePage < total - 1 ? cb(screenId, 'page', String(safePage + 1)) : NOOP

  const nav = [
    btn('‹', prevCb),
    btn(`${safePage + 1} / ${total}`, NOOP),
    btn('›', nextCb)
  ]

  return { pageItems, page: safePage, totalPages: total, nav }
}

const confirmKeyboard = ({ yesLabel, yesCallback, noLabel, noCallback }) => ({
  inline_keyboard: [[
    btn(yesLabel, yesCallback),
    btn(noLabel, noCallback)
  ]]
})

module.exports = {
  PREFIX,
  NOOP,
  CLOSE,
  MAX_CB_BYTES,
  cb,
  btn,
  row,
  backBtn,
  closeBtn,
  toggleBtn,
  paginated,
  confirmKeyboard
}
