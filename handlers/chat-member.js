/**
 * chat_member update handler. Runs two independent detectors on the same
 * payload:
 *
 *   1. JOIN TRACKER — records the exact moment a user joined a chat so we
 *      can later compute the join→first-message latency (fast_post_after_join
 *      signal). Triggers on transitions INTO a visible-member state.
 *
 *   2. EXTERNAL MODERATION MIRROR — when a human admin (not our bot) bans
 *      or restricts (or un-bans / un-restricts) a user, mirror that decision
 *      into User.crossChat so own-network reputation rules can see it. Also
 *      writes a ModLog entry for audit. See also User.crossChat field docs.
 *
 * Structure of the chat_member update:
 *   {
 *     chat: { id, type, ... },
 *     from: { id, is_bot, ... },       // who performed the change
 *     date: unix_seconds,
 *     old_chat_member: { user, status: 'left' | 'member' | ... },
 *     new_chat_member: { user, status: 'member' | 'kicked' | 'restricted' | ... }
 *   }
 *
 * We intentionally IGNORE bans performed by bots (including ours). Our own
 * bans already land in ModLog via the manual_ban / auto_ban paths. Other
 * antispam bots (Shieldy, Combot) ban based on their OWN verdicts, so
 * treating their decisions as independent admin signals would double-count
 * the same signal we already get from lols / CAS.
 */

const { spam: spamLog } = require('../helpers/logger')
const { logModEvent } = require('../helpers/mod-log')

const VISIBLE_STATES = new Set(['member', 'restricted', 'administrator', 'creator'])
const INVISIBLE_STATES = new Set(['left', 'kicked', 'banned'])

const isBannedStatus = (s) => s === 'kicked' || s === 'banned'
const isRestrictedStatus = (s) => s === 'restricted'

const recordJoin = async (ctx, update, user, oldStatus, newStatus) => {
  const becameMember = VISIBLE_STATES.has(newStatus) &&
    (!oldStatus || INVISIBLE_STATES.has(oldStatus) || oldStatus === 'kicked')
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

const recordExternalModeration = async (ctx, update, user, oldStatus, newStatus) => {
  const actor = update.from
  const chatId = ctx.chat && ctx.chat.id
  if (!chatId || !actor || !user) return

  // Gate: only HUMAN admin actions. Skip bot-driven transitions because:
  //   - Our own bot: ban paths already write to ModLog with proper typing
  //   - Other antispam bots: their verdicts are derivative of their own
  //     signals, not independent human judgement. Double-counting them
  //     would corrupt the "≥2 DISTINCT admins" rule.
  if (actor.is_bot) return

  const wasBanned = isBannedStatus(oldStatus)
  const isNowBanned = isBannedStatus(newStatus)
  const wasRestricted = isRestrictedStatus(oldStatus)
  const isNowRestricted = isRestrictedStatus(newStatus)

  const becameBanned = !wasBanned && isNowBanned
  const wasUnbanned = wasBanned && !isNowBanned
  const becameRestricted = !wasRestricted && isNowRestricted
  const wasUnrestricted = wasRestricted && !isNowRestricted

  if (!becameBanned && !wasUnbanned && !becameRestricted && !wasUnrestricted) return
  if (!ctx.db || !ctx.db.User) return

  const now = update.date ? new Date(update.date * 1000) : new Date()
  const update$ = { $set: {}, $inc: {}, $addToSet: {}, $pull: {} }

  if (becameBanned) {
    update$.$addToSet['crossChat.bannedInChats'] = chatId
    update$.$addToSet['crossChat.distinctAdminsBanned'] = actor.id
    update$.$inc['crossChat.networkBanCount'] = 1
    update$.$set['crossChat.lastNetworkBanAt'] = now
    // Ban supersedes restrict in Telegram — if the user was previously
    // restricted in this chat, clean that up so restrictedInChats reflects
    // CURRENT state (not "was ever restricted").
    update$.$pull['crossChat.restrictedInChats'] = chatId
  }
  if (wasUnbanned) {
    update$.$pull['crossChat.bannedInChats'] = chatId
  }
  if (becameRestricted) {
    update$.$addToSet['crossChat.restrictedInChats'] = chatId
    update$.$inc['crossChat.networkRestrictCount'] = 1
    update$.$set['crossChat.lastNetworkRestrictAt'] = now
  }
  if (wasUnrestricted) {
    update$.$pull['crossChat.restrictedInChats'] = chatId
  }

  // Drop empty operators — mongoose rejects `$inc: {}` etc.
  for (const op of ['$set', '$inc', '$addToSet', '$pull']) {
    if (Object.keys(update$[op]).length === 0) delete update$[op]
  }

  try {
    await ctx.db.User.updateOne({ telegram_id: user.id }, update$, { upsert: false })
  } catch (err) {
    spamLog.warn({
      err: err.message,
      chatId,
      userId: user.id
    }, 'Failed to mirror external moderation into User.crossChat')
  }

  // Best-effort audit trail. Emit one ModLog row PER transition — a single
  // `chat_member` update can atomically flip both `restricted→false` AND
  // `banned→true` (escalation), and rolling both into one event silently
  // drops half the audit history.
  const actionDetail = `${oldStatus || '?'} → ${newStatus || '?'}`
  const events = []
  if (becameBanned) events.push('external_ban')
  if (becameRestricted) events.push('external_restrict')
  if (wasUnbanned) events.push('external_unban')
  if (wasUnrestricted) events.push('external_unrestrict')
  for (const eventType of events) {
    await logModEvent(ctx.db, {
      chatId,
      eventType,
      actor,
      target: user,
      action: actionDetail
    })
  }

  spamLog.debug({
    chatId,
    userId: user.id,
    actorId: actor.id,
    oldStatus,
    newStatus,
    events
  }, 'external moderation mirrored')
}

module.exports = async (ctx) => {
  const update = ctx.update && ctx.update.chat_member
  if (!update) return

  const newStatus = update.new_chat_member && update.new_chat_member.status
  const oldStatus = update.old_chat_member && update.old_chat_member.status
  const user = update.new_chat_member && update.new_chat_member.user

  // Ignore bot's own membership changes — my_chat_member covers those.
  if (!user || user.is_bot) return

  await recordJoin(ctx, update, user, oldStatus, newStatus)
  await recordExternalModeration(ctx, update, user, oldStatus, newStatus)
}
