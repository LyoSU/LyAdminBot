const assert = require('assert')
const s = require('../helpers/scripts')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('hasCJK: Chinese / Japanese / Korean → true', () => {
  assert.strictEqual(s.hasCJK('中国人'), true)
  assert.strictEqual(s.hasCJK('ひらがな'), true)
  assert.strictEqual(s.hasCJK('カタカナ'), true)
  assert.strictEqual(s.hasCJK('한글'), true)
})

test('hasCJK: non-CJK → false', () => {
  assert.strictEqual(s.hasCJK('Hello world'), false)
  assert.strictEqual(s.hasCJK('Привіт світ'), false)
})

test('hasArabic: Arabic / Persian / Urdu → true', () => {
  assert.strictEqual(s.hasArabic('السلام'), true)
  assert.strictEqual(s.hasArabic('فارسی'), true)
})

test('hasSEA: Thai / Khmer / Myanmar → true', () => {
  assert.strictEqual(s.hasSEA('สวัสดี'), true) // Thai
  assert.strictEqual(s.hasSEA('ខ្មែរ'), true) // Khmer
  assert.strictEqual(s.hasSEA('မြန်မာ'), true) // Myanmar
})

test('hasIndic: Devanagari / Bengali / Tamil → true', () => {
  assert.strictEqual(s.hasIndic('हिंदी'), true)
  assert.strictEqual(s.hasIndic('বাংলা'), true)
  assert.strictEqual(s.hasIndic('தமிழ்'), true)
})

test('hasCyrillic / hasLatin', () => {
  assert.strictEqual(s.hasCyrillic('привіт'), true)
  assert.strictEqual(s.hasCyrillic('hello'), false)
  assert.strictEqual(s.hasLatin('hello'), true)
  assert.strictEqual(s.hasLatin('привіт'), false)
})

test('hasInvisible: zero-width joiner / BOM', () => {
  const zwnj = '‌'
  const zwsp = '​'
  const bom = '﻿'
  assert.strictEqual(s.hasInvisible(`a${zwnj}b`), true)
  assert.strictEqual(s.hasInvisible(`a${zwsp}b`), true)
  assert.strictEqual(s.hasInvisible(`a${bom}b`), true)
  assert.strictEqual(s.hasInvisible('plain text'), false)
})

test('stripInvisible removes all \\p{Cf}', () => {
  const polluted = 'h​i‌the﻿re'
  assert.strictEqual(s.stripInvisible(polluted), 'hithere')
})

test('hasScriptMixWithinToken: Latin+Cyrillic homoglyph → true', () => {
  // Capital V + Cyrillic і + ASCII a
  assert.strictEqual(s.hasScriptMixWithinToken('Vіagra'), true)
})

test('hasScriptMixWithinToken: pure tokens → false', () => {
  assert.strictEqual(s.hasScriptMixWithinToken('hello world'), false)
  assert.strictEqual(s.hasScriptMixWithinToken('привіт світ'), false)
  assert.strictEqual(s.hasScriptMixWithinToken('hello привіт'), false) // mixed but within diff tokens
})

test('dominantScript: picks highest count, ignores digits/punct', () => {
  assert.strictEqual(s.dominantScript('Hello world +1234'), 'latin')
  assert.strictEqual(s.dominantScript('Привіт світ'), 'cyrillic')
  assert.strictEqual(s.dominantScript('中国你好世界 hi'), 'cjk')
  assert.strictEqual(s.dominantScript('1234567'), null)
  assert.strictEqual(s.dominantScript(''), null)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
