// Personal language picker for the /start card in PM.
//
// Distinct from settings.lang (which sets the GROUP'S locale and is
// group_admin-gated). This screen sets the current USER'S preference
// (ctx.session.userInfo.locale) — used everywhere the user appears
// without a group context (PM with the bot, /lang in DM, etc.).
//
// Public access: a person changing their own language doesn't need any gate.

const { registerMenu } = require('../registry')
const { cb, btn, row, closeBtn } = require('../keyboard')

const SCREEN_ID = 'lang.picker'

const LANGUAGES = [
  { code: 'uk', name: 'Українська' },
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'by', name: 'Беларуская' }
]

const nameOf = (code) => {
  const found = LANGUAGES.find(l => l.code === code)
  return found ? found.name : 'English'
}

const renderView = (ctx) => {
  const current = (ctx.i18n && typeof ctx.i18n.locale === 'function' && ctx.i18n.locale()) || 'en'
  const text = ctx.i18n.t('menu.lang_picker.text', { current: nameOf(current) })
  const marker = '● '
  const buttons = LANGUAGES.map(({ code, name }) => row(btn(
    (code === current ? marker : '') + name,
    cb(SCREEN_ID, 'set', code)
  )))
  buttons.push(row(closeBtn({ label: ctx.i18n.t('menu.common.close') })))
  return { text, keyboard: { inline_keyboard: buttons } }
}

const register = () => registerMenu({
  id: SCREEN_ID,
  access: 'public',
  render: renderView,
  handle: async (ctx, action, args) => {
    if (action !== 'set') return { render: false }
    const code = args[0]
    if (!LANGUAGES.some(l => l.code === code)) return { render: false }
    // Persist on the user's session doc; data-persistence middleware saves it.
    if (ctx.session && ctx.session.userInfo) {
      ctx.session.userInfo.locale = code
    }
    if (ctx.i18n && typeof ctx.i18n.locale === 'function') {
      try { ctx.i18n.locale(code) } catch { /* ignore */ }
    }
    return { render: true, toast: 'menu.lang_picker.saved' }
  }
})

module.exports = { register, SCREEN_ID, LANGUAGES, nameOf, renderView }
