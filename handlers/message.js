const Extra = require('telegraf/extra')
const LanguageDetect = require('languagedetect')
const { userName } = require('../utils')


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
  }
  else {
    const lngDetector = new LanguageDetect()
    const detect = lngDetector.detect(ctx.message.text)

    if (detect.length > 0) {
      console.log(ctx.groupInfo.settings.removeLng.indexOf(detect[0][0]))

      if (detect[0][0] === 'ukrainian') {
        ctx.deleteMessage()
      }
    }
  }
}
