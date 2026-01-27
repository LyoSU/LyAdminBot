const { updateVoteUI, showResultUI } = require('../helpers/vote-ui')
const { addSignature } = require('../helpers/spam-signatures')
const { spamVote: log } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')

/**
 * Check if a user is eligible to vote on spam decisions
 *
 * Eligibility:
 * - Admins: always can vote, weight ×3
 * - Trusted users: can vote, weight ×1
 * - Regular users: cannot vote
 *
 * @returns {Object} { canVote: boolean, weight: number, isAdmin: boolean }
 */
const checkVoteEligibility = async (ctx, chatId, userId) => {
  // 1. Check if user is admin
  try {
    const chatMember = await ctx.telegram.getChatMember(chatId, userId)
    if (['creator', 'administrator'].includes(chatMember.status)) {
      return { canVote: true, weight: 3, isAdmin: true }
    }
  } catch (error) {
    log.warn({ err: error.message, userId, chatId }, 'Could not check admin status')
  }

  // 2. Check if user has trusted reputation
  try {
    const user = await ctx.db.User.findOne({ telegram_id: userId })
    if (user && user.reputation && user.reputation.status === 'trusted') {
      return { canVote: true, weight: 1, isAdmin: false }
    }
  } catch (error) {
    log.warn({ err: error.message, userId }, 'Could not check user reputation')
  }

  // 3. Regular users cannot vote
  return { canVote: false, weight: 0, isAdmin: false }
}

/**
 * Process the vote result and apply consequences
 *
 * - clean wins: unban user, set reputation to trusted
 * - spam wins: add to SpamSignature, decrease reputation
 */
const processVoteResult = async (ctx, spamVote) => {
  const winner = spamVote.getWinner()
  spamVote.result = winner
  spamVote.resolvedAt = new Date()
  spamVote.resolvedBy = 'votes'

  let reputationChange = null

  if (winner === 'clean') {
    // UNBAN: Community decided this was not spam

    // 1. Unmute the user (remove restrictions)
    try {
      if (spamVote.bannedUserId > 0) {
        // Remove restrictions by granting all permissions
        await ctx.telegram.restrictChatMember(spamVote.chatId, spamVote.bannedUserId, {
          permissions: {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_change_info: false,
            can_invite_users: true,
            can_pin_messages: false,
            can_manage_topics: false
          }
        })
        log.info({
          eventId: spamVote.eventId,
          userId: spamVote.bannedUserId
        }, 'Unmuted user by community vote')
      } else {
        // For channels, use unbanChatSenderChat
        await ctx.telegram.callApi('unbanChatSenderChat', {
          chat_id: spamVote.chatId,
          sender_chat_id: spamVote.bannedUserId
        })
        log.info({
          eventId: spamVote.eventId,
          channelId: spamVote.bannedUserId
        }, 'Unbanned channel by community vote')
      }
    } catch (error) {
      log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to unmute')
    }

    // 2. Set user as trusted (only for real users, not channels)
    if (spamVote.bannedUserId > 0) {
      try {
        const user = await ctx.db.User.findOne({ telegram_id: spamVote.bannedUserId })
        const oldScore = user?.reputation?.score || 50

        await ctx.db.User.findOneAndUpdate(
          { telegram_id: spamVote.bannedUserId },
          {
            $set: {
              'reputation.status': 'trusted',
              'reputation.score': 75,
              'reputation.lastCalculated': new Date()
            },
            $inc: { 'globalStats.manualUnbans': 1 }
          },
          { upsert: true }
        )

        reputationChange = { oldScore, newScore: 75 }
        log.info({
          eventId: spamVote.eventId,
          userId: spamVote.bannedUserId,
          oldScore,
          newScore: 75
        }, 'Set user as trusted')
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to update reputation')
      }
    }
  } else {
    // CONFIRM SPAM: Community confirmed this was spam

    // 1. Add to SpamSignature (multi-layer hashing for future detection)
    if (spamVote.messagePreview) {
      try {
        const signature = await addSignature(spamVote.messagePreview, ctx.db, spamVote.chatId)
        if (signature) {
          log.info({
            eventId: spamVote.eventId,
            status: signature.status,
            uniqueGroups: signature.uniqueGroups.length
          }, 'Added to SpamSignature')
        }
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to add SpamSignature')
      }
    }

    // 2. Decrease user reputation (only for real users)
    if (spamVote.bannedUserId > 0) {
      try {
        const user = await ctx.db.User.findOne({ telegram_id: spamVote.bannedUserId })
        const oldScore = user?.reputation?.score || 50
        const newScore = Math.max(0, oldScore - 15)

        // Determine new status based on score
        let newStatus = 'neutral'
        if (newScore < 20) newStatus = 'restricted'
        else if (newScore < 40) newStatus = 'suspicious'

        await ctx.db.User.findOneAndUpdate(
          { telegram_id: spamVote.bannedUserId },
          {
            $set: {
              'reputation.score': newScore,
              'reputation.status': newStatus,
              'reputation.lastCalculated': new Date()
            }
          }
        )

        reputationChange = { oldScore, newScore }
        log.info({
          eventId: spamVote.eventId,
          userId: spamVote.bannedUserId,
          oldScore,
          newScore
        }, 'Decreased user reputation')
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to decrease reputation')
      }
    }
  }

  await spamVote.save()

  // Update UI to show result
  await showResultUI(ctx, spamVote, reputationChange)

  log.info({
    eventId: spamVote.eventId,
    result: winner,
    spamWeighted: spamVote.voteTally.spamWeighted,
    cleanWeighted: spamVote.voteTally.cleanWeighted
  }, 'Vote resolved')
}

/**
 * Handle spam vote callback
 * Callback data format: sv:{eventId}:{vote}
 * Example: sv:a1b2c3d4e5f6:spam
 */
const handleSpamVoteCallback = async (ctx) => {
  const callbackData = ctx.callbackQuery.data
  const parts = callbackData.split(':')

  if (parts.length !== 3 || parts[0] !== 'sv') {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.invalid_format'))
  }

  const [, eventId, vote] = parts

  if (!['spam', 'clean'].includes(vote)) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.invalid_vote'))
  }

  // Find the vote event
  const spamVote = await ctx.db.SpamVote.findOne({ eventId })

  if (!spamVote) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.not_found'), { show_alert: true })
  }

  if (spamVote.result !== 'pending') {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.already_finished'))
  }

  // Check if voting window has expired
  if (new Date() > spamVote.expiresAt) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.time_expired'), { show_alert: true })
  }

  // Check eligibility
  const eligibility = await checkVoteEligibility(ctx, spamVote.chatId, ctx.from.id)

  if (!eligibility.canVote) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.no_permission'), { show_alert: true })
  }

  // Check if already voted
  if (spamVote.hasVoted(ctx.from.id)) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.already_voted'))
  }

  // Record the vote
  const voteAdded = spamVote.addVote({
    userId: ctx.from.id,
    username: ctx.from.username,
    displayName: ctx.from.first_name,
    vote,
    weight: eligibility.weight,
    isAdmin: eligibility.isAdmin
  })

  if (!voteAdded) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.error'))
  }

  await spamVote.save()

  log.info({
    eventId,
    voterId: ctx.from.id,
    voterName: ctx.from.username || ctx.from.first_name,
    vote,
    weight: eligibility.weight,
    isAdmin: eligibility.isAdmin
  }, 'Vote recorded')

  // Check if enough votes to decide
  if (spamVote.canResolve()) {
    await processVoteResult(ctx, spamVote)
  } else {
    // Update UI to show current state
    await updateVoteUI(ctx, spamVote)
  }

  const voteEmoji = vote === 'spam' ? '🚫' : '✓'
  return ctx.answerCbQuery(`${voteEmoji} ${ctx.i18n.t('spam_vote.cb.vote_recorded')}`)
}

/**
 * Process expired vote events
 * Called periodically to handle votes that timed out
 */
const processExpiredVotes = async (db, telegram, i18n) => {
  try {
    const expiredVotes = await db.SpamVote.findExpired(50)

    for (const vote of expiredVotes) {
      // Get group locale for i18n
      const group = await db.Group.findOne({ group_id: vote.chatId })
      const locale = group?.locale || 'en'
      const i18nCtx = i18n.createContext(locale, {})

      // If no votes at all, default to spam (keep the ban)
      if (vote.voteTally.spamWeighted + vote.voteTally.cleanWeighted === 0) {
        vote.result = 'spam'
        vote.resolvedAt = new Date()
        vote.resolvedBy = 'timeout'
        await vote.save()

        log.info({
          eventId: vote.eventId,
          result: 'spam',
          reason: 'no_votes'
        }, 'Vote expired with no votes, defaulting to spam')

        // Add to SpamSignature (multi-layer hashing for future detection)
        if (vote.messagePreview) {
          try {
            await addSignature(vote.messagePreview, db, vote.chatId)
          } catch (sigError) {
            log.error({ err: sigError.message }, 'Failed to add SpamSignature on timeout')
          }
        }

        // Show timeout result and delete after delay
        if (vote.notificationMessageId && vote.notificationChatId) {
          try {
            const timeoutText = i18nCtx.t('spam_vote.timeout_confirmed', { name: vote.bannedUserName })

            await telegram.editMessageText(
              vote.notificationChatId,
              vote.notificationMessageId,
              null,
              timeoutText,
              { parse_mode: 'HTML' }
            )

            // Schedule deletion after 30 seconds (persistent)
            await scheduleDeletion(db, {
              chatId: vote.notificationChatId,
              messageId: vote.notificationMessageId,
              delayMs: 30000,
              source: 'vote_timeout',
              reference: { type: 'spam_vote', id: vote.eventId }
            }, telegram)
          } catch {
            // If edit fails, try to delete immediately
            try {
              await telegram.deleteMessage(vote.notificationChatId, vote.notificationMessageId)
            } catch { /* ignore */ }
          }
        }
      } else {
        // Process based on current votes
        // Create a minimal context for processVoteResult
        const ctx = {
          db,
          telegram,
          i18n: i18nCtx
        }
        await processVoteResult(ctx, vote)
        vote.resolvedBy = 'timeout'
        await vote.save()

        log.info({
          eventId: vote.eventId,
          result: vote.result,
          spamWeighted: vote.voteTally.spamWeighted,
          cleanWeighted: vote.voteTally.cleanWeighted
        }, 'Vote expired, processed with current votes')
      }
    }

    if (expiredVotes.length > 0) {
      log.debug({ count: expiredVotes.length }, 'Processed expired votes')
    }
  } catch (error) {
    log.error({ err: error.message }, 'Error processing expired votes')
  }
}

module.exports = {
  handleSpamVoteCallback,
  processExpiredVotes,
  checkVoteEligibility,
  processVoteResult
}
