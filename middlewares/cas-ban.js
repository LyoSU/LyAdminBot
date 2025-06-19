const got = require('got')
const { userName } = require('../utils')

const extend = got.extend({
  json: true,
  timeout: 1000,
  throwHttpErrors: false
})

/**
 * Formats CAS response data for better readability in logs
 * @param {Object} data - CAS API response data
 * @returns {String} - Formatted log string
 */
const formatCasLog = (data) => {
  if (!data || !data.ok) return 'No CAS data available'

  let logMessage = '\n[CAS BAN] User banned by CAS system:'
  logMessage += '\n------------------------------------------------------------'
  logMessage += `\n🚫 Offenses: ${data.result.offenses}`
  logMessage += `\n⏰ Added: ${data.result.time_added}`
  logMessage += `\n🔍 Reasons: ${data.result.reasons.join(', ')}`

  // Format messages if they exist
  if (data.result.messages && data.result.messages.length > 0) {
    logMessage += '\n\n📝 Flagged messages:'
    logMessage += '\n------------------------------------------------------------'
    data.result.messages.forEach((msg, index) => {
      // Truncate long messages and clean up formatting
      const cleanMessage = msg.replace(/\n+/g, ' ').trim()
      const truncatedMessage = cleanMessage.length > 100
        ? cleanMessage.substring(0, 100) + '...'
        : cleanMessage

      logMessage += `\n[${index + 1}] ${truncatedMessage}`
    })
  }

  logMessage += '\n------------------------------------------------------------'
  return logMessage
}

module.exports = async (ctx) => {
  if (ctx.group && ctx.group.info.settings.cas === true) {
    let userId = ctx.from.id
    if (ctx.message.sender_chat && ctx.message.sender_chat.id) userId = ctx.message.sender_chat.id

    return extend.get(`https://api.cas.chat/check?user_id=${userId}`).then(({ body }) => {
      if (body.ok === true) {
        // Log formatted CAS data
        console.log(formatCasLog(body))

        // Check bot permissions before banning
        ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          .then(botMember => {
            if (botMember.can_restrict_members) {
              // Ban the user
              ctx.telegram.kickChatMember(ctx.chat.id, userId)
                .catch(error => console.error(`[GLOBAL BAN ERROR] Failed to kick globally banned user: ${error.message}`))
            } else {
              console.error(`[GLOBAL BAN ERROR] Bot doesn't have permission to restrict members in chat ${ctx.chat.id}`)
            }
          })
          .catch(error => console.error(`[PERMISSION CHECK] Failed to check bot permissions for ban: ${error.message}`))

        // Send notification message with error handling
        ctx.replyWithHTML(ctx.i18n.t('cas.banned', {
          name: userName(ctx.from, true),
          link: `https://cas.chat/query?u=${userId}`
        }), {
          reply_to_message_id: ctx.message.message_id,
          disable_web_page_preview: true
        }).then(notificationMsg => {
          // Schedule notification message deletion after 25 seconds
          if (notificationMsg) {
            setTimeout(async () => {
              await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
                .catch(error => console.error(`[CAS BAN] Failed to delete notification after timeout: ${error.message}`))
              console.log(`[CAS BAN] Auto-deleted notification message after timeout`)
            }, 25 * 1000) // 25 seconds
          }
        }).catch(error => {
          // Check if bot was removed from chat
          if (error.code === 403 && error.description.includes('bot is not a member')) {
            console.error(`[CAS BAN] Bot was removed from chat ${ctx.chat.id}`)
          } else {
            console.error(`[CAS BAN] Failed to send notification: ${error.message}`)
          }
        })

        // Delete the original message with error handling
        ctx.deleteMessage().catch(error => {
          console.error(`[CAS BAN] Failed to delete original message: ${error.message}`)
        })

        return true
      }
    })
  }
}
