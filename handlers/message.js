const Extra = require('telegraf/extra')

const { userName } = require('../lib')


module.exports = async (ctx) => {
  if (ctx.chat.id > 0) {
    ctx.replyWithHTML(
      ctx.i18n.t('private.start', {
        name: userName(ctx.from),
      }),

      Extra.HTML().markup((m) => m.inlineKeyboard([
        m.urlButton(
          ctx.i18n.t('private.btn_add'),
          `https://t.me/${ctx.options.username}?startgroup=add`
        ),
      ]))
    )

    ctx.mixpanel.track('private message')
  }
  else {
    ctx.mixpanel.track('group message', { group: ctx.chat.id })
  }
}
