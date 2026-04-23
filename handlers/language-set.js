// /lang command + legacy `set_language:<code>` callback.
//
// Group context: renders the unified settings.lang screen (text-names only,
// no flags). Private context: same flag-less picker as a text menu.
// Callback `set_language:<code>` remains live as a backward-compat alias and
// simply writes the locale to whatever context applies.

const { replyHTML } = require('../helpers/reply-html')
const { getMenu } = require('../helpers/menu/registry')

const LOCALE_CODES = ['uk', 'en', 'ru', 'tr', 'by']
const LOCALE_NAMES = {
  uk: 'Українська',
  en: 'English',
  ru: 'Русский',
  tr: 'Türkçe',
  by: 'Беларуская'
}

const buildPrivateKeyboard = () => ({
  inline_keyboard: LOCALE_CODES.map(code => [{
    text: LOCALE_NAMES[code],
    callback_data: `set_language:${code}`
  }])
})

module.exports = async (ctx) => {
  if (ctx.updateType === 'callback_query') {
    const code = ctx.match && ctx.match[1]
    if (!code || !LOCALE_CODES.includes(code)) {
      return ctx.answerCbQuery().catch(() => {})
    }

    if (['supergroup', 'group'].includes(ctx.chat.type)) {
      const chatMember = await ctx.tg.getChatMember(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.from.id
      )
      if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
        ctx.group.info.settings.locale = code
        return ctx.answerCbQuery(LOCALE_NAMES[code]).catch(() => {})
      }
      return ctx.answerCbQuery().catch(() => {})
    }

    // Private chat — store on session.userInfo as before.
    if (ctx.session && ctx.session.userInfo) {
      ctx.session.userInfo.locale = code
    }
    return ctx.answerCbQuery(LOCALE_NAMES[code]).catch(() => {})
  }

  // /lang command. In groups, render the settings.lang screen inline.
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    const screen = getMenu('settings.lang')
    if (screen) {
      try {
        const view = await screen.render(ctx, {})
        if (view && view.text) {
          await replyHTML(ctx, view.text, view.keyboard ? { reply_markup: view.keyboard } : {})
          return
        }
      } catch (err) { /* fall through to flat picker */ }
    }
  }

  // Private chat or fallback: flat flag-less picker using the legacy callback.
  await replyHTML(ctx, 'Choose language / Вибрати мову', {
    reply_markup: buildPrivateKeyboard()
  })
}

module.exports.LOCALE_CODES = LOCALE_CODES
module.exports.LOCALE_NAMES = LOCALE_NAMES
