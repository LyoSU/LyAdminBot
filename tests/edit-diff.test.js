const assert = require('assert')
const ed = require('../helpers/edit-diff')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('snapshotMissed when no prior snapshot', () => {
  ed._resetForTests()
  const r = ed.analyzeEdit(-100, 42, 'hello')
  assert.strictEqual(r.snapshotMissed, true)
  assert.strictEqual(r.injected, false)
})

test('no injection when text just rephrased', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'hey how are you today')
  const r = ed.analyzeEdit(-100, 42, 'hey how are you doing today')
  assert.strictEqual(r.injected, false)
})

test('URL added → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'hello')
  const r = ed.analyzeEdit(-100, 42, 'hello check https://example.com')
  assert.strictEqual(r.injected, true)
  assert.ok(r.urlAdded >= 1)
})

test('@mention added → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'hi')
  const r = ed.analyzeEdit(-100, 42, 'hi @myspamchannel')
  assert.strictEqual(r.injected, true)
  assert.ok(r.mentionAdded >= 1)
})

test('private invite appeared → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'please look')
  const r = ed.analyzeEdit(-100, 42, 'please look t.me/+privateinvite123')
  assert.strictEqual(r.injected, true)
  assert.strictEqual(r.privateInviteAppeared, true)
})

test('invisible char added → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'hello there')
  const r = ed.analyzeEdit(-100, 42, 'hello​there')
  assert.strictEqual(r.injected, true)
})

test('punycode URL appeared → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'boring')
  const r = ed.analyzeEdit(-100, 42, 'boring https://xn--paypa-3eb.com')
  assert.strictEqual(r.injected, true)
  assert.strictEqual(r.punycodeAppeared, true)
})

test('same URL present before and after → NOT injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'see https://example.com here')
  const r = ed.analyzeEdit(-100, 42, 'look at https://example.com now')
  assert.strictEqual(r.urlAdded, 0)
})

test('shortener appeared → injected', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'test')
  // Shortener detection requires full URL (http://) — analyzeUrls only
  // extracts URLs with a protocol or t.me/wa.me prefix.
  const r = ed.analyzeEdit(-100, 42, 'test https://bit.ly/abc')
  assert.strictEqual(r.injected, true)
  assert.strictEqual(r.shortenerAppeared, true)
})

test('snapshot updates after edit so next edit diffs from latest', () => {
  ed._resetForTests()
  ed.snapshotMessage(-100, 42, 'a')
  ed.analyzeEdit(-100, 42, 'a https://x.com')
  // Second edit: no NEW URL, just shuffled — should NOT count as injection
  const r = ed.analyzeEdit(-100, 42, 'a https://x.com added more text')
  assert.strictEqual(r.injected, false)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
