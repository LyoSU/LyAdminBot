const { userName } = require('../utils')
const { predictCreationDate } = require('./account-age')
const { sha256, normalizeLight } = require('./spam-signatures')
const { spamVote: log } = require('./logger')
const { scheduleDeletion } = require('./message-cleanup')
const { humanizeReason } = require('./spam-check')

/**
 * Generate hash of message text (for SpamVote reference)
 */
const getExactHash = (text) => {
  if (!text) return null
  return sha256(normalizeLight(text))
}

/**
 * Estimate account age in days from user ID
 */
const getAccountAgeDays = (userId) => {
  const [, creationDate] = predictCreationDate(userId)
  const now = new Date()
  return Math.floor((now - creationDate) / (1000 * 60 * 60 * 24))
}

/**
 * Format account age for display (language-agnostic short format)
 */
const formatAccountAge = (days) => {
  if (days < 1) return '< 1d'
  if (days < 7) return `~${days}d`
  if (days < 30) return `~${Math.floor(days / 7)}w`
  if (days < 365) return `~${Math.floor(days / 30)}mo`
  return `~${Math.floor(days / 365)}y`
}

/**
 * Format quick assessment signals
 */
const formatSignals = (signals) => {
  if (!signals || signals.length === 0) return ''
  return signals.slice(0, 3).map(s => s.replace(/_/g, ' ')).join(', ')
}

/**
 * Build inline keyboard for voting
 */
const buildVoteKeyboard = (eventId, voteTally, i18n) => {
  const spamLabel = `${i18n.t('spam_vote.btn_spam')} · ${voteTally.spamCount}`
  const cleanLabel = `${i18n.t('spam_vote.btn_clean')} · ${voteTally.cleanCount}`

  return {
    inline_keyboard: [[
      { text: spamLabel, callback_data: `sv:${eventId}:spam` },
      { text: cleanLabel, callback_data: `sv:${eventId}:clean` }
    ]]
  }
}

/**
 * Calculate remaining time for voting
 */
const getRemainingTime = (expiresAt) => {
  const remaining = new Date(expiresAt) - new Date()
  if (remaining <= 0) return '0:00'
  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Escape HTML special characters
 */
const escapeHtml = (text) => {
  if (!text) return ''
  return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Sanitize message preview - remove/mask sensitive info
 * Hides: @mentions, URLs, emails, phone numbers, crypto addresses
 */
const sanitizePreview = (text) => {
  if (!text) return ''
  return String(text)
    // @username mentions
    .replace(/@[\w]{3,}/g, '@***')
    // t.me links
    .replace(/t\.me\/[\w+]+/gi, 't.me/***')
    // URLs (http/https)
    .replace(/https?:\/\/[^\s]+/gi, '[link]')
    // Emails
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '***@***')
    // Phone numbers (various formats)
    .replace(/\+?\d[\d\s\-()]{8,}\d/g, '[phone]')
    // Crypto addresses (BTC, ETH-like)
    .replace(/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, '[crypto]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, '[crypto]')
    // TON addresses
    .replace(/\b(EQ|UQ)[A-Za-z0-9_-]{46,48}\b/g, '[crypto]')
    // Telegram channel/bot names in text
    .replace(/(?:канал|channel|бот|bot)[\s:]*@?[\w]+/gi, '[channel]')
}

/**
 * Build voting notification text
 */
const buildVoteNotification = (spamVote, i18n) => {
  const {
    bannedUserName,
    bannedUserUsername,
    userContext,
    aiConfidence,
    aiReason,
    messagePreview,
    expiresAt,
    voters,
    voteTally,
    actionTaken
  } = spamVote

  const lines = []

  // Title - different for ban vs mute
  const titleKey = actionTaken?.banned ? 'spam_vote.title_banned' : 'spam_vote.title_blocked'
  lines.push(i18n.t(titleKey))
  lines.push('')

  // User info
  const userDisplay = bannedUserUsername
    ? `${escapeHtml(bannedUserName)} @${bannedUserUsername}`
    : escapeHtml(bannedUserName)
  lines.push(i18n.t('spam_vote.user_info', { name: userDisplay }))

  // User context
  if (userContext.reputationScore !== undefined) {
    lines.push(i18n.t('spam_vote.reputation', { score: userContext.reputationScore }))
  }

  if (userContext.accountAgeDays !== undefined) {
    lines.push(i18n.t('spam_vote.account_age', { age: formatAccountAge(userContext.accountAgeDays) }))
  }

  if (userContext.messagesInGroup > 0) {
    let msgLine = i18n.t('spam_vote.messages', { count: userContext.messagesInGroup })
    if (userContext.groupsActive > 1) {
      msgLine += ' ' + i18n.t('spam_vote.in_groups', { count: userContext.groupsActive })
    }
    lines.push(msgLine)
  }

  if (userContext.signals && userContext.signals.length > 0) {
    lines.push(i18n.t('spam_vote.signals', { signals: formatSignals(userContext.signals) }))
  }

  lines.push('')

  // AI reason (humanized for users)
  lines.push(i18n.t('spam_vote.ai_reason', {
    confidence: aiConfidence,
    reason: humanizeReason(aiReason, i18n)
  }))

  // Message preview
  if (messagePreview) {
    const sanitized = sanitizePreview(messagePreview)
    const preview = sanitized.length > 80
      ? sanitized.substring(0, 80) + '...'
      : sanitized
    lines.push(i18n.t('spam_vote.message_preview', { text: escapeHtml(preview) }))
  }

  lines.push('')

  // Voting time
  lines.push(i18n.t('spam_vote.vote_time', { time: getRemainingTime(expiresAt) }))

  // Voters lists
  const spamVoters = voters.filter(v => v.vote === 'spam')
  const cleanVoters = voters.filter(v => v.vote === 'clean')

  if (spamVoters.length > 0) {
    lines.push('')
    lines.push(i18n.t('spam_vote.voters_spam', { count: voteTally.spamWeighted }))
    spamVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  }

  if (cleanVoters.length > 0) {
    lines.push('')
    lines.push(i18n.t('spam_vote.voters_clean', { count: voteTally.cleanWeighted }))
    cleanVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  }

  return {
    text: lines.join('\n'),
    keyboard: buildVoteKeyboard(spamVote.eventId, voteTally, i18n)
  }
}

/**
 * Get easter egg for vote result based on voting pattern
 */
const getVoteEasterEgg = (spamVote, i18n) => {
  const { voteTally, voters, createdAt, resolvedAt } = spamVote
  const totalVotes = voters.length

  // No votes = no easter egg
  if (totalVotes === 0) return null

  // Unanimous decision (all votes same direction)
  const spamVotes = voters.filter(v => v.vote === 'spam').length
  const cleanVotes = voters.filter(v => v.vote === 'clean').length

  if (totalVotes >= 2 && (spamVotes === 0 || cleanVotes === 0)) {
    const key = spamVotes > 0 ? 'spam_vote.result_unanimous_spam' : 'spam_vote.result_unanimous_clean'
    const text = i18n.t(key)
    if (text !== key) return text
  }

  // Close call (difference of 1 weighted vote)
  const diff = Math.abs(voteTally.spamWeighted - voteTally.cleanWeighted)
  if (diff <= 1 && totalVotes >= 2) {
    const text = i18n.t('spam_vote.result_close_call')
    if (text !== 'spam_vote.result_close_call') return text
  }

  // Fast decision (< 30 seconds)
  if (resolvedAt && createdAt) {
    const timeDiff = new Date(resolvedAt) - new Date(createdAt)
    if (timeDiff < 30000 && totalVotes >= 1) {
      const text = i18n.t('spam_vote.result_fast')
      if (text !== 'spam_vote.result_fast') return text
    }
  }

  // Solo hero (single voter decided)
  if (totalVotes === 1) {
    const text = i18n.t('spam_vote.result_solo_hero')
    if (text !== 'spam_vote.result_solo_hero') return text
  }

  // Landslide (3x difference)
  if (diff >= 6 && totalVotes >= 3) {
    const text = i18n.t('spam_vote.result_landslide')
    if (text !== 'spam_vote.result_landslide') return text
  }

  return null
}

/**
 * Build result notification (spam confirmed)
 */
const buildSpamResultNotification = (spamVote, i18n, reputationChange = null) => {
  const {
    bannedUserName,
    bannedUserUsername,
    voters,
    voteTally
  } = spamVote

  const lines = []

  // Title
  lines.push(i18n.t('spam_vote.title_spam'))

  // Easter egg
  const easterEgg = getVoteEasterEgg(spamVote, i18n)
  if (easterEgg) {
    lines.push(easterEgg)
  }

  lines.push('')

  // User info
  const userDisplay = bannedUserUsername
    ? `${escapeHtml(bannedUserName)} @${bannedUserUsername}`
    : escapeHtml(bannedUserName)
  lines.push(i18n.t('spam_vote.user_info', { name: userDisplay }))

  // Reputation change
  if (reputationChange) {
    lines.push(i18n.t('spam_vote.reputation_change', {
      oldScore: reputationChange.oldScore,
      newScore: reputationChange.newScore
    }))
  }
  lines.push(i18n.t('spam_vote.added_to_signatures'))

  lines.push('')

  // Voters
  const spamVoters = voters.filter(v => v.vote === 'spam')
  const cleanVoters = voters.filter(v => v.vote === 'clean')

  lines.push(i18n.t('spam_vote.voters_spam', { count: voteTally.spamWeighted }))
  if (spamVoters.length > 0) {
    spamVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  } else {
    lines.push(i18n.t('spam_vote.voters_empty'))
  }

  lines.push('')
  lines.push(i18n.t('spam_vote.voters_clean', { count: voteTally.cleanWeighted }))
  if (cleanVoters.length > 0) {
    cleanVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  } else {
    lines.push(i18n.t('spam_vote.voters_empty'))
  }

  lines.push('')
  lines.push(i18n.t('spam_vote.result', {
    spam: voteTally.spamWeighted,
    clean: voteTally.cleanWeighted
  }))

  return lines.join('\n')
}

/**
 * Build result notification (unbanned by community)
 */
const buildCleanResultNotification = (spamVote, i18n, reputationChange = null) => {
  const {
    bannedUserName,
    bannedUserUsername,
    voters,
    voteTally
  } = spamVote

  const lines = []

  // Title
  lines.push(i18n.t('spam_vote.title_clean'))

  // Easter egg
  const easterEgg = getVoteEasterEgg(spamVote, i18n)
  if (easterEgg) {
    lines.push(easterEgg)
  }

  lines.push('')

  // User info
  const userDisplay = bannedUserUsername
    ? `${escapeHtml(bannedUserName)} @${bannedUserUsername}`
    : escapeHtml(bannedUserName)
  lines.push(i18n.t('spam_vote.user_info', { name: userDisplay }))

  // Reputation change
  if (reputationChange) {
    lines.push(i18n.t('spam_vote.reputation_change', {
      oldScore: reputationChange.oldScore,
      newScore: reputationChange.newScore
    }) + ' ⭐')
  }
  lines.push(i18n.t('spam_vote.status_trusted'))

  lines.push('')

  // Voters (clean first since they won)
  const cleanVoters = voters.filter(v => v.vote === 'clean')
  const spamVoters = voters.filter(v => v.vote === 'spam')

  lines.push(i18n.t('spam_vote.voters_clean', { count: voteTally.cleanWeighted }))
  if (cleanVoters.length > 0) {
    cleanVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  } else {
    lines.push(i18n.t('spam_vote.voters_empty'))
  }

  lines.push('')
  lines.push(i18n.t('spam_vote.voters_spam', { count: voteTally.spamWeighted }))
  if (spamVoters.length > 0) {
    spamVoters.forEach((v, i) => {
      const name = v.username ? `@${v.username}` : escapeHtml(v.displayName)
      const weight = v.weight > 1 ? ` (×${v.weight})` : ''
      lines.push(i18n.t('spam_vote.voter_line', { index: i + 1, name, weight }))
    })
  } else {
    lines.push(i18n.t('spam_vote.voters_empty'))
  }

  lines.push('')
  lines.push(i18n.t('spam_vote.result', {
    spam: voteTally.spamWeighted,
    clean: voteTally.cleanWeighted
  }))

  return lines.join('\n')
}

/**
 * Create a vote event and send notification
 */
const createVoteEvent = async (ctx, options) => {
  const {
    result,
    actionTaken,
    messageText,
    userContext,
    forwardOrigin // { type, hash, identifier } from getForwardHash
  } = options

  // Get sender info (could be user or channel)
  const message = ctx.message || ctx.editedMessage
  const senderChat = message && message.sender_chat
  const isChannelPost = senderChat && senderChat.type === 'channel'
  const senderInfo = isChannelPost ? senderChat : ctx.from

  // Safety check - ctx.from should always exist for user messages
  if (!senderInfo) {
    log.error('No sender info available for vote event')
    return null
  }

  const bannedUserId = isChannelPost ? senderChat.id : ctx.from.id
  const bannedUserName = userName(senderInfo)
  const bannedUserUsername = isChannelPost ? senderChat.username : ctx.from?.username

  // Create vote document
  const spamVoteDoc = new ctx.db.SpamVote({
    chatId: ctx.chat.id,
    bannedUserId,
    bannedUserName,
    bannedUserUsername,
    userContext: {
      reputationScore: userContext.reputationScore || 50,
      reputationStatus: userContext.reputationStatus || 'neutral',
      accountAgeDays: userContext.accountAgeDays || getAccountAgeDays(bannedUserId),
      messagesInGroup: userContext.messagesInGroup || 0,
      groupsActive: userContext.groupsActive || 0,
      signals: userContext.signals || []
    },
    messageHash: getExactHash(messageText),
    messagePreview: messageText ? messageText.substring(0, 200) : '',
    aiConfidence: result.confidence,
    aiReason: result.reason,
    forwardOrigin: forwardOrigin || null, // { type, hash, identifier } for ForwardBlacklist
    actionTaken: {
      muted: actionTaken.muteSuccess || false,
      deleted: actionTaken.deleteSuccess || false,
      banned: actionTaken.fullBanApplied || false,
      muteDuration: actionTaken.muteDuration
    }
  })

  await spamVoteDoc.save()

  // Build and send notification (NOT as reply)
  const notification = buildVoteNotification(spamVoteDoc, ctx.i18n)

  try {
    const notificationMsg = await ctx.telegram.sendMessage(ctx.chat.id, notification.text, {
      parse_mode: 'HTML',
      reply_markup: notification.keyboard,
      disable_web_page_preview: true
    })

    // Save notification message ID for later updates
    spamVoteDoc.notificationMessageId = notificationMsg.message_id
    spamVoteDoc.notificationChatId = ctx.chat.id
    await spamVoteDoc.save()

    log.info({
      eventId: spamVoteDoc.eventId,
      chatId: ctx.chat.id,
      userId: bannedUserId,
      confidence: result.confidence
    }, 'Created vote event')

    return spamVoteDoc
  } catch (error) {
    log.error({ err: error.message, eventId: spamVoteDoc.eventId }, 'Failed to send vote notification')
    return spamVoteDoc
  }
}

/**
 * Update vote notification UI
 */
const updateVoteUI = async (ctx, spamVote) => {
  if (!spamVote.notificationMessageId || !spamVote.notificationChatId) {
    return
  }

  const notification = buildVoteNotification(spamVote, ctx.i18n)

  try {
    await ctx.telegram.editMessageText(
      spamVote.notificationChatId,
      spamVote.notificationMessageId,
      null,
      notification.text,
      {
        parse_mode: 'HTML',
        reply_markup: notification.keyboard,
        disable_web_page_preview: true
      }
    )
  } catch (error) {
    if (!error.message.includes('message is not modified')) {
      log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to update vote UI')
    }
  }
}

/**
 * Show final result UI
 */
const showResultUI = async (ctx, spamVote, reputationChange = null) => {
  if (!spamVote.notificationMessageId || !spamVote.notificationChatId) {
    return
  }

  // Use ctx.i18n if available, otherwise create a fallback
  const i18n = ctx.i18n || {
    t: (key, params = {}) => {
      // Minimal English fallback for expiration handler
      const fallbacks = {
        'spam_vote.title_spam': '❌ <b>Spam confirmed</b>',
        'spam_vote.title_clean': '↩️ <b>Unblocked</b>',
        'spam_vote.user_info': `👤 ${params.name || ''}`,
        'spam_vote.reputation_change': `📊 ${params.oldScore || ''} → ${params.newScore || ''}`,
        'spam_vote.added_to_signatures': '🔒 Added to spam database',
        'spam_vote.status_trusted': '✨ Now trusted',
        'spam_vote.voters_spam': `🚫 Spam (${params.count || 0}):`,
        'spam_vote.voters_clean': `✓ Clean (${params.count || 0}):`,
        'spam_vote.voters_empty': ' —',
        'spam_vote.voter_line': ` ${params.index || ''}. ${params.name || ''}${params.weight || ''}`,
        'spam_vote.result': `Result: ${params.spam || 0} — ${params.clean || 0}`
      }
      return fallbacks[key] || key
    }
  }

  const text = spamVote.result === 'clean'
    ? buildCleanResultNotification(spamVote, i18n, reputationChange)
    : buildSpamResultNotification(spamVote, i18n, reputationChange)

  try {
    await ctx.telegram.editMessageText(
      spamVote.notificationChatId,
      spamVote.notificationMessageId,
      null,
      text,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }
    )

    // Schedule auto-delete after 2 minutes (persistent)
    if (ctx.db) {
      await scheduleDeletion(ctx.db, {
        chatId: spamVote.notificationChatId,
        messageId: spamVote.notificationMessageId,
        delayMs: 2 * 60 * 1000,
        source: 'vote_result',
        reference: { type: 'spam_vote', id: spamVote.eventId }
      }, ctx.telegram)
      log.debug({ eventId: spamVote.eventId }, 'Scheduled result notification deletion')
    }
  } catch (error) {
    log.error({ err: error.message, eventId: spamVote.eventId }, 'Failed to show result UI')
  }
}

module.exports = {
  getExactHash,
  getAccountAgeDays,
  createVoteEvent,
  updateVoteUI,
  showResultUI,
  buildVoteNotification,
  buildSpamResultNotification,
  buildCleanResultNotification
}
