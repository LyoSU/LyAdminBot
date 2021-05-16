const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  let loginUrl = process.env.WEB_URL

  if (['supergroup', 'group'].includes(ctx.chat.type)) loginUrl += `?group_id=${ctx.chat.id}`

  await ctx.reply('web', {
    reply_markup: Markup.inlineKeyboard([
      Markup.loginButton('Login', loginUrl, {
        request_write_access: true,
      }),
    ]),
  })
}
