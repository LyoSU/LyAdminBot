/**
 * chat_member update handler — records the exact moment a user joined a
 * chat so we can later compute the join→first-message latency.
 *
 * Structure of the chat_member update:
 *   {
 *     chat: { id, type, ... },
 *     from: { id, ... },               // who performed the change
 *     date: unix_seconds,
 *     old_chat_member: { user: {...}, status: 'left' | ... },
 *     new_chat_member: { user: {...}, status: 'member' | 'restricted' | ... }
 *   }
 *
 * We only care about TRANSITIONS into a "visible member" state:
 *   left / kicked  →  member / restricted
 *
 * The joinedAt timestamp is persisted on the GroupMember document so that
 * later when the user actually posts, helpers/group-member-update.js can
 * compute firstMessageLatencyMs = firstMessageAt - joinedAt.
 *
 * Pattern observed in prod: spam bots post their first message within 30s
 * of joining a chat. Humans usually lurk for minutes or hours. This signal
 * is exposed to detectors via the `fast_post_after_join` quick-assessment
 * tag when latency is available.
 */

const { spam: spamLog } = require('../helpers/logger')

const VISIBLE_STATES = new Set(['member', 'restricted', 'administrator', 'creator'])
const INVISIBLE_STATES = new Set(['left', 'kicked', 'banned'])

module.exports = async (ctx) => {
  const update = ctx.update && ctx.update.chat_member
  if (!update) return

  const newStatus = update.new_chat_member && update.new_chat_member.status
  const oldStatus = update.old_chat_member && update.old_chat_member.status
  const user = update.new_chat_member && update.new_chat_member.user

  // Ignore bot's own membership changes — my_chat_member covers those.
  if (!user || user.is_bot) return

  // Only care about the "user became visibly present" transition.
  const becameMember = VISIBLE_STATES.has(newStatus) && (!oldStatus || INVISIBLE_STATES.has(oldStatus) || oldStatus === 'kicked')
  if (!becameMember) return

  if (!ctx.db || !ctx.db.GroupMember || !ctx.group || !ctx.group.info) return

  try {
    const now = update.date ? new Date(update.date * 1000) : new Date()
    const existing = await ctx.db.GroupMember.findOne({
      group: ctx.group.info.id,
      telegram_id: user.id
    })

    if (existing) {
      // Only stamp joinedAt if it's empty AND we haven't already observed
      // a first-message from this user. Otherwise the stats are misleading:
      //   - joinedAt unset + firstMessageAt set = user was here before we
      //     subscribed to chat_member; latency is unknowable, don't fabricate
      //   - joinedAt already set = earliest recorded join wins
      if (!existing.stats.joinedAt && !existing.stats.firstMessageAt) {
        existing.stats.joinedAt = now
        await existing.save()
      }
    } else {
      const gm = new ctx.db.GroupMember({
        group: ctx.group.info.id,
        telegram_id: user.id,
        stats: { joinedAt: now, messagesCount: 0, textTotal: 0 }
      })
      await gm.save()
    }

    spamLog.debug({
      chatId: ctx.chat && ctx.chat.id,
      userId: user.id,
      oldStatus,
      newStatus,
      recordedAt: now.toISOString()
    }, 'chat_member join recorded')
  } catch (err) {
    spamLog.warn({
      err: err.message,
      chatId: ctx.chat && ctx.chat.id,
      userId: user && user.id
    }, 'Failed to record chat_member join')
  }
}
