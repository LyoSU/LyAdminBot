/**
 * Contact-spam detector tests.
 *
 * Production code uses ONLY structural signals (Unicode scripts, URL/digits/
 * invisible in name, foreign vs own contact) — no keyword or country lists.
 * Test fixtures contain concrete spam samples, but those live only here; they
 * verify the structural detector catches real-world attacks without baking
 * the attack's language into production.
 */

const assert = require('assert')
const {
  analyzeContactMessage,
  detectForeignScript,
  hasScriptMix
} = require('../helpers/contact-spam')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// Unit helpers: Unicode script detection
// --------------------------------------------------------------------------

test('detectForeignScript: CJK (Chinese / Japanese / Korean)', () => {
  assert.strictEqual(detectForeignScript('拿手绝活 花的放心'), 'cjk')
  assert.strictEqual(detectForeignScript('包过机 假钞'), 'cjk')
  assert.strictEqual(detectForeignScript('こんにちは'), 'cjk') // Japanese
  assert.strictEqual(detectForeignScript('안녕하세요'), 'cjk') // Korean
})

test('detectForeignScript: SEA scripts', () => {
  assert.strictEqual(detectForeignScript('เดิมพัน โบนัส'), 'sea') // Thai
  assert.strictEqual(detectForeignScript('ကောင်း'), 'sea') // Myanmar
})

test('detectForeignScript: Arabic / Persian', () => {
  assert.strictEqual(detectForeignScript('اربح المال'), 'arabic')
})

test('detectForeignScript: Indic', () => {
  assert.strictEqual(detectForeignScript('नमस्ते'), 'indic')
})

test('detectForeignScript: Cyrillic / Latin NOT foreign', () => {
  assert.strictEqual(detectForeignScript('Олександр Петренко'), null)
  assert.strictEqual(detectForeignScript('John Smith'), null)
  assert.strictEqual(detectForeignScript('Åsa Øverland'), null)
})

test('hasScriptMix: mid-token Latin+Cyrillic → true', () => {
  assert.strictEqual(hasScriptMix('Иoсифович'), true) // Latin o in Cyrillic token
})
test('hasScriptMix: clean bilingual tokens → false', () => {
  assert.strictEqual(hasScriptMix('Іван John'), false)
})

// --------------------------------------------------------------------------
// Real attack fixtures
// --------------------------------------------------------------------------

test('prod attack: CJK contact name + new user + not own → spam', () => {
  const ctx = {
    from: { id: 7593628468, first_name: 'deleted' },
    chat: { id: -1001234567890, type: 'supergroup' },
    message: {
      contact: {
        phone_number: '+60 173904335',
        first_name: '拿手绝活 花的放心',
        last_name: ''
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: true, messageCount: 0, globalMessageCount: 0 })
  assert.ok(r.verdict, 'prod attack must fire')
  assert.strictEqual(r.verdict.decision, 'spam')
  assert.strictEqual(r.verdict.rule, 'contact_foreign_script_suspicious')
  assert.ok(r.signals.includes('contact_foreign_script'))
})

test('URL inside contact name → structural anomaly (spam)', () => {
  const ctx = {
    from: { id: 1 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+84 1234567890',
        first_name: 'Call me t.me/crypto_channel',
        user_id: 999
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: true, messageCount: 1 })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'contact_name_structural_anomaly')
})

test('digits inside contact name → structural anomaly', () => {
  const ctx = {
    from: { id: 1 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+1 2125551234',
        first_name: 'Win 5000 usdt',
        user_id: 999
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: false, messageCount: 10 })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'contact_name_structural_anomaly')
})

test('invisible chars in contact name → structural anomaly', () => {
  const ctx = {
    from: { id: 1 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+1 2125551234',
        first_name: 'Promo​Deal',
        user_id: 999
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: false, messageCount: 10 })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'contact_name_structural_anomaly')
})

test('script-mix inside a token + new user → spam', () => {
  const ctx = {
    from: { id: 1 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+1 2125551234',
        first_name: 'Steven李',
        user_id: 999
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: true, messageCount: 0 })
  assert.ok(r.verdict)
  assert.ok(['contact_script_mix_new_user', 'contact_foreign_script_suspicious'].includes(r.verdict.rule))
})

test('repeat sender: contactCount >= 2 + foreign contact → spam', () => {
  const ctx = {
    from: { id: 1 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+380501234567',
        first_name: 'Natalia',
        user_id: 999
      }
    }
  }
  const userInfo = {
    globalStats: {
      totalMessages: 50,
      messageStats: { contactCount: 3 }
    }
  }
  const r = analyzeContactMessage(ctx, userInfo, { isNewAccount: false, messageCount: 30, globalMessageCount: 50 })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'contact_repeat_sender')
})

// --------------------------------------------------------------------------
// FP guards — MUST NOT FIRE
// --------------------------------------------------------------------------

test('FP guard: sharing OWN phone number → no verdict', () => {
  const ctx = {
    from: { id: 42, first_name: 'John' },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+380501234567',
        first_name: 'John',
        user_id: 42
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: true, messageCount: 1 })
  assert.strictEqual(r.verdict, null)
})

test('FP guard: local friend, established user → no verdict', () => {
  const ctx = {
    from: { id: 42, first_name: 'John' },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+380501234567',
        first_name: 'Оксана',
        last_name: 'Бондар',
        user_id: 999
      }
    }
  }
  const userInfo = { globalStats: { totalMessages: 500, messageStats: { contactCount: 1 } } }
  const r = analyzeContactMessage(ctx, userInfo, { isNewAccount: false, messageCount: 100, globalMessageCount: 500 })
  assert.strictEqual(r.verdict, null)
})

test('FP guard: English contact, established user, no anomalies → no verdict', () => {
  const ctx = {
    from: { id: 42 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+1 6505551234',
        first_name: 'Steve',
        last_name: 'Rogers',
        user_id: 777
      }
    }
  }
  const r = analyzeContactMessage(ctx, { globalStats: { totalMessages: 300 } }, {
    isNewAccount: false, messageCount: 50, globalMessageCount: 300
  })
  assert.strictEqual(r.verdict, null)
})

test('FP guard: foreign-script but own contact → no verdict', () => {
  // A Chinese user sharing their OWN number with a Chinese name — that's
  // a perfectly legitimate interaction; detector must not fire.
  const ctx = {
    from: { id: 42 },
    chat: { id: -100 },
    message: {
      contact: {
        phone_number: '+86 13800138000',
        first_name: '李明',
        user_id: 42 // own
      }
    }
  }
  const r = analyzeContactMessage(ctx, null, { isNewAccount: false, messageCount: 10 })
  assert.strictEqual(r.verdict, null)
})

test('no contact field → isContact false', () => {
  const r = analyzeContactMessage(
    { from: { id: 1 }, chat: { id: -100 }, message: { text: 'hi' } },
    null,
    { isNewAccount: true }
  )
  assert.strictEqual(r.isContact, false)
  assert.strictEqual(r.verdict, null)
})

// --------------------------------------------------------------------------
// Run
// --------------------------------------------------------------------------

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed += 1
    console.log(`  ✓ ${t.name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${t.name}`)
    console.log('     ' + err.message)
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
