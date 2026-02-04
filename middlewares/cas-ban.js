const got = require('got')
const { userName } = require('../utils')
const { cas: casLog } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const { addSignature } = require('../helpers/spam-signatures')

const extend = got.extend({
  json: true,
  timeout: 1000,
  throwHttpErrors: false
})

/**
 * Formats CAS response data for structured logging
 * @param {Object} data - CAS API response data
 * @returns {Object} - Structured data for logging
 */
const formatCasData = (data) => {
  if (!data || !data.ok) return null

  const result = {
    offenses: data.result.offenses,
    timeAdded: data.result.time_added,
    reasons: data.result.reasons
  }

  if (data.result.messages && data.result.messages.length > 0) {
    result.flaggedMessages = data.result.messages.slice(0, 3).map(msg => {
      const cleanMessage = msg.replace(/\n+/g, ' ').trim()
      return cleanMessage.length > 100 ? cleanMessage.substring(0, 100) + '...' : cleanMessage
    })
  }

  return result
}

module.exports = async (ctx) => {
  if (ctx.group && ctx.group.info.settings.cas === true) {
    // Skip linked channel posts (automatic forwards from discussion channel)
    if (ctx.message.is_automatic_forward) {
      return
    }

    let userId = ctx.from.id
    if (ctx.message.sender_chat && ctx.message.sender_chat.id) userId = ctx.message.sender_chat.id

    return extend.get(`https://api.cas.chat/check?user_id=${userId}`).then(async ({ body }) => {
      if (body.ok === true) {
        const casData = formatCasData(body)
        casLog.warn({ userId, ...casData }, 'User banned by CAS system')

        // Check bot permissions before taking action
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          const canRestrict = botMember.can_restrict_members
          const canDelete = botMember.can_delete_messages

          if (canRestrict) {
            // Has permissions - kick user, send ban notification, delete message
            ctx.telegram.kickChatMember(ctx.chat.id, userId)
              .catch(error => casLog.error({ err: error.message, userId }, 'Failed to kick CAS banned user'))

            let notificationMsg = null
            try {
              notificationMsg = await ctx.replyWithHTML(ctx.i18n.t('cas.banned', {
                name: userName(ctx.from, true),
                link: `https://cas.chat/query?u=${userId}`
              }), {
                reply_to_message_id: ctx.message.message_id,
                allow_sending_without_reply: true,
                disable_web_page_preview: true
              })
            } catch (error) {
              casLog.error({ err: error.message }, 'Failed to send notification')
            }

            // Schedule auto-delete after 25 seconds
            if (notificationMsg && ctx.db) {
              scheduleDeletion(ctx.db, {
                chatId: ctx.chat.id,
                messageId: notificationMsg.message_id,
                delayMs: 25 * 1000,
                source: 'cas_ban',
                reference: { type: 'user', id: String(userId) }
              }, ctx.telegram)
            }

            // Delete the original message - always try, even without explicit permission
            ctx.deleteMessage().catch(error => {
              casLog.warn({ err: error.message }, 'Failed to delete original message')
            })
          } else {
            // No restrict permissions - but still try to delete the message
            casLog.warn({ chatId: ctx.chat.id }, 'Bot lacks permission to restrict members')

            // Try to delete the spam message anyway
            try {
              await ctx.deleteMessage()
              casLog.info('Deleted CAS user message (no restrict permission)')
            } catch (error) {
              casLog.warn({ err: error.message }, 'Cannot delete CAS user message - no permission')

              // Only show notification if we couldn't delete
              let notificationMsg = null
              try {
                notificationMsg = await ctx.replyWithHTML(ctx.i18n.t('cas.no_permissions', {
                  name: userName(ctx.from, true)
                }), {
                  reply_to_message_id: ctx.message.message_id,
                  allow_sending_without_reply: true
                })
              } catch (notifyError) {
                casLog.error({ err: notifyError.message }, 'Failed to send no-permission notification')
              }

              // Schedule auto-delete after 60 seconds
              if (notificationMsg && ctx.db) {
                scheduleDeletion(ctx.db, {
                  chatId: ctx.chat.id,
                  messageId: notificationMsg.message_id,
                  delayMs: 60 * 1000,
                  source: 'cas_no_permissions',
                  reference: { type: 'user', id: String(userId) }
                }, ctx.telegram)
              }
            }
          }
        } catch (error) {
          casLog.error({ err: error.message }, 'Failed to check bot permissions')
        }

        // Add CAS flagged messages to our signature database (learning from CAS)
        if (ctx.db && body.result && body.result.messages && body.result.messages.length > 0) {
          const messages = body.result.messages.slice(0, 5) // Max 5 samples
          for (const msg of messages) {
            if (msg && msg.length > 20) { // Skip very short messages
              addSignature(msg, ctx.db, ctx.chat.id).catch(err =>
                casLog.debug({ err: err.message }, 'Failed to add CAS message to signatures')
              )
            }
          }
          casLog.debug({ count: messages.length }, 'Added CAS flagged messages to signatures')
        }

        // Also add the current message to signatures
        const messageText = ctx.message.text || ctx.message.caption
        if (ctx.db && messageText && messageText.length > 20) {
          addSignature(messageText, ctx.db, ctx.chat.id).catch(err =>
            casLog.debug({ err: err.message }, 'Failed to add current message to signatures')
          )
        }

        return true
      }
    })
  }
}
