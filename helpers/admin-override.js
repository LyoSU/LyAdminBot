// Single source of truth for the side-effects of an admin override —
// the click that says "this user is not spam, undo what the bot did."
//
// Two production paths trigger an override:
//   1. handlers/spam-vote.js — `[👍 Не спам]` (post-vote action button).
//   2. helpers/menu/screens/mod-event.js — compact `[↩️ Розблокувати]`
//      from the unified mod-event notification (§9 of the UX design).
//
// Before this util both paths drifted: spam-vote did a reputation boost
// (with a broken `settings.spamProtection.trustedUsers` whitelist branch
// that always missed because the schema field is `settings.openaiSpamCheck
// .trustedUsers`); the compact path did NOTHING beyond Telegram-side
// unban/unmute. As a result 9 of 10 overridden users in production stayed
// `restricted` with score 10, and the very next message they sent was
// auto-banned again — the same admin overriding repeatedly.
//
// What we do here:
//   - Reputation boost: +20 capped at 74. Cap chosen so a single click
//     cannot push a user into `trusted` tier (defense in depth — one
//     compromised admin should not be able to grant global trust).
//   - Reputation status: recomputed from the new score + globalStats via
//     the canonical reputation.getReputationStatus() function, so all
//     trust-tier requirements stay in one place.
//   - manualUnbans: increment (positive signal for analytics).
//   - spamDetections: decrement, but only if currently >= 1. Atomic guard
//     against going negative under concurrent overrides.
//   - Global ban: $unset the three globalBan.* fields. Aligns with the
//     spam-vote semantics ("admin says clean → unban everywhere").
//   - Per-chat whitelist: $addToSet on settings.openaiSpamCheck.trustedUsers.
//     Per-chat, NOT global — local trust only.
//
// What we deliberately DON'T do:
//   - Reverse SpamSignature confirmations. Override means "this user is
//     not a spammer in my chat" — it does not mean "this exact text is
//     never spam anywhere." Other groups still legitimately match the
//     same signature. Pulling the chatId from uniqueGroups would be a
//     penalty against the signature, not a vindication of the user.
//   - Reverse ForwardBlacklist. Same reasoning, plus FB is intentionally
//     vote-driven only (see handlers/spam-vote.js comments).

const { getReputationStatus } = require('./reputation')
const { spamVote: log } = require('./logger')

const REP_BOOST = 20
const REP_CAP = 74

/**
 * @param {Object} db   ctx.db (Mongoose model registry)
 * @param {Object} opts
 * @param {number} opts.userId   Real user id. Channels (negative) are skipped
 *                               because per-user reputation does not apply.
 * @param {number} [opts.chatId] Group where the override happened. Required
 *                               for the per-chat whitelist; if missing only
 *                               the user-level mutations run.
 * @returns {Promise<{
 *   oldScore: number,
 *   newScore: number,
 *   newStatus: string,
 *   whitelistAdded: boolean
 * }|null>}  null when skipped (channel id, missing db, missing user model).
 */
const applyAdminOverride = async (db, { userId, chatId } = {}) => {
  if (!db || !db.User) return null
  if (!userId || typeof userId !== 'number' || userId < 0) return null

  const user = await db.User.findOne({ telegram_id: userId })
  const oldScore = user?.reputation?.score ?? 50
  const globalStats = user?.globalStats || {}
  const newScore = Math.min(REP_CAP, oldScore + REP_BOOST)
  const newStatus = getReputationStatus(newScore, globalStats)

  // Reputation + manualUnbans++ + drop global ban — single atomic write.
  // upsert:true keeps parity with the previous spam-vote behaviour for
  // edge cases where we never persisted this user before.
  await db.User.updateOne(
    { telegram_id: userId },
    {
      $set: {
        'reputation.score': newScore,
        'reputation.status': newStatus,
        'reputation.lastCalculated': new Date()
      },
      $inc: { 'globalStats.manualUnbans': 1 },
      $unset: {
        isGlobalBanned: 1,
        globalBanReason: 1,
        globalBanDate: 1
      }
    },
    { upsert: true }
  )

  // spamDetections-- with a $gte:1 guard. The previous inline code did a
  // naked $inc:-1 which could leave the counter at -1 / -2 etc. on
  // double-clicks or repeated overrides on the same user.
  await db.User.updateOne(
    { telegram_id: userId, 'globalStats.spamDetections': { $gte: 1 } },
    { $inc: { 'globalStats.spamDetections': -1 } }
  )

  let whitelistAdded = false
  if (chatId && db.Group) {
    const res = await db.Group.updateOne(
      { group_id: chatId },
      { $addToSet: { 'settings.openaiSpamCheck.trustedUsers': userId } }
    )
    // Mongoose driver returns modifiedCount; legacy nModified for older shapes.
    whitelistAdded = ((res && (res.modifiedCount ?? res.nModified)) || 0) > 0
  }

  log.info({
    userId, chatId, oldScore, newScore, newStatus, whitelistAdded
  }, 'Admin override applied')

  return { oldScore, newScore, newStatus, whitelistAdded }
}

module.exports = {
  applyAdminOverride,
  REP_BOOST,
  REP_CAP
}
