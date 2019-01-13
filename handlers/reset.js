const groupSettingsReset = require('../common/group-settings-reset')

module.exports = async (ctx) => {
  groupSettingsReset(ctx.chat.id, () => {
    ctx.replyWithHTML(
      ctx.i18n.t('cmd.reset')
    )
  })
}
