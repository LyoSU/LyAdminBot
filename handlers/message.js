const { userLogin } = require('../lib')

module.exports = async (ctx) => {
  if (ctx.chat.id > 0) {
    ctx.replyWithHTML(
      ctx.i18n.t('private.start', {
        login: userLogin(ctx.from)
      })
    )
    ctx.mixpanel.track('private message')
  } else {
    ctx.mixpanel.track('group message', { group: ctx.chat.id })
  }
}