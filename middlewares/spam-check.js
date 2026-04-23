const { sendModEventNotification } = require('../helpers/mod-event-send')
const { withTyping } = require('../helpers/typing')

// Admin cache: Map<chatId, { adminIds: Set<number>, cachedAt: number }>
const adminCache = new Map()
const ADMIN_CACHE_TTL = 60 * 60 * 1000 // 1 hour

const getCachedAdminIds = async (telegram, chatId) => {
  const cached = adminCache.get(chatId)
  if (cached && Date.now() - cached.cachedAt < ADMIN_CACHE_TTL) {
    return cached.adminIds
  }

  const admins = await telegram.getChatAdministrators(chatId)
  const adminIds = new Set(admins.map(a => a.user.id))
  adminCache.set(chatId, { adminIds, cachedAt: Date.now() })
  return adminIds
}

const { userName } = require('../utils')
const { checkSpam, checkTrustedUser, getSpamSettings } = require('../helpers/spam-check')
const { processSpamAction } = require('../helpers/reputation')
const { createVoteEvent, getAccountAgeDays } = require('../helpers/vote-ui')
const { addSignature } = require('../helpers/spam-signatures')
const { getForwardHash } = require('../helpers/velocity')
const { spam: spamLog, spamAction, reputation: repLog, notification: notifyLog } = require('../helpers/logger')
const { logSpamDecision, buildUserSignals } = require('../helpers/spam-signals')
const { snapshotMessage, analyzeEdit } = require('../helpers/edit-diff')
const adminFeedback = require('../helpers/admin-feedback')
const { isSystemSenderId } = require('../helpers/system-senders')
const botPermissions = require('../helpers/bot-permissions')

/**
 * Determine if user should receive full ban (vs temporary mute)
 *
 * Full ban criteria (SAFE - only community-verified):
 * 1. Confirmed signature match (exact/normalized) - pattern verified by 3+ groups
 * 2. Community-confirmed repeat spammer - 2+ spam verdicts decided BY VOTES
 * 3. Restricted reputation status - already heavily penalized (score < 20)
 *
 * NOT triggers for ban (unsafe):
 * - High AI confidence alone
 * - spamDetections counter (includes unverified)
 * - Pending votes or timeout verdicts
 *
 * @returns {Object} { shouldBan: boolean, reason: string }
 */
const shouldFullBan = async (ctx, result, userId) => {
  // Safety net: never full-ban trusted users or established members
  // For channels (negative userId), ctx.session belongs to ctx.from — not the channel itself.
  // Skip session-based reputation for channels to avoid using unrelated user's trust status.
  const isChannel = userId < 0
  const isLocalTrusted = checkTrustedUser(userId, ctx)
  const userReputation = !isChannel ? ctx.session?.userInfo?.reputation : null
  const isGlobalTrusted = userReputation?.status === 'trusted'
  const messageCount = ctx.group?.members?.[userId]?.stats?.messagesCount || 0

  const banExemptReason = isLocalTrusted ? 'local_trusted'
    : isGlobalTrusted ? 'global_trusted'
      : messageCount >= 10 ? 'tenure'
        : null

  if (banExemptReason) {
    spamAction.info({
      userId,
      messageCount,
      source: result.source,
      reason: banExemptReason
    }, 'Skipping full ban for exempt user')
    return { shouldBan: false, reason: null }
  }

  // 1. Confirmed signature match = instant ban
  // These patterns were verified by 3+ different groups
  if (result.source && (
    result.source === 'spam_signature_exact' ||
    result.source === 'spam_signature_normalized'
  )) {
    return {
      shouldBan: true,
      reason: 'confirmed_signature'
    }
  }

  // 2. Community-confirmed repeat spammer
  // Only count verdicts decided BY VOTES (not timeout, not pending)
  if (ctx.db?.SpamVote) {
    try {
      const confirmedSpamVerdicts = await ctx.db.SpamVote.countDocuments({
        bannedUserId: userId,
        result: 'spam',
        resolvedBy: 'votes' // Community decided, not timeout
      })

      if (confirmedSpamVerdicts >= 2) {
        return {
          shouldBan: true,
          reason: 'community_confirmed_spammer'
        }
      }
    } catch (err) {
      spamAction.warn({ err: err.message }, 'Failed to check spam verdicts')
    }
  }

  // 3. Already restricted by reputation system (score < 20)
  if (userReputation?.status === 'restricted') {
    return {
      shouldBan: true,
      reason: 'restricted_reputation'
    }
  }

  return { shouldBan: false, reason: null }
}

/**
 * Determine appropriate action based on spam confidence and user profile
 */
const determineAction = (result, context, threshold) => {
  if (!result.isSpam || result.confidence < threshold) {
    return { action: 'none' }
  }

  const confidence = result.confidence || 0

  // Very high confidence - immediate mute and delete
  if (confidence >= 85) {
    return {
      action: 'mute_and_delete',
      duration: context.isPremium ? 3600 : 86400, // 1h for premium, 24h for regular
      reason: result.reason
    }
  }

  // High confidence - warn first, then restrict on next offense
  if (confidence >= 80) {
    return {
      action: 'warn_and_restrict',
      duration: context.isPremium ? 1800 : 7200, // 30min for premium, 2h for regular
      reason: result.reason
    }
  }

  // Medium confidence - delete message only, no mute
  if (confidence >= threshold) {
    // For new users with suspicious messages - more aggressive actions
    if (context.messageCount <= 2 && context.isNewAccount) {
      return {
        action: 'warn_and_restrict',
        duration: context.isPremium ? 1800 : 7200,
        reason: result.reason
      }
    }

    return {
      action: 'delete_only',
      reason: result.reason
    }
  }

  return { action: 'none' }
}

/**
 * Extract links from a message text
 */
const extractLinks = (text) => {
  if (!text) return []
  const urlRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(www\.[^\s]+)/gi
  return text.match(urlRegex) || []
}

/**
 * Check if user account is potentially new based on ID
 * Telegram IDs above ~5B are from 2022+
 */
const isLikelyNewAccount = (userId) => userId > 5000000000

/**
 * Format user details string
 */
const formatUserDetails = (user) => {
  if (!user) return ''
  const details = []
  if (user.first_name) details.push(`First name: ${user.first_name}`)
  if (user.last_name) details.push(`Last name: ${user.last_name}`)
  if (user.is_bot) details.push('Is bot')
  return details.join(', ')
}

/**
 * Spam check middleware using hybrid ML approach
 */
module.exports = async (ctx) => {
  // Handle both new messages and edited messages
  // Edited messages can be used to bypass spam detection (send clean, edit to spam)
  // Note: ctx.message is normalized in spamCheckOrchestrator (bot.js) so
  // ctx.message is always set, even for edits
  const isEditedMessage = !!ctx.editedMessage
  const message = ctx.message

  // Skip if not in a group chat or no user
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type) || !ctx.from) {
    return
  }

  // Skip if no group context or member data
  if (!ctx.group || !ctx.group.members) {
    return
  }

  // Get the actual sender ID and info
  // Prefer sender_chat only if it has a valid id, otherwise use ctx.from
  const senderChat = message && message.sender_chat
  const hasSenderChat = senderChat && senderChat.id
  const senderId = hasSenderChat ? senderChat.id : ctx.from.id
  const senderInfo = hasSenderChat ? senderChat : ctx.from

  // Check if spam check is enabled for this group
  const spamSettings = getSpamSettings(ctx)
  if (!spamSettings || spamSettings.enabled === false) {
    return false
  }

  // TEST MODE: Only via environment variable (not user-controllable)
  const isTestMode = process.env.SPAM_TEST_MODE === 'true'

  if (isTestMode) {
    spamLog.info('TEST MODE ENABLED - Bypassing all safety checks')
  }

  // Skip if message is a command (except in test mode)
  if (!isTestMode && message && message.text && message.text.startsWith('/')) {
    return
  }

  // Skip Telegram system senders (777000 "Telegram" service account,
  // 1087968824 Group Anonymous Bot, 136817688 Channel Bot). These are
  // Bot API placeholders — the authoritative identity is in sender_chat,
  // already handled above.
  if (!isTestMode && !hasSenderChat && isSystemSenderId(senderId)) {
    spamLog.debug({ senderId }, 'Skipping Telegram system sender')
    return
  }

  // Skip anonymous admins (posting as the group itself)
  // Note: When admin posts anonymously, sender_chat.id === chat.id
  if (!isTestMode && hasSenderChat && senderChat.id === ctx.chat.id) {
    spamLog.debug({ chatId: ctx.chat.id, chatTitle: ctx.chat.title }, 'Skipping anonymous admin')
    return
  }

  // Skip linked channel (the channel attached to this group for discussions)
  // Check both: is_automatic_forward (reliable) and cached linked_chat_id (fallback)
  if (!isTestMode && hasSenderChat) {
    const isAutoForward = message && message.is_automatic_forward
    const linkedChatId = ctx.group && ctx.group.info && ctx.group.info.linked_chat_id

    if (isAutoForward || (linkedChatId && senderChat.id === linkedChatId)) {
      spamLog.debug({ channelId: senderChat.id, channelTitle: senderChat.title, isAutoForward }, 'Skipping linked channel')
      return
    }
  }

  // Check if this is a channel post (will be spam-checked, not skipped)
  const isChannelPost = hasSenderChat && senderChat.type === 'channel'
  if (isChannelPost) {
    spamLog.debug({ channelTitle: senderChat.title || senderId }, 'Checking channel')
  }

  // Only check actual user content (whitelist approach)
  const hasUserContent = message && (
    message.text ||
    message.caption ||
    message.photo ||
    message.video ||
    message.document ||
    message.audio ||
    message.voice ||
    message.video_note ||
    message.sticker ||
    message.animation
  )

  if (!hasUserContent) {
    return
  }

  // Unified trust check: local trusted list OR global reputation 'trusted'
  // For channel posts, ctx.from is a fake user — don't use its session/reputation
  const userReputation = !isChannelPost && ctx.session && ctx.session.userInfo && ctx.session.userInfo.reputation
  const isLocalTrusted = checkTrustedUser(senderId, ctx)
  const isGlobalTrusted = userReputation && userReputation.status === 'trusted'

  if (!isTestMode && (isLocalTrusted || isGlobalTrusted)) {
    const trustSource = isLocalTrusted ? 'local_list' : 'global_reputation'
    spamLog.debug({
      userId: senderId,
      userName: userName(senderInfo),
      trustSource,
      score: userReputation ? userReputation.score : 'N/A'
    }, 'Skipping trusted user')
    return
  }

  // Dynamic check limit based on global reputation
  let checkLimit = 5 // default for neutral/unknown users
  if (userReputation) {
    if (userReputation.status === 'restricted') {
      checkLimit = Infinity // always check restricted users
    } else if (userReputation.status === 'suspicious') {
      checkLimit = 20 // check suspicious users longer
    } else if (userReputation.status === 'neutral' && userReputation.score < 60) {
      checkLimit = 10 // slightly more checks for low-neutral users
    }
  }

  // Check number of messages from the user (or force check in test mode)
  // For channel posts, always check (no member history to base decision on)
  const messageCount = (ctx.group.members[senderId] && ctx.group.members[senderId].stats && ctx.group.members[senderId].stats.messagesCount) || 0
  // Edited messages follow the same messageCount rules as regular messages
  const shouldCheckSpam = isTestMode || isChannelPost || messageCount <= checkLimit

  // Log when using non-default check limit
  if (checkLimit !== 5 && shouldCheckSpam && !isChannelPost) {
    const repStatus = userReputation ? userReputation.status : 'unknown'
    const repScore = userReputation ? userReputation.score : 'N/A'
    spamLog.debug({ repStatus, repScore, checkLimit: checkLimit === Infinity ? 'unlimited' : checkLimit, messageCount }, 'Extended check for user')
  }

  // Check spam for:
  // 1. Users with member data (tracked group members)
  // 2. Channel posts (always check)
  // 3. Users WITHOUT member data (commenters, non-members) - important for discussion groups!
  const hasMemberData = ctx.group && ctx.group.members && ctx.group.members[senderId] && ctx.group.members[senderId].stats
  const isNonMember = !hasMemberData && !isChannelPost

  // Log non-member/commenter check
  if (isNonMember && shouldCheckSpam) {
    const isTopicMessage = message && message.is_topic_message
    spamLog.debug({
      userId: senderId,
      userName: userName(senderInfo),
      isTopicMessage: !!isTopicMessage
    }, 'Checking non-member/commenter')
  }

  // Non-members (commenters) should always be checked - they're unknown users
  if ((hasMemberData || isChannelPost || isNonMember) && shouldCheckSpam) {
    // Skip if user is an administrator (except in test mode)
    // Note: Skip admin check for channel posts (senderId is negative channel ID)
    if (!isTestMode && !isChannelPost) {
      try {
        const adminIds = await getCachedAdminIds(ctx.telegram, ctx.chat.id)
        if (adminIds.has(senderId)) {
          spamLog.debug({ userId: senderId, userName: userName(senderInfo) }, 'Skipping admin')
          return
        }
      } catch (error) {
        // When admin check fails, always skip spam check to avoid false positives.
        // Transient API failures should not cause legitimate users to be flagged.
        spamLog.warn({ userId: senderId, err: error.message }, 'Admin check failed — skipping spam check')
        return
      }
    } else if (isTestMode) {
      spamLog.debug({ userId: senderId, userName: userName(senderInfo) }, 'TEST MODE - Bypassing admin check')
    }

    // Check message for spam
    if (message) {
      const originalText = message.text || message.caption || ''
      let messageText = originalText.trim()

      // Handle messages without text/caption
      // IMPORTANT: Include file_unique_id to prevent all media of same type
      // from being treated as identical (which would cause false spam detection)
      if (!messageText) {
        if (message.sticker) {
          messageText = `[Sticker: ${message.sticker.file_unique_id}]`
        } else if (message.animation) {
          messageText = `[Animation: ${message.animation.file_unique_id}]`
        } else if (message.video) {
          messageText = `[Video: ${message.video.file_unique_id}]`
        } else if (message.video_note) {
          messageText = `[VideoNote: ${message.video_note.file_unique_id}]`
        } else if (message.voice) {
          messageText = `[Voice: ${message.voice.file_unique_id}]`
        } else if (message.audio) {
          messageText = `[Audio: ${message.audio.file_unique_id}]`
        } else if (message.photo) {
          const photo = message.photo[message.photo.length - 1]
          messageText = `[Photo: ${photo.file_unique_id}]`
        } else if (message.document) {
          messageText = `[Document: ${message.document.file_unique_id}]`
        } else {
          messageText = '[Media message]'
        }
      }

      const actualMessageCount = hasMemberData ? ctx.group.members[senderId].stats.messagesCount : 0
      const senderType = isChannelPost ? 'channel' : (isNonMember ? 'non-member' : 'user')
      spamLog.info({
        senderType,
        userName: userName(senderInfo),
        userId: senderId,
        messageCount: isTestMode ? 'TEST' : actualMessageCount,
        isEdited: isEditedMessage || undefined // Only log if true
      }, isEditedMessage ? 'Checking EDITED message' : 'Checking message')

      // Build context for spam check
      const isTopicMessage = message && message.is_topic_message
      const context = {
        userId: senderId,
        groupName: ctx.chat.title,
        userName: userName(senderInfo),
        userDetails: formatUserDetails(senderInfo),
        languageCode: senderInfo.language_code,
        isPremium: isTestMode ? false : senderInfo.is_premium, // Ignore premium in test mode
        isNewAccount: isTestMode ? true : isLikelyNewAccount(senderId), // Force new account in test mode
        username: senderInfo.username,
        messageCount: isTestMode ? 1 : actualMessageCount, // Force first message in test mode
        links: extractLinks(messageText),
        isTestMode: isTestMode,
        isChannelPost: isChannelPost, // Channel posts are higher risk - no user history
        channelTitle: isChannelPost ? senderInfo.title : null,
        // Non-member context (commenters in discussion groups)
        isNonMember: isNonMember,
        isTopicMessage: !!isTopicMessage,
        // Edited messages - could be spam added after initial clean message
        isEditedMessage: isEditedMessage
      }

      // Edit-to-inject detector: compare the current text to the last
      // snapshot we saw for this (chatId, messageId). On a fresh message,
      // record the snapshot; on an edit, compute the delta.
      // The resulting `edit_injected_promo` signal is folded into
      // ctx for the LLM / deterministic layers via spam-check internals.
      if (isEditedMessage && ctx.message?.message_id && ctx.chat?.id) {
        try {
          const delta = analyzeEdit(ctx.chat.id, ctx.message.message_id, messageText)
          if (delta && delta.injected) {
            ctx._editInjectionDelta = delta
          }
        } catch (_err) { /* non-fatal */ }
      } else if (!isEditedMessage && ctx.message?.message_id && ctx.chat?.id) {
        try { snapshotMessage(ctx.chat.id, ctx.message.message_id, messageText) } catch (_err) { /* non-fatal */ }
      }

      // No-permissions early exit:
      //   If the bot has neither restrict nor delete rights in this chat,
      //   any verdict below would be unactionable ("No restrict permission"
      //   / "Cannot delete - no permission" in logs). Skip the heavy
      //   Qdrant / LLM pipeline entirely — the orchestrator has already
      //   run the ban-database lookup upstream, which is the only
      //   enforcement path available to us here.
      //
      //   Resolver caches perms from my_chat_member events (zero calls
      //   after the first one in each chat); lazy-fetches via
      //   getChatMember on cold start. Returns null on API failure,
      //   in which case we fall through to the full pipeline to be safe.
      const botPerms = await botPermissions.resolve(ctx.telegram, ctx.chat.id, ctx.botInfo && ctx.botInfo.id)
      if (botPerms && !botPerms.canAct) {
        spamLog.debug({ chatId: ctx.chat.id, chatTitle: ctx.chat.title }, 'Skipping spam-check: bot has no restrict/delete rights')
        return false
      }

      // Wrap the full-pipeline check in a typing indicator. Only the LLM
      // leg is actually slow (2–8 s) but the indicator is effectively
      // free — callApi failures silently drop inside withTyping/
      // reactions helpers.
      let result
      try {
        result = await withTyping(ctx, () => checkSpam(messageText, ctx, spamSettings))
      } catch (error) {
        spamLog.error({ userId: senderId, userName: userName(senderInfo), err: error.message }, 'Check failed')
        return false
      }

      // Handle null/undefined result (e.g., empty LLM response)
      if (!result) {
        spamLog.warn({ userId: senderId, userName: userName(senderInfo) }, 'No result - treating as clean')
        return false
      }

      // Log result with quick assessment info if available
      const logData = {
        isSpam: result.isSpam,
        confidence: result.confidence,
        source: result.source
      }

      // Include quick assessment in log if present
      if (result.quickAssessment) {
        logData.quickRisk = result.quickAssessment.risk
        if (result.quickAssessment.signals && result.quickAssessment.signals.length > 0) {
          logData.quickSignals = result.quickAssessment.signals
        }
        if (result.quickAssessment.trustSignals && result.quickAssessment.trustSignals.length > 0) {
          logData.trustSignals = result.quickAssessment.trustSignals
        }
      }

      spamLog.info(logData, result.isSpam ? 'SPAM detected' : 'CLEAN')

      // Unified decision log — single line per message, machine-parseable.
      // Pasting these from production lets us reconstruct any false positive
      // without rerunning the bot. Text snippet (first 120 chars) is included
      // so debug analysis can correlate the verdict with what was actually said.
      const textSnippet = (messageText || '').substring(0, 120)
      // Surface network-level detector state alongside the user signals so
      // logs tell the whole story: "why did this trigger?" is answerable
      // from a single spam.decision line without needing parallel grep.
      const netExtras = {}
      if (result.quickAssessment?.mediaFingerprint) {
        netExtras.mediaFingerprint = {
          mediaType: result.quickAssessment.mediaFingerprint.mediaType,
          occurrences: result.quickAssessment.mediaFingerprint.occurrences,
          uniqueChats: result.quickAssessment.mediaFingerprint.uniqueChats,
          uniqueUsers: result.quickAssessment.mediaFingerprint.uniqueUsers,
          velocityExceeded: result.quickAssessment.mediaFingerprint.velocityExceeded
        }
      }
      if (result.quickAssessment?.chatBurst) {
        netExtras.chatBurst = {
          burstSize: result.quickAssessment.chatBurst.burstSize,
          windowMs: result.quickAssessment.chatBurst.windowMs
        }
      }
      if (result.quickAssessment?.customEmojiCluster) {
        netExtras.customEmojiCluster = result.quickAssessment.customEmojiCluster
      }
      logSpamDecision({
        phase: 'final',
        decision: result.isSpam ? 'spam' : 'clean',
        confidence: result.confidence,
        reason: result.reason,
        chatId: ctx.chat?.id,
        userId: senderId,
        messageId: ctx.message?.message_id,
        signals: result.quickAssessment?.signals,
        trustSignals: result.quickAssessment?.trustSignals,
        userSignals: !isChannelPost ? buildUserSignals(ctx.session?.userInfo, ctx.from) : null,
        extras: {
          source: result.source,
          editedMessage: isEditedMessage,
          textSnippet,
          textLen: (messageText || '').length,
          ...netExtras
        }
      })

      if (isTestMode) {
        spamLog.info({
          text: messageText.substring(0, 100),
          classification: result.isSpam ? 'SPAM' : 'CLEAN',
          confidence: result.confidence,
          source: result.source,
          reason: result.reason
        }, 'TEST MODE - Details')
      }

      // Use dynamic confidence threshold and determine action
      const baseThreshold = spamSettings.confidenceThreshold || 70
      const action = determineAction(result, context, baseThreshold)

      if (action.action !== 'none') {
        const userDisplayName = context.userName
        const userId = context.userId
        const shortMessage = messageText.substring(0, 150)
        const displayMessage = messageText.length > 150 ? `${shortMessage}...` : shortMessage

        spamAction.warn({
          userId,
          userName: userDisplayName,
          action: action.action,
          source: result.source,
          message: displayMessage,
          reason: action.reason,
          confidence: result.confidence
        }, 'Taking action')

        // Register this auto-action in the admin-feedback buffer so that
        // if an admin later clicks "Not Spam" we can attribute the false
        // positive to the exact rule/source that fired here.
        try {
          adminFeedback.recordAction(ctx.chat.id, userId, {
            source: result.source,
            rule: (result.source && result.source.includes(':'))
              ? result.source.split(':').slice(1).join(':')
              : null,
            confidence: result.confidence,
            reason: action.reason
          })
        } catch (_err) { /* non-fatal */ }

        // Get mute duration from action or default
        const muteDuration = action.duration || (senderInfo.is_premium ? 3600 : 86400)

        let muteSuccess = false
        let deleteSuccess = false

        // Read bot permissions from the cache populated earlier in this
        // same request by the resolve() call in the no-perms early exit
        // above. Falls back to a fresh fetch only if the cache is somehow
        // empty (stale-ttl eviction between the two reads is unlikely
        // but not impossible).
        let canRestrictMembers = false
        let canDeleteMessages = false
        const cachedPerms = botPermissions.get(ctx.chat.id) ||
          await botPermissions.resolve(ctx.telegram, ctx.chat.id, ctx.botInfo && ctx.botInfo.id)
        if (cachedPerms) {
          canRestrictMembers = cachedPerms.canRestrict
          canDeleteMessages = cachedPerms.canDelete
        } else {
          spamAction.error({ chatId: ctx.chat.id }, 'Failed to resolve bot permissions')
        }

        // Handle mute/restrict action
        let fullBanApplied = false
        if (action.action === 'mute_and_delete' || action.action === 'warn_and_restrict') {
          if (canRestrictMembers) {
            try {
              if (isChannelPost) {
                // For channels: banChatSenderChat doesn't support until_date,
                // so only ban on confirmed spam (signature/community votes).
                // Otherwise just delete the message and let community vote.
                const banDecision = await shouldFullBan(ctx, result, senderId)
                if (banDecision.shouldBan) {
                  await ctx.telegram.callApi('banChatSenderChat', {
                    chat_id: ctx.chat.id,
                    sender_chat_id: senderId
                  })
                  muteSuccess = true
                  fullBanApplied = true
                  spamAction.info({ channelTitle: senderInfo.title, reason: banDecision.reason }, 'Banned channel')
                } else {
                  // No temporary restriction available for channels — delete only
                  spamAction.info({ channelTitle: senderInfo.title }, 'Channel spam detected — delete only, awaiting vote')
                }
              } else {
                // Check if user deserves full ban (vs temporary mute)
                const banDecision = await shouldFullBan(ctx, result, senderId)

                if (banDecision.shouldBan) {
                  // Full ban with message revocation
                  await ctx.telegram.callApi('banChatMember', {
                    chat_id: ctx.chat.id,
                    user_id: senderId,
                    revoke_messages: true
                  })
                  muteSuccess = true
                  fullBanApplied = true
                  spamAction.warn({
                    userName: userDisplayName,
                    reason: banDecision.reason
                  }, 'Full ban applied (messages revoked)')
                } else {
                  // Temporary mute
                  await ctx.telegram.restrictChatMember(ctx.chat.id, senderId, {
                    can_send_messages: false,
                    can_send_media_messages: false,
                    can_send_other_messages: false,
                    can_add_web_page_previews: false,
                    until_date: Math.floor(Date.now() / 1000) + muteDuration
                  })
                  muteSuccess = true
                  spamAction.info({ userName: userDisplayName, muteDuration }, 'Muted user')
                }
              }
            } catch (error) {
              spamAction.error({ err: error.message, userName: userDisplayName, action: isChannelPost ? 'ban' : 'mute' }, 'Action failed')
            }
          } else {
            spamAction.warn({ chatTitle: ctx.chat.title }, 'No restrict permission')
          }
        }

        // Handle delete action - always try to delete spam, even without restrict permission
        // It's better to at least remove the spam message even if we can't ban the user.
        // For albums (media_group_id) we delete EVERY sibling — otherwise the
        // caption message disappears but the 4 companion photos remain visible.
        if (action.action === 'mute_and_delete' || action.action === 'delete_only' || action.action === 'warn_and_restrict') {
          const albumIds = Array.isArray(ctx.mediaGroupIds) && ctx.mediaGroupIds.length > 0
            ? ctx.mediaGroupIds
            : [ctx.message.message_id]
          const results = await Promise.all(albumIds.map(async (mid) => {
            try {
              await ctx.telegram.deleteMessage(ctx.chat.id, mid)
              return { mid, ok: true }
            } catch (error) {
              return { mid, ok: false, err: error.message }
            }
          }))
          const ok = results.filter(r => r.ok).length
          deleteSuccess = ok > 0
          if (ok === albumIds.length) {
            spamAction.info({ userName: userDisplayName, deleted: ok, albumSize: albumIds.length }, 'Deleted message')
          } else if (ok > 0) {
            spamAction.warn({ userName: userDisplayName, deleted: ok, albumSize: albumIds.length, failures: results.filter(r => !r.ok) }, 'Partially deleted album')
          } else {
            const err = results[0] && results[0].err
            if (canDeleteMessages) {
              spamAction.error({ err, userName: userDisplayName, userId, albumSize: albumIds.length }, 'Failed to delete message')
            } else {
              spamAction.warn({ err, chatTitle: ctx.chat.title, albumSize: albumIds.length }, 'Cannot delete - no permission')
            }
          }
        }

        // Update global reputation stats and apply global ban if needed
        if (!isChannelPost && ctx.session && ctx.session.userInfo) {
          const spamResult = processSpamAction(ctx.session.userInfo, {
            userId: senderId,
            messageDeleted: deleteSuccess,
            confidence: result.confidence,
            reason: result.reason || 'AI-detected spam',
            muteSuccess: muteSuccess,
            globalBanEnabled: spamSettings.globalBan !== false
          })

          if (spamResult.statsUpdated) {
            repLog.debug({
              spamDetections: ctx.session.userInfo.globalStats.spamDetections,
              newScore: spamResult.newReputation ? spamResult.newReputation.score : 'N/A'
            }, 'Updated spam stats')
          }

          if (spamResult.globalBanApplied) {
            spamAction.warn({
              userId: senderId,
              userName: userDisplayName,
              reason: result.reason,
              confidence: result.confidence
            }, 'Global ban applied')
          }
        }

        // Vectors for 70-85% confidence LLM results are NOT saved here.
        // They are only saved after community vote confirms spam (in handlers/spam-vote.js)
        // to prevent a feedback loop of uncertain classifications reinforcing themselves.

        // Create vote event for community moderation (only for uncertain cases)
        // High confidence (>=85%) = no voting needed, instant action
        const needsVoting = result.confidence < 85

        if ((muteSuccess || deleteSuccess) && needsVoting) {
          try {
            // Extract forward origin info for ForwardBlacklist tracking
            const msgForwardOrigin = message && message.forward_origin
            const forwardInfo = msgForwardOrigin ? getForwardHash(msgForwardOrigin) : null

            const voteEvent = await createVoteEvent(ctx, {
              result,
              actionTaken: {
                muteSuccess,
                deleteSuccess,
                muteDuration,
                fullBanApplied
              },
              messageText,
              forwardOrigin: forwardInfo, // For ForwardBlacklist tracking
              userContext: {
                reputationScore: ctx.session?.userInfo?.reputation?.score,
                reputationStatus: ctx.session?.userInfo?.reputation?.status,
                accountAgeDays: getAccountAgeDays(senderId),
                messagesInGroup: actualMessageCount,
                groupsActive: ctx.session?.userInfo?.globalStats?.groupsActive || 0,
                signals: result.quickAssessment?.signals || []
              }
            })
            if (!voteEvent) {
              notifyLog.warn('Vote event creation returned null - missing sender info')
            }
          } catch (voteError) {
            notifyLog.error({ err: voteError.message }, 'Failed to create vote event')
          }
        } else if ((muteSuccess || deleteSuccess) && !needsVoting) {
          // High confidence — unified compact notification (§9).
          // The actionType differentiates: full ban → auto_ban, mute-only
          // → auto_mute, delete-only → auto_delete. Spec § table maps these
          // to distinct one-liners.
          const actionType = fullBanApplied ? 'auto_ban'
            : muteSuccess ? 'auto_mute'
              : 'auto_delete'
          await sendModEventNotification(ctx, {
            actionType,
            targetUser: {
              id: senderId,
              first_name: senderInfo.first_name,
              username: senderInfo.username,
              title: isChannelPost ? senderInfo.title : undefined,
              isChannel: isChannelPost
            },
            reason: result.reason,
            confidence: result.confidence,
            messagePreview: messageText,
            warning: (!deleteSuccess && (muteSuccess || fullBanApplied))
              ? 'could not delete message' : undefined
          })

          // Add to signature database for high-confidence cases
          if (ctx.db) {
            addSignature(messageText, ctx.db, ctx.chat.id).catch(e =>
              notifyLog.error({ err: e.message }, 'Failed to add signature for high-confidence spam')
            )
          }

          notifyLog.info({ confidence: result.confidence, source: result.source }, 'High confidence spam - no voting')
        } else if (!muteSuccess && !deleteSuccess) {
          // Bot detected spam but has no permissions to act — emit a
          // `no_permissions` compact notification. Expanded view surfaces
          // confidence + reason; the [📖 Дай права] button points admins
          // at the permission instructions.
          notifyLog.warn('Spam detected but no permissions to act')
          await sendModEventNotification(ctx, {
            actionType: 'no_permissions',
            targetUser: {
              id: senderId,
              first_name: senderInfo.first_name,
              username: senderInfo.username,
              title: isChannelPost ? senderInfo.title : undefined,
              isChannel: isChannelPost
            },
            reason: result.reason,
            confidence: result.confidence,
            messagePreview: messageText
          })
        }

        return true // Stop further processing
      } else if (!result.isSpam) {
        // Message confirmed clean — count for reputation. Counting was too
        // strict before: only LLM "not spam" verdicts incremented this, so
        // users whose messages reached deterministic-clean / vector-clean /
        // moderation-clean exits never built trusted status, blocking them
        // from the trusted-bypass path. Now we count ANY non-spam result.
        if (ctx.session && ctx.session.userInfo && !isChannelPost) {
          const stats = ctx.session.userInfo.globalStats || (ctx.session.userInfo.globalStats = {})
          stats.cleanMessages = (stats.cleanMessages || 0) + 1

          // Force reputation recalc on every 10th clean msg so trusted status
          // becomes attainable for active users via legitimate activity.
          if (stats.cleanMessages % 10 === 0 && ctx.session.userInfo.reputation) {
            ctx.session.userInfo.reputation.lastCalculated = null
          }
        }
      }
    }
  }

  return false // Continue processing
}
