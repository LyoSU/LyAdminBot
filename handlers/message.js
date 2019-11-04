const Extra = require('telegraf/extra')
const LanguageDetect = require('languagedetect')
const { userName } = require('../utils')
const got = require('got')
const qs = require('querystring')

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
    got.post('https://pi.lyo.su/api/vk/checkComment', {
      body: {
        text: ctx.message.text,
        date: ctx.message.date
      },
      json: true,
      headers: {
        'Content-type': 'application/json'
      },
    }).then((result) => {
      if (result.body.result.description) ctx.replyWithHTML(result.body.result.description, {
        reply_to_message_id: ctx.message.message_id
      })
    })

    const lngDetector = new LanguageDetect()
    const detect = lngDetector.detect(ctx.message.text)

    if (detect.length > 0 && detect[0][1] > 0.3) {
      if (ctx.group.info.settings.removeLng.indexOf(detect[0][0]) >= 0) {
        ctx.deleteMessage()
      }
    }
  }
}
