const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

const mod = require('../helpers/mod-event')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const mkI18n = (lang = 'uk') => ({
  t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
  locale: () => lang
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('usernameLabel: @username takes priority', () => {
  assert.strictEqual(mod.usernameLabel({ username: 'alice', first_name: 'Alice' }), '@alice')
})

test('usernameLabel: falls back to first_name', () => {
  assert.strictEqual(mod.usernameLabel({ first_name: 'Bob' }), 'Bob')
})

test('usernameLabel: falls back to channel title', () => {
  assert.strictEqual(mod.usernameLabel({ title: 'My Channel' }), 'My Channel')
})

test('usernameLabel: id fallback when nothing else set', () => {
  assert.strictEqual(mod.usernameLabel({ id: 42 }), 'id42')
})

test('usernameLabel: HTML-escapes first_name with angle brackets', () => {
  const out = mod.usernameLabel({ first_name: '<script>' })
  assert.ok(!out.includes('<script>'))
  assert.ok(out.includes('&lt;script&gt;'))
})

test('usernameLabel: handles null safely', () => {
  assert.strictEqual(mod.usernameLabel(null), 'Unknown')
  assert.strictEqual(mod.usernameLabel({}), 'Unknown')
})

test('formatConfidence: rounds and formats', () => {
  assert.strictEqual(mod.formatConfidence(87.4), '📊 87%')
  assert.strictEqual(mod.formatConfidence(0), '📊 0%')
})

test('formatConfidence: null/undefined → null', () => {
  assert.strictEqual(mod.formatConfidence(null), null)
  assert.strictEqual(mod.formatConfidence(undefined), null)
})

test('buildCompactText: auto_ban → emoji + name + reason-tag in uk', () => {
  const i18n = mkI18n('uk')
  const { text } = mod.buildCompactText(i18n, { actionType: 'auto_ban' }, { first_name: 'Carol' })
  assert.strictEqual(text, '⛔ Carol — спам')
})

test('buildCompactText: auto_mute uk', () => {
  const i18n = mkI18n('uk')
  const { text } = mod.buildCompactText(i18n, { actionType: 'auto_mute' }, { first_name: 'Dan' })
  assert.ok(text.startsWith('🔇 Dan'))
  assert.ok(text.includes('муть'))
})

test('buildCompactText: no_permissions → suspicious-style line', () => {
  const i18n = mkI18n('uk')
  const { text } = mod.buildCompactText(i18n, { actionType: 'no_permissions' }, { first_name: 'Eve' })
  assert.ok(text.startsWith('👀 Eve'))
})

test('buildCompactText: global_ban', () => {
  const i18n = mkI18n('en')
  const { text } = mod.buildCompactText(i18n, { actionType: 'global_ban' }, { first_name: 'Frank' })
  assert.ok(text.startsWith('🌍 Frank'))
})

test('buildCompactText: voting', () => {
  const i18n = mkI18n('en')
  const { text } = mod.buildCompactText(i18n, { actionType: 'voting' }, { username: 'gus' })
  assert.ok(text.startsWith('⚖️ @gus'))
})

test('buildCompactText: override uses {admin}, not {name}', () => {
  const i18n = mkI18n('uk')
  const { text } = mod.buildCompactText(i18n,
    { actionType: 'override', actorName: 'Alice', actorId: 99 },
    { first_name: 'ShouldNotAppear' })
  assert.ok(text.includes('Alice'))
  assert.ok(!text.includes('ShouldNotAppear'))
  assert.ok(text.startsWith('↩️'))
})

test('buildExpandedText: includes confidence + reason when both present', () => {
  const i18n = mkI18n('uk')
  const text = mod.buildExpandedText(i18n,
    { actionType: 'auto_ban', confidence: 87, reason: 'phishing' },
    { first_name: 'Hank' })
  assert.ok(text.includes('⛔ Hank — спам'))
  assert.ok(text.includes('📊 87%'))
  assert.ok(text.includes('🤖'))
  assert.ok(text.includes('фішинг'))
})

test('buildExpandedText: includes preview line when messagePreview set', () => {
  const i18n = mkI18n('uk')
  const text = mod.buildExpandedText(i18n,
    { actionType: 'auto_ban', messagePreview: 'купи курс' },
    { first_name: 'Ivy' })
  assert.ok(text.includes('«купи курс»'))
})

test('buildExpandedText: HTML-escapes messagePreview', () => {
  const i18n = mkI18n('en')
  const text = mod.buildExpandedText(i18n,
    { actionType: 'auto_ban', messagePreview: '<b>boom</b>' },
    { first_name: 'Jay' })
  assert.ok(!text.includes('<b>boom</b>'))
  assert.ok(text.includes('&lt;b&gt;boom&lt;/b&gt;'))
})

test('buildExpandedText: warning line when provided', () => {
  const i18n = mkI18n('en')
  const text = mod.buildExpandedText(i18n,
    { actionType: 'auto_ban', warning: 'could not delete' },
    { first_name: 'Kim' })
  assert.ok(text.includes('⚠️'))
  assert.ok(text.includes('could not delete'))
})

test('buildCompactKeyboard: auto_ban → [why][hide] single row', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildCompactKeyboard(i18n, { eventId: 'abc123', actionType: 'auto_ban' })
  assert.strictEqual(kb.inline_keyboard.length, 1)
  const [whyBtn, hideBtn] = kb.inline_keyboard[0]
  assert.ok(whyBtn.text.startsWith('🤨'))
  assert.ok(hideBtn.text.includes('Hide'))
  assert.ok(whyBtn.callback_data.endsWith(':abc123'))
  assert.ok(hideBtn.callback_data.includes('hide'))
})

test('buildCompactKeyboard: no_permissions has [why_alt][give_rights] + [hide]', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildCompactKeyboard(i18n, { eventId: 'xyz789', actionType: 'no_permissions' })
  const first = kb.inline_keyboard[0]
  assert.ok(first.some(b => b.text.includes('What happened')))
  assert.ok(first.some(b => b.text.includes('Grant admin')))
})

test('buildCompactKeyboard: global_ban has trust_anyway', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildCompactKeyboard(i18n, { eventId: 'g1', actionType: 'global_ban' })
  const flat = kb.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Trust anyway')))
})

test('buildCompactKeyboard: override → empty keyboard (terminal state)', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildCompactKeyboard(i18n, { eventId: 'o1', actionType: 'override' })
  assert.deepStrictEqual(kb.inline_keyboard, [])
})

test('buildExpandedKeyboard: non-admin sees only [less]', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildExpandedKeyboard(i18n,
    { eventId: 'e1', actionType: 'auto_ban' }, { isAdmin: false })
  assert.strictEqual(kb.inline_keyboard.length, 1)
  assert.strictEqual(kb.inline_keyboard[0].length, 1)
  assert.ok(kb.inline_keyboard[0][0].text.includes('Less'))
})

test('buildExpandedKeyboard: admin sees [less][undo] + [hide]', () => {
  const i18n = mkI18n('en')
  const kb = mod.buildExpandedKeyboard(i18n,
    { eventId: 'e2', actionType: 'auto_ban' }, { isAdmin: true })
  const flat = kb.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Less')))
  assert.ok(flat.some(b => b.text.includes('Unblock')))
  assert.ok(flat.some(b => b.text.includes('Hide')))
})

test('resolveReason: known code resolves from locale', () => {
  const i18n = mkI18n('uk')
  const resolved = mod.resolveReason(i18n, 'phishing')
  assert.strictEqual(resolved, 'фішинг')
})

test('resolveReason: unknown code falls back to raw text', () => {
  const i18n = mkI18n('uk')
  const resolved = mod.resolveReason(i18n, 'some_arbitrary_thing')
  assert.strictEqual(resolved, 'some_arbitrary_thing')
})

test('callback_data stays under 64 bytes for normal eventIds', () => {
  const i18n = mkI18n('uk')
  const kb = mod.buildCompactKeyboard(i18n, { eventId: 'abcdef012345', actionType: 'auto_ban' })
  for (const r of kb.inline_keyboard) {
    for (const b of r) {
      assert.ok(Buffer.byteLength(b.callback_data || '', 'utf8') <= 64,
        `cb_data too long: ${b.callback_data}`)
    }
  }
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
