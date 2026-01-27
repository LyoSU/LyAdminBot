const got = require('got')
const { userName } = require('../utils')
const { cas: casLog } = require('../helpers/logger')

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
    let userId = ctx.from.id
    if (ctx.message.sender_chat && ctx.message.sender_chat.id) userId = ctx.message.sender_chat.id

    return extend.get(`https://api.cas.chat/check?user_id=${userId}`).then(({ body }) => {
      if (body.ok === true) {
        const casData = formatCasData(body)
        casLog.warn({ userId, ...casData }, 'User banned by CAS system')

        // Check bot permissions before banning
        ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          .then(botMember => {
            if (botMember.can_restrict_members) {
              ctx.telegram.kickChatMember(ctx.chat.id, userId)
                .catch(error => casLog.error({ err: error.message, userId }, 'Failed to kick CAS banned user'))
            } else {
              casLog.error({ chatId: ctx.chat.id }, 'Bot lacks permission to restrict members')
            }
          })
          .catch(error => casLog.error({ err: error.message }, 'Failed to check bot permissions'))

        // Send notification message with error handling
        ctx.replyWithHTML(ctx.i18n.t('cas.banned', {
          name: userName(ctx.from, true),
          link: `https://cas.chat/query?u=${userId}`
        }), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true,
          disable_web_page_preview: true
        }).then(notificationMsg => {
          if (notificationMsg) {
            setTimeout(async () => {
              await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
                .catch(error => casLog.error({ err: error.message }, 'Failed to delete notification'))
              casLog.debug('Auto-deleted notification message')
            }, 25 * 1000)
          }
        }).catch(error => {
          if (error.code === 403 && error.description.includes('bot is not a member')) {
            casLog.error({ chatId: ctx.chat.id }, 'Bot was removed from chat')
          } else {
            casLog.error({ err: error.message }, 'Failed to send notification')
          }
        })

        // Delete the original message with error handling
        ctx.deleteMessage().catch(error => {
          casLog.error({ err: error.message }, 'Failed to delete original message')
        })

        return true
      }
    })
  }
}
