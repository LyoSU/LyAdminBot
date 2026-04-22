/**
 * Telegram system sender IDs — placeholder user_ids the Bot API sets on
 * `ctx.from` when the real sender isn't an individual user.
 *
 * Treating these as regular users has been observed to:
 *   - create one phantom User document per id (e.g. telegram_id 777000)
 *     that accumulates millions of stat writes across years
 *   - feed linked-channel auto-forwards into per-user reputation scoring
 *   - waste a ban-database lookup on every auto-forward
 *   - skew language / dormancy / hour-histogram aggregates with traffic
 *     that is not actually user behaviour
 *
 * The real sender for these messages is `message.sender_chat`, not
 * `ctx.from`. Downstream code that cares about the actual channel/group
 * should use `sender_chat.id` (already the case in context-loader.js
 * for group-member persistence).
 *
 * IDs observed in the wild:
 *   777000       — "Telegram" system (linked-channel auto-forwards,
 *                    service messages like chat-created)
 *   1087968824   — Group Anonymous Bot (anonymous admins posting as
 *                    the group)
 *   136817688    — Channel Bot (users posting on behalf of a channel
 *                    inside a discussion group)
 */
const SYSTEM_SENDER_IDS = new Set([777000, 1087968824, 136817688])

const isSystemSenderId = (id) => SYSTEM_SENDER_IDS.has(Number(id))

/**
 * True when the current ctx represents a system-sender message — i.e.
 * something that LOOKS like a user message on the API surface but is
 * really an anonymous admin / channel / service post. In that case the
 * authoritative identity is in `message.sender_chat`, not `ctx.from`.
 */
const isSystemSender = (ctx) => {
  if (!ctx || !ctx.from) return false
  return isSystemSenderId(ctx.from.id)
}

module.exports = {
  SYSTEM_SENDER_IDS,
  isSystemSenderId,
  isSystemSender
}
