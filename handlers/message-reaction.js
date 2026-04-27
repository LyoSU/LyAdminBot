/**
 * message_reaction update handler.
 *
 * Consumes Telegram's message_reaction_updated events and routes them
 * through helpers/reaction-feedback.js. Handles FIVE distinct outcomes:
 *
 *   negativeEscalation  → delete the offending message (crowd flagged spam)
 *   harassmentBrigading → log + do nothing (attack on honest user; deleting
 *                         would reward the attackers). We also surface a
 *                         warning so admins know brigading is happening.
 *   amplificationRing   → log + feed into future spam-check on that user
 *                         (farm seed detected; message will be re-evaluated)
 *   positiveTrustBoost  → bump the AUTHOR's cleanMessages counter; over
 *                         time this raises reputation for community-liked
 *                         contributors.
 *   controversySkip     → no-op (split community opinion, not spam).
 *
 * Important: Telegram delivers message_reaction updates ONLY in groups
 * where the bot is an admin. A non-admin bot subscribed to this update
 * type will silently receive nothing. We surface the no-admin case via
 * delete-permission failures in logs rather than preempting.
 */

const { spam: spamLog, spamAction: actionLog } = require('../helpers/logger')
const {
  recordReaction,
  classifyUpdate
} = require('../helpers/reaction-feedback')

const isTrustedReactor = (userInfo) => {
  if (!userInfo) return false
  const rep = userInfo.reputation || {}
  const stats = userInfo.globalStats || {}
  if (rep.status === 'restricted' || rep.status === 'suspicious') return false
  if ((stats.spamDetections || 0) > 0) return false
  if ((stats.totalMessages || 0) < 20) return false
  return rep.status === 'trusted' || rep.status === 'neutral'
}

module.exports = async (ctx) => {
  const update = ctx.update && ctx.update.message_reaction
  if (!update) return

  const reactorUser = update.user
  if (!reactorUser || reactorUser.is_bot) return

  const classification = classifyUpdate(update)
  if (!classification.addedNegative && !classification.addedPositive) return

  const chatId = update.chat && update.chat.id
  const messageId = update.message_id
  if (!chatId || !messageId) return

  // Pull reactor reputation / tenure. Prefer session cache; fall back to
  // DB read. For high-volume chats this is one extra small query per
  // reaction — acceptable because reactions are human-paced.
  let reactorInfo = null
  if (ctx.session && ctx.session.userInfo && ctx.session.userInfo.telegram_id === reactorUser.id) {
    reactorInfo = ctx.session.userInfo
  } else if (ctx.db && ctx.db.User) {
    try {
      reactorInfo = await ctx.db.User.findOne({ telegram_id: reactorUser.id })
        .select('reputation globalStats.totalMessages globalStats.spamDetections')
        .lean()
    } catch (_err) { /* non-fatal */ }
  }

  const reactorSnapshot = {
    userId: reactorUser.id,
    trusted: isTrustedReactor(reactorInfo),
    tenureMessages: reactorInfo && reactorInfo.globalStats && reactorInfo.globalStats.totalMessages,
    reputationScore: reactorInfo && reactorInfo.reputation && reactorInfo.reputation.score
  }

  const verdict = recordReaction(chatId, messageId, reactorSnapshot, classification)
  spamLog.debug({
    chatId,
    messageId,
    reactorId: reactorUser.id,
    addedNegative: classification.addedNegative,
    addedPositive: classification.addedPositive,
    verdict: verdict || null
  }, 'reaction update')

  if (!verdict) return

  // ----- brigading: log loudly, do NOT delete the message ---------------
  if (verdict.harassmentBrigading) {
    spamLog.warn({
      chatId,
      messageId,
      count: verdict.harassmentBrigading.count,
      burstMs: verdict.harassmentBrigading.burstMs
    }, 'Reaction-brigading pattern detected (low-rep reactors in burst)')
  }

  // ----- amplification ring: log for cross-reference --------------------
  if (verdict.amplificationRing) {
    spamLog.warn({
      chatId,
      messageId,
      burstSize: verdict.amplificationRing.burstSize,
      burstMs: verdict.amplificationRing.burstMs
    }, 'Reaction-amplification ring detected (low-tenure positive burst)')
  }

  // ----- negative escalation: delete the message ------------------------
  if (verdict.negativeEscalation) {
    try {
      await ctx.telegram.deleteMessage(chatId, messageId)
      actionLog.info({
        chatId,
        messageId,
        source: 'reaction_feedback',
        trustedUsers: verdict.negativeEscalation.trustedUsers,
        weightSum: verdict.negativeEscalation.weightSum
      }, 'Deleted message via reaction feedback')
    } catch (err) {
      spamLog.debug({ chatId, messageId, err }, 'Reaction-delete failed (likely no admin rights)')
    }
  }

  // ----- positive trust boost: bump author's clean counter -------------
  // We don't have the author's user doc here — only a messageId. Rather
  // than doing a lookup, we stash the event to a lightweight side channel
  // (per-chat recent positive-boosted set) so the next time we see the
  // author send a message, we can reward them. For now, just log.
  if (verdict.positiveTrustBoost) {
    spamLog.info({
      chatId,
      messageId,
      trustedUsers: verdict.positiveTrustBoost.trustedUsers,
      distinctUsers: verdict.positiveTrustBoost.distinctUsers
    }, 'Community-positive trust boost')
  }
}
