// Show a "typing..." action to the chat while a long-running async `fn` runs.
//
// Telegram throttles ChatAction for ~5 seconds per call, so we re-send every
// 4.5 seconds to keep the indicator visible across multi-second operations
// (LLM spam-check, /report AI analysis, etc.). All errors are swallowed — the
// indicator is purely cosmetic and must never fail the wrapped work.
//
// Usage:
//   const result = await withTyping(ctx, async () => {
//     return await openai.chat.create(...)
//   })

const DEFAULT_INTERVAL_MS = 4500

const withTyping = async (ctx, fn, opts = {}) => {
  const chatId = ctx && ctx.chat && ctx.chat.id
  if (!chatId || !ctx.telegram || typeof ctx.telegram.sendChatAction !== 'function') {
    return fn()
  }
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS
  const action = opts.action || 'typing'

  // Kick off the first action immediately so the indicator appears fast.
  ctx.telegram.sendChatAction(chatId, action).catch(() => {})

  const timer = setInterval(() => {
    ctx.telegram.sendChatAction(chatId, action).catch(() => {})
  }, intervalMs)

  try {
    return await fn()
  } finally {
    clearInterval(timer)
  }
}

module.exports = { withTyping, DEFAULT_INTERVAL_MS }
