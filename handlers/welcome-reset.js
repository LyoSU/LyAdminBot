const welcomeReset = require('../common/welcome-reset')

module.exports = async (ctx) => {
  welcomeReset(ctx.chat.id, () => {
    ctx.replyWithHTML(
      ctx.i18n.t('welcome.reset')
    )
  })
}
