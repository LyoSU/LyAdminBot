const assert = require('assert')
const { computeMyStats, getStatsBadge } = require('../handlers/my-stats')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Stub i18n that returns its key + a simple interpolated copy of params.
// Good enough to assert the right key was queried with the right vars.
const stubI18n = (locale = 'en') => ({
  locale: () => locale,
  t: (key, params = {}) => `${key}|${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')}`
})

const baseGroup = {
  stats: { messagesCount: 100, textTotal: 10000 },
  settings: { banan: { default: 300 } }
}
const baseMember = {
  stats: { messagesCount: 50, textTotal: 7200 },
  banan: { num: 5, sum: 3600, stack: 2 },
  createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 days
}
const baseFrom = { id: 1, first_name: 'Alice', username: 'alice' }

test('activity% uses member text share of group total', () => {
  const out = computeMyStats({
    member: baseMember,
    group: baseGroup,
    from: baseFrom,
    chatName: 'Room',
    i18n: stubI18n()
  })
  assert.strictEqual(Math.round(out.activityPercent), 72)
})

test('flood% zero when member avg below group avg', () => {
  const belowAvgMember = Object.assign({}, baseMember, {
    stats: { messagesCount: 100, textTotal: 5000 } // avg 50 < group avg 100
  })
  const out = computeMyStats({
    member: belowAvgMember,
    group: baseGroup,
    from: baseFrom,
    chatName: 'Room',
    i18n: stubI18n()
  })
  assert.strictEqual(out.floodPercent, 0)
})

test('flood% positive when member avg above group avg', () => {
  const fluffyMember = Object.assign({}, baseMember, {
    stats: { messagesCount: 10, textTotal: 5000 } // avg 500 vs group 100
  })
  const out = computeMyStats({
    member: fluffyMember,
    group: baseGroup,
    from: baseFrom,
    chatName: 'Room',
    i18n: stubI18n()
  })
  assert.ok(out.floodPercent > 0 && out.floodPercent <= 100)
})

test('empty group — falls back to 0% activity without NaN', () => {
  const out = computeMyStats({
    member: { stats: { messagesCount: 0, textTotal: 0 }, banan: { num: 0, sum: 0, stack: 0 } },
    group: { stats: { messagesCount: 0, textTotal: 0 }, settings: { banan: { default: 300 } } },
    from: baseFrom,
    chatName: 'Empty',
    i18n: stubI18n()
  })
  assert.strictEqual(out.activityPercent, 0)
  assert.strictEqual(out.floodPercent, 0)
  assert.ok(typeof out.text === 'string')
  assert.ok(!out.text.includes('NaN'))
})

test('bar width is always 10 cells', () => {
  const out = computeMyStats({
    member: baseMember,
    group: baseGroup,
    from: baseFrom,
    chatName: 'Room',
    i18n: stubI18n()
  })
  // Look for activityBar param value in the stub output
  const m = out.text.match(/activityBar=([^&]+)/)
  assert.ok(m, 'activityBar substituted into template')
  // 10 chars of ▮/▱ — count unique code points not bytes
  const chars = Array.from(m[1])
  assert.strictEqual(chars.length, 10)
})

test('badge: newbie for < 7 days', () => {
  const i18n = stubI18n()
  const badge = getStatsBadge(i18n, {
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  }, 0, 0, 5, 0)
  assert.strictEqual(badge, 'cmd.my_stats.badge.newbie|')
})

test('badge: collector for 10+ bans', () => {
  const i18n = stubI18n()
  const badge = getStatsBadge(i18n, { createdAt: new Date() }, 0, 0, 50, 12)
  assert.strictEqual(badge, 'cmd.my_stats.badge.collector|')
})

test('badge: exemplary beats anything else (100 msgs + 0 bans)', () => {
  const i18n = stubI18n()
  const badge = getStatsBadge(i18n, { createdAt: new Date() }, 50, 0, 500, 0)
  assert.strictEqual(badge, 'cmd.my_stats.badge.exemplary|')
})

test('badge: empty string when no rule matches', () => {
  const i18n = stubI18n()
  const badge = getStatsBadge(i18n, {
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  }, 5, 5, 30, 1)
  assert.strictEqual(badge, '')
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log('✓', t.name)
    } catch (err) {
      failed++
      console.error('✗', t.name, '—', err.message)
    }
  }
  if (failed) process.exit(1)
})()
