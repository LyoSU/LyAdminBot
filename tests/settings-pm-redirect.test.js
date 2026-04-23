// Settings must NOT render in-group. /settings (and !settings alias) + the
// onboarding [🔧 Налаштувати] button must produce a PM-redirect view with a
// URL button pointing at the /start deep-link.

const assert = require('assert')

const { buildPmRedirect } = require('../handlers/settings')

const ctx = {
  chat: { id: -1001234567890, type: 'supergroup' },
  botInfo: { username: 'LyAdminBot' },
  i18n: { t: (key) => `__${key}__` }
}

{
  const { text, keyboard } = buildPmRedirect(ctx)
  assert.strictEqual(text, '__menu.settings.open_in_pm.text__')
  assert.ok(keyboard.inline_keyboard, 'keyboard present')
  assert.strictEqual(keyboard.inline_keyboard.length, 1)
  const btn = keyboard.inline_keyboard[0][0]
  assert.strictEqual(btn.text, '__menu.settings.open_in_pm.btn__')
  assert.strictEqual(btn.url, 'https://t.me/LyAdminBot?start=settings_-1001234567890')
  assert.ok(!btn.callback_data, 'must be URL button, not callback')
}

{
  const fallbackCtx = {
    chat: { id: -999, type: 'group' },
    botInfo: null,
    i18n: { t: (k) => k }
  }
  const { keyboard } = buildPmRedirect(fallbackCtx)
  assert.ok(
    keyboard.inline_keyboard[0][0].url.startsWith('https://t.me/LyAdminBot?start=settings_'),
    'falls back to default username when botInfo missing'
  )
}

{
  const onboarding = require('../helpers/menu/screens/onboarding')
  assert.strictEqual(typeof onboarding.register, 'function', 'onboarding exports register()')
}

console.log('PASS settings-pm-redirect')
