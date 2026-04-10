const got = require('got')
const { userName } = require('../utils')
const { banDatabase: banDatabaseLog } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const { addSignature } = require('../helpers/spam-signatures')
const { checkTrustedUser } = require('../helpers/spam-check')

const BAN_DATABASE_API = 'https://api.lols.bot/account'

const extend = got.extend({
  json: true,
  timeout: 1000,
  throwHttpErrors: false
})

const GENERIC_MESSAGES = {
  uk: {
    banned: (name) => `${name} забанено\n\nЦей акаунт є в <b>глобальній бан-базі</b>. Такі записи зазвичай з'являються через масовий спам, скам або шахрайство.`,
    noPermissions: (name) => `⚠️ ${name} є в глобальній бан-базі\n\n💡 Дайте боту права адміна — сам забаню`
  },
  ru: {
    banned: (name) => `${name} забанен\n\nЭтот аккаунт есть в <b>глобальной бан-базе</b>. Такие записи обычно появляются из-за массового спама, скама или мошенничества.`,
    noPermissions: (name) => `⚠️ ${name} есть в глобальной бан-базе\n\n💡 Дайте боту права админа — сам забаню`
  },
  by: {
    banned: (name) => `${name} забанены\n\nГэты акаўнт ёсць у <b>глабальнай бан-базе</b>. Такія запісы звычайна з'яўляюцца праз масавы спам, скам або махлярства.`,
    noPermissions: (name) => `⚠️ ${name} ёсць у глабальнай бан-базе\n\n💡 Дайце боту правы адміна — сам забаню`
  },
  tr: {
    banned: (name) => `${name} yasaklandı\n\nBu hesap <b>global ban veritabanında</b>. Bu kayıtlar genellikle toplu spam, scam veya dolandırıcılık nedeniyle oluşur.`,
    noPermissions: (name) => `⚠️ ${name} global ban veritabanında\n\n💡 Bota admin yetkisi ver, ben hallederim`
  },
  en: {
    banned: (name) => `${name} banned\n\nThis account is listed in a <b>global ban database</b>. Records like this usually come from mass spam, scams, or fraud.`,
    noPermissions: (name) => `⚠️ ${name} is listed in a global ban database\n\n💡 Give the bot admin rights and I'll handle it`
  }
}

const getGenericMessage = (ctx, key, name) => {
  const locale = ctx.i18n && ctx.i18n.locale ? ctx.i18n.locale() : 'en'
  const messages = GENERIC_MESSAGES[locale] || GENERIC_MESSAGES.en
  return messages[key](name)
}

const formatBanDatabaseData = (data) => {
  if (!data || data.ok !== true) return null

  return {
    banned: data.banned === true,
    userId: data.user_id,
    offenses: data.offenses,
    spamFactor: data.spam_factor,
    scammer: data.scammer,
    when: data.when
  }
}

const checkBanDatabase = async (userId) => {
  const response = await extend.get(BAN_DATABASE_API, {
    query: {
      id: userId,
      quick: true
    }
  })

  if (response.statusCode !== 200) {
    banDatabaseLog.warn({ userId, statusCode: response.statusCode }, 'Global ban database returned non-200 status')
    return null
  }

  return response.body
}

const banSender = async (ctx, userId, isSenderChat) => {
  if (isSenderChat) {
    return ctx.telegram.callApi('banChatSenderChat', {
      chat_id: ctx.chat.id,
      sender_chat_id: userId
    })
  }

  return ctx.telegram.kickChatMember(ctx.chat.id, userId)
}

module.exports = async (ctx) => {
  if (ctx.group && ctx.group.info.settings.banDatabase !== false) {
    // Skip linked channel posts (automatic forwards from discussion channel)
    if (ctx.message.is_automatic_forward) {
      return
    }

    let userId = ctx.from.id
    const isSenderChat = Boolean(ctx.message.sender_chat && ctx.message.sender_chat.id)
    if (isSenderChat) userId = ctx.message.sender_chat.id

    // Trusted users in this group are exempt from the global ban database.
    if (checkTrustedUser(userId, ctx)) {
      banDatabaseLog.info({ userId }, 'Skipping global ban database check for trusted user')
      return
    }

    try {
      const body = await checkBanDatabase(userId)
      if (body && body.ok === true && body.banned === true) {
        const banData = formatBanDatabaseData(body)
        banDatabaseLog.warn({ userId, ...banData }, 'User listed in global ban database')

        const sender = ctx.message.sender_chat || ctx.from
        const displayName = userName(sender, !isSenderChat)
        // Check bot permissions before taking action
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          const canRestrict = botMember.can_restrict_members

          if (canRestrict) {
            // Has permissions - kick user, send ban notification, delete message
            banSender(ctx, userId, isSenderChat)
              .catch(error => banDatabaseLog.error({ err: error.message, userId, isSenderChat }, 'Failed to ban globally listed sender'))

            let notificationMsg = null
            try {
              notificationMsg = await ctx.replyWithHTML(getGenericMessage(ctx, 'banned', displayName), {
                reply_to_message_id: ctx.message.message_id,
                allow_sending_without_reply: true,
                disable_web_page_preview: true
              })
            } catch (error) {
              banDatabaseLog.error({ err: error.message }, 'Failed to send notification')
            }

            // Schedule auto-delete after 25 seconds
            if (notificationMsg && ctx.db) {
              scheduleDeletion(ctx.db, {
                chatId: ctx.chat.id,
                messageId: notificationMsg.message_id,
                delayMs: 25 * 1000,
                source: 'ban_database',
                reference: { type: 'user', id: String(userId) }
              }, ctx.telegram)
            }

            // Delete the original message - always try, even without explicit permission
            ctx.deleteMessage().catch(error => {
              banDatabaseLog.warn({ err: error.message }, 'Failed to delete original message')
            })
          } else {
            // No restrict permissions - but still try to delete the message
            banDatabaseLog.warn({ chatId: ctx.chat.id }, 'Bot lacks permission to restrict members')

            // Try to delete the spam message anyway
            try {
              await ctx.deleteMessage()
              banDatabaseLog.info('Deleted globally banned user message (no restrict permission)')
            } catch (error) {
              banDatabaseLog.warn({ err: error.message }, 'Cannot delete globally banned user message - no permission')

              // Only show notification if we couldn't delete
              let notificationMsg = null
              try {
                notificationMsg = await ctx.replyWithHTML(getGenericMessage(ctx, 'noPermissions', displayName), {
                  reply_to_message_id: ctx.message.message_id,
                  allow_sending_without_reply: true
                })
              } catch (notifyError) {
                banDatabaseLog.error({ err: notifyError.message }, 'Failed to send no-permission notification')
              }

              // Schedule auto-delete after 60 seconds
              if (notificationMsg && ctx.db) {
                scheduleDeletion(ctx.db, {
                  chatId: ctx.chat.id,
                  messageId: notificationMsg.message_id,
                  delayMs: 60 * 1000,
                  source: 'ban_database_no_permissions',
                  reference: { type: 'user', id: String(userId) }
                }, ctx.telegram)
              }
            }
          }
        } catch (error) {
          banDatabaseLog.error({ err: error.message }, 'Failed to check bot permissions')
        }

        // Also add the current message to signatures
        const messageText = ctx.message.text || ctx.message.caption
        if (ctx.db && messageText && messageText.length > 20) {
          addSignature(messageText, ctx.db, ctx.chat.id).catch(err =>
            banDatabaseLog.debug({ err: err.message }, 'Failed to add current message to signatures')
          )
        }

        return true
      }
    } catch (error) {
      banDatabaseLog.warn({ err: error.message, userId }, 'Global ban database check failed')
    }
  }
}
