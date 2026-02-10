const { updateVoteUI, showResultUI } = require('../helpers/vote-ui')
const { addSignature } = require('../helpers/spam-signatures')
const { getReputationStatus } = require('../helpers/reputation')
const { spamVote: log, nlp: nlpLog } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const e = require('../helpers/emoji-map')
const nlpClient = require('../helpers/nlp-client')

/**
 * Check if a user is eligible to vote on spam decisions
 *
 * Eligibility:
 * - Admins: always can vote, weight ×3
 * - Trusted users: can vote, weight ×2
 * - Active members (10+ messages in chat): can vote, weight ×1
 * - Regular users: cannot vote
 *
 * @returns {Object} { canVote: boolean, weight: number, isAdmin: boolean }
 */
const MIN_MESSAGES_TO_VOTE = 10

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
      return { canVote: true, weight: 2, isAdmin: false }
    }
  } catch (error) {
    log.warn({ err: error.message, userId }, 'Could not check user reputation')
  }

  // 3. Check if user has enough messages in this chat
  try {
    const group = await ctx.db.Group.findOne({ group_id: chatId })
    if (group && group.members && group.members[userId]) {
      const memberStats = group.members[userId].stats
      const messageCount = (memberStats && memberStats.messagesCount) || 0
      if (messageCount >= MIN_MESSAGES_TO_VOTE) {
        return { canVote: true, weight: 1, isAdmin: false }
      }
    }
  } catch (error) {
    log.warn({ err: error.message, userId, chatId }, 'Could not check message count')
  }

  // 4. Regular users cannot vote
  return { canVote: false, weight: 0, isAdmin: false }
}

/**
 * Process the vote result and apply consequences
 *
 * - clean wins: unban user, set reputation to trusted
 * - spam wins: add to SpamSignature, decrease reputation
 *
 * @param {Object} ctx - Telegraf context
 * @param {Object} spamVote - SpamVote document
 * @param {boolean} skipSave - If true, don't save (already saved atomically)
 */
const processVoteResult = async (ctx, spamVote, skipSave = false) => {
  // Fix: 'pending' is truthy, so we must explicitly check for resolved states
  // Otherwise votes stay pending forever and get reprocessed repeatedly
  const winner = ['spam', 'clean'].includes(spamVote.result)
    ? spamVote.result
    : spamVote.getWinner()

  // Only set these if not already set (for backwards compatibility)
  if (!skipSave) {
    spamVote.result = winner
    spamVote.resolvedAt = new Date()
    spamVote.resolvedBy = 'votes'
  }

  let reputationChange = null

  if (winner === 'clean') {
    // UNBAN: Community decided this was not spam

    // 1. Unban/unmute the user
    try {
      if (spamVote.bannedUserId > 0) {
        if (spamVote.actionTaken?.banned) {
          // User was fully banned - use unbanChatMember
          await ctx.telegram.callApi('unbanChatMember', {
            chat_id: spamVote.chatId,
            user_id: spamVote.bannedUserId,
            only_if_banned: true
          })
          log.info({
            eventId: spamVote.eventId,
            userId: spamVote.bannedUserId
          }, 'Unbanned user by community vote')
        } else {
          // User was muted - remove restrictions
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
        }
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
      log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to unban/unmute')
    }

    // 2. Boost reputation (only for real users, not channels)
    // Clean vote gives +20 bonus but doesn't grant instant trusted status
    // User must still meet activity requirements for trusted
    if (spamVote.bannedUserId > 0) {
      try {
        const user = await ctx.db.User.findOne({ telegram_id: spamVote.bannedUserId })
        const oldScore = user?.reputation?.score || 50
        const globalStats = user?.globalStats || {}

        // Bonus for false positive, but cap at 74 (neutral max)
        // Trusted status must be earned through activity, not single vote
        const newScore = Math.min(74, oldScore + 20)
        const newStatus = getReputationStatus(newScore, globalStats)

        await ctx.db.User.findOneAndUpdate(
          { telegram_id: spamVote.bannedUserId },
          {
            $set: {
              'reputation.status': newStatus,
              'reputation.score': newScore,
              'reputation.lastCalculated': new Date()
            },
            $inc: {
              'globalStats.manualUnbans': 1,
              'globalStats.spamDetections': -1 // Reverse the false positive
            }
          },
          { upsert: true }
        )

        reputationChange = { oldScore, newScore }
        log.info({
          eventId: spamVote.eventId,
          userId: spamVote.bannedUserId,
          oldScore,
          newScore,
          newStatus
        }, 'Boosted reputation after clean vote')
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to update reputation')
      }
    }

    // 3. Update ForwardBlacklist (report false positive)
    if (spamVote.forwardOrigin && spamVote.forwardOrigin.hash && ctx.db.ForwardBlacklist) {
      try {
        await ctx.db.ForwardBlacklist.addCleanReport(spamVote.forwardOrigin.hash)
        log.debug({ eventId: spamVote.eventId }, 'Reported clean to ForwardBlacklist')
      } catch (error) {
        log.warn({ err: error.message, eventId: spamVote.eventId }, 'Failed to report clean to ForwardBlacklist')
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

          // Step 4: NLP background integration - extract metadata asynchronously
          if (nlpClient.CONFIG.enabled) {
            extractNlpMetadata(spamVote.messagePreview, signature, ctx.db)
          }
        }
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to add SpamSignature')
      }
    }

    // 2. Update ForwardBlacklist (track spam forward sources)
    if (spamVote.forwardOrigin && spamVote.forwardOrigin.hash && ctx.db.ForwardBlacklist) {
      try {
        const blacklistEntry = await ctx.db.ForwardBlacklist.addSpamReport(
          spamVote.forwardOrigin,
          spamVote.chatId,
          spamVote.messagePreview
        )
        if (blacklistEntry) {
          log.info({
            eventId: spamVote.eventId,
            forwardType: blacklistEntry.forwardType,
            status: blacklistEntry.status,
            spamReports: blacklistEntry.spamReports
          }, 'Updated ForwardBlacklist')
        }
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to update ForwardBlacklist')
      }
    }

    // 3. Decrease user reputation (only for real users)
    if (spamVote.bannedUserId > 0) {
      try {
        const user = await ctx.db.User.findOne({ telegram_id: spamVote.bannedUserId })
        const oldScore = user?.reputation?.score || 50
        const globalStats = user?.globalStats || {}
        const newScore = Math.max(0, oldScore - 15)

        // Use centralized status calculation (includes activity requirements)
        const newStatus = getReputationStatus(newScore, globalStats)

        // Note: spamDetections already incremented when spam was first detected
        // Don't increment again here - just update reputation
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
          newScore,
          newStatus
        }, 'Decreased user reputation')
      } catch (error) {
        log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to decrease reputation')
      }
    }
  }

  // Save only if not already saved atomically
  if (!skipSave) {
    await spamVote.save()
  }

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

  // Prepare vote data
  const voteData = {
    userId: ctx.from.id,
    username: ctx.from.username,
    displayName: ctx.from.first_name,
    vote,
    weight: eligibility.weight,
    isAdmin: eligibility.isAdmin,
    votedAt: new Date()
  }

  // Atomically add vote and update tallies using findOneAndUpdate
  // This prevents race conditions when multiple users vote simultaneously
  const tallyUpdate = vote === 'spam'
    ? { 'voteTally.spamCount': 1, 'voteTally.spamWeighted': eligibility.weight }
    : { 'voteTally.cleanCount': 1, 'voteTally.cleanWeighted': eligibility.weight }

  const updatedVote = await ctx.db.SpamVote.findOneAndUpdate(
    {
      _id: spamVote._id,
      result: 'pending',
      'voters.userId': { $ne: ctx.from.id } // Guard: not already voted
    },
    {
      $push: { voters: voteData },
      $inc: tallyUpdate
    },
    { new: true }
  )

  if (!updatedVote) {
    // Either already voted, or vote already resolved
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.already_voted'))
  }

  log.info({
    eventId,
    voterId: ctx.from.id,
    voterName: ctx.from.username || ctx.from.first_name,
    vote,
    weight: eligibility.weight,
    isAdmin: eligibility.isAdmin
  }, 'Vote recorded')

  // Check if enough votes to decide
  if (updatedVote.canResolve()) {
    // Atomically try to claim resolution (prevents double processing)
    const resolvedVote = await ctx.db.SpamVote.findOneAndUpdate(
      {
        _id: updatedVote._id,
        result: 'pending' // Guard: only one resolver wins
      },
      {
        $set: {
          result: updatedVote.getWinner(),
          resolvedAt: new Date(),
          resolvedBy: 'votes'
        }
      },
      { new: true }
    )

    if (resolvedVote) {
      // We won the race - process the result
      await processVoteResult(ctx, resolvedVote, true) // skipSave=true since already saved
    }
  } else {
    // Update UI to show current state
    await updateVoteUI(ctx, updatedVote)
  }

  const voteEmoji = vote === 'spam' ? e.ban : '✓'
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

        // NOTE: We intentionally DON'T add to SpamSignature when no votes were cast
        // This prevents false positives from polluting the signature database
        // Only human-confirmed spam (via actual votes) should be added to signatures

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

/**
 * Extract NLP metadata asynchronously for analytics
 * This runs in background after spam is confirmed - doesn't block vote processing
 *
 * @param {string} text - The spam message text
 * @param {Object} signature - The SpamSignature document
 * @param {Object} db - Database connection
 */
const extractNlpMetadata = (text, signature, db) => {
  // Fix: Validate inputs before async operation
  // Prevents silent failures and makes debugging easier
  if (!signature || !signature._id) {
    nlpLog.warn('extractNlpMetadata called without valid signature')
    return
  }
  if (!text || text.length < 10) {
    nlpLog.debug({ signatureId: signature._id }, 'Text too short for NLP extraction')
    return
  }
  if (!db || !db.SpamSignature) {
    nlpLog.warn('extractNlpMetadata called without valid db')
    return
  }

  const signatureId = signature._id

  setImmediate(async () => {
    try {
      const nlpResult = await nlpClient.extract(text)
      if (!nlpResult) {
        nlpLog.debug({ signatureId }, 'NLP extraction returned null')
        return
      }

      // Update signature with NLP metadata using _id (stable reference)
      await db.SpamSignature.updateOne(
        { _id: signatureId },
        {
          $set: {
            nlpMetadata: {
              lang: nlpResult.lang,
              posSignature: nlpResult.pos.slice(0, 10).join('-'),
              topBigrams: nlpResult.bigrams.slice(0, 5)
            }
          }
        }
      )

      nlpLog.info({
        signatureId,
        lang: nlpResult.lang,
        posCount: nlpResult.pos.length
      }, 'NLP metadata extracted for spam signature')
    } catch (err) {
      nlpLog.warn({ err: err.message, signatureId }, 'NLP metadata extraction failed')
    }
  })
}

/**
 * Handle admin "Not spam" override for high-confidence auto-actions
 * Callback data format: ns:<bannedUserId>
 *
 * This reverses the bot's auto-action: unbans/unmutes the user,
 * boosts reputation, adds to group trusted list, removes global ban.
 * Only group admins can use this.
 */
const handleAdminOverride = async (ctx) => {
  const callbackData = ctx.callbackQuery.data
  const parts = callbackData.split(':')

  if (parts.length !== 2 || parts[0] !== 'ns') {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.invalid_format'))
  }

  const bannedUserId = Number(parts[1])
  if (!bannedUserId || isNaN(bannedUserId)) {
    return ctx.answerCbQuery(ctx.i18n.t('spam_vote.cb.invalid_format'))
  }

  const chatId = ctx.chat.id
  const adminId = ctx.from.id

  // 1. Verify presser is admin
  try {
    const chatMember = await ctx.telegram.getChatMember(chatId, adminId)
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      return ctx.answerCbQuery(ctx.i18n.t('spam.admin_override_not_admin'), { show_alert: true })
    }
  } catch (error) {
    log.warn({ err: error.message, adminId, chatId }, 'Could not verify admin status for override')
    return ctx.answerCbQuery(ctx.i18n.t('spam.admin_override_not_admin'), { show_alert: true })
  }

  // 2. Unban + unmute (idempotent — try both regardless of original action)
  try {
    if (bannedUserId > 0) {
      // Try unban (no-op if not banned)
      await ctx.telegram.callApi('unbanChatMember', {
        chat_id: chatId,
        user_id: bannedUserId,
        only_if_banned: true
      }).catch(e => log.debug({ err: e.message, bannedUserId }, 'Unban no-op'))

      // Try unmute (no-op if not muted)
      await ctx.telegram.restrictChatMember(chatId, bannedUserId, {
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
      }).catch(e => log.debug({ err: e.message, bannedUserId }, 'Unmute no-op'))

      log.info({ adminId, bannedUserId, chatId }, 'Admin override: unbanned/unmuted user')
    } else {
      // Channel — use unbanChatSenderChat
      await ctx.telegram.callApi('unbanChatSenderChat', {
        chat_id: chatId,
        sender_chat_id: bannedUserId
      }).catch(e => log.debug({ err: e.message, channelId: bannedUserId }, 'Channel unban no-op'))

      log.info({ adminId, channelId: bannedUserId, chatId }, 'Admin override: unbanned channel')
    }
  } catch (error) {
    log.error({ err: error.message, adminId, bannedUserId, chatId }, 'Admin override: unban/unmute failed')
  }

  // 3. Remove global ban (only for real users)
  if (bannedUserId > 0 && ctx.db) {
    try {
      await ctx.db.User.findOneAndUpdate(
        { telegram_id: bannedUserId },
        {
          $unset: { isGlobalBanned: 1, globalBanReason: 1, globalBanDate: 1 }
        }
      )
    } catch (error) {
      log.warn({ err: error.message, bannedUserId }, 'Admin override: failed to remove global ban')
    }

    // 4. Reputation boost (+20, capped at 74) + stats adjustment
    try {
      const user = await ctx.db.User.findOne({ telegram_id: bannedUserId })
      const oldScore = user?.reputation?.score || 50
      const globalStats = user?.globalStats || {}
      const newScore = Math.min(74, oldScore + 20)
      const newStatus = getReputationStatus(newScore, globalStats)

      await ctx.db.User.findOneAndUpdate(
        { telegram_id: bannedUserId },
        {
          $set: {
            'reputation.status': newStatus,
            'reputation.score': newScore,
            'reputation.lastCalculated': new Date()
          },
          $inc: {
            'globalStats.manualUnbans': 1,
            'globalStats.spamDetections': -1
          }
        },
        { upsert: true }
      )

      log.info({ adminId, bannedUserId, oldScore, newScore, newStatus }, 'Admin override: reputation boosted')
    } catch (error) {
      log.error({ err: error.message, bannedUserId }, 'Admin override: failed to update reputation')
    }

    // 5. Add to group's trustedUsers (per-group only, not global)
    try {
      const group = await ctx.db.Group.findOne({ group_id: chatId })
      if (group && group.settings && group.settings.spamProtection) {
        if (!group.settings.spamProtection.trustedUsers) {
          group.settings.spamProtection.trustedUsers = []
        }
        if (!group.settings.spamProtection.trustedUsers.includes(bannedUserId)) {
          group.settings.spamProtection.trustedUsers.push(bannedUserId)
          group.markModified('settings.spamProtection.trustedUsers')
          await group.save()
          log.info({ bannedUserId, chatId }, 'Admin override: added to group trusted list')
        }
      }
    } catch (error) {
      log.warn({ err: error.message, bannedUserId, chatId }, 'Admin override: failed to add to trusted list')
    }
  }

  // 6. Edit notification to show override result + remove button
  const adminName = ctx.from.first_name || ctx.from.username || `${adminId}`
  let bannedUserName = `${bannedUserId}`
  if (bannedUserId > 0 && ctx.db) {
    try {
      const user = await ctx.db.User.findOne({ telegram_id: bannedUserId })
      if (user && user.first_name) {
        bannedUserName = user.first_name
      }
    } catch { /* use ID as fallback */ }
  }

  try {
    await ctx.editMessageText(
      ctx.i18n.t('spam.admin_override', { admin: adminName, name: bannedUserName }),
      { parse_mode: 'HTML' }
    )
  } catch (error) {
    log.warn({ err: error.message }, 'Admin override: failed to edit notification')
  }

  // 7. Schedule deletion of updated notification (30s)
  if (ctx.callbackQuery.message && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId,
      messageId: ctx.callbackQuery.message.message_id,
      delayMs: 30000,
      source: 'admin_override'
    }, ctx.telegram)
  }

  return ctx.answerCbQuery('✅')
}

module.exports = {
  handleSpamVoteCallback,
  handleAdminOverride,
  processExpiredVotes,
  checkVoteEligibility,
  processVoteResult
}
