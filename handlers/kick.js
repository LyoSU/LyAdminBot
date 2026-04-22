const { userName } = require('../utils')
const { mapTelegramError } = require('../helpers/error-mapper')
const { isSenderAdmin } = require('../helpers/is-sender-admin')

module.exports = async (ctx) => {
  const isAdmin = await isSenderAdmin(ctx)
  let kickUser

  if (isAdmin) {
    if (ctx.message.reply_to_message) {
      kickUser = ctx.message.reply_to_message.from
    } else {
      ctx.replyWithHTML(ctx.i18n.t('kick.who'))
    }
  } else {
    kickUser = ctx.from
  }

  if (kickUser) {
    await ctx.telegram.unbanChatMember(ctx.chat.id, kickUser.id).then(() => {
      // Self-kick easter egg
      const isSelfKick = ctx.from.id === kickUser.id
      let msgKey = 'kick.suc'

      if (isSelfKick && isAdmin) {
        msgKey = 'kick.easter.admin_self'
      } else if (isSelfKick) {
        msgKey = 'kick.easter.self'
      }

      ctx.replyWithHTML(ctx.i18n.t(msgKey, {
        name: userName(kickUser, true)
      }))
    }).catch((error) => {
      const errorKey = mapTelegramError(error, 'kick')
      return ctx.replyWithHTML(ctx.i18n.t(errorKey))
    })
  }
}
