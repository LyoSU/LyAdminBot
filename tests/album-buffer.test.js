const assert = require('assert')
const albumBuffer = require('../middlewares/album-buffer')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = (messageId, mediaGroupId, extras = {}) => {
  const message = { message_id: messageId, media_group_id: mediaGroupId, ...extras }
  return {
    chat: { id: -100 },
    update: { message },
    get message () { return this.update.message }
  }
}

test('non-album message passes through untouched', async () => {
  albumBuffer._resetForTests()
  let called = false
  const ctx = mkCtx(1, undefined, { text: 'hello' })
  await albumBuffer(ctx, () => { called = true })
  assert.ok(called, 'next() should run synchronously for non-album')
  assert.strictEqual(ctx.mediaGroup, undefined)
})

// Helper: wires each ctx with its OWN next() closure that captures the
// final ctx at resolve time, since telegraf's next() is a thunk with no
// args and we need to know WHICH ctx carries the aggregated state.
const runAlbum = async (ctxs) => {
  const captured = { ctx: null, calls: 0 }
  await Promise.all(ctxs.map(ctx => albumBuffer(ctx, () => {
    captured.calls++
    captured.ctx = ctx
  })))
  return captured
}

test('album: 3 siblings collapse into ONE next() call', async () => {
  albumBuffer._resetForTests()
  const { calls, ctx } = await runAlbum([
    mkCtx(10, 'GROUP1', { caption: 'buy now' }),
    mkCtx(11, 'GROUP1'),
    mkCtx(12, 'GROUP1')
  ])
  assert.strictEqual(calls, 1, `expected 1 next() call, got ${calls}`)
  assert.ok(Array.isArray(ctx.mediaGroup))
  assert.strictEqual(ctx.mediaGroup.length, 3)
  assert.deepStrictEqual(ctx.mediaGroupIds, [10, 11, 12])
  // Caption carrier chosen as ctx.message
  assert.strictEqual(ctx.message.message_id, 10)
  assert.strictEqual(ctx.message.caption, 'buy now')
})

test('album: caption on the LAST sibling is still picked as carrier', async () => {
  albumBuffer._resetForTests()
  const { ctx } = await runAlbum([
    mkCtx(20, 'GROUP2'),
    mkCtx(21, 'GROUP2'),
    mkCtx(22, 'GROUP2', { caption: 'last has the text' })
  ])
  assert.ok(ctx.mediaGroup)
  assert.strictEqual(ctx.message.caption, 'last has the text')
  assert.strictEqual(ctx.message.message_id, 22)
})

test('two distinct albums in parallel: each fires its own next()', async () => {
  albumBuffer._resetForTests()
  const captured = { calls: 0, ctxs: [] }
  const a1 = mkCtx(30, 'GA', { caption: 'A' })
  const a2 = mkCtx(31, 'GA')
  const b1 = mkCtx(32, 'GB', { caption: 'B' })
  const b2 = mkCtx(33, 'GB')
  const mkNext = (ctx) => () => { captured.calls++; captured.ctxs.push(ctx) }
  await Promise.all([
    albumBuffer(a1, mkNext(a1)),
    albumBuffer(a2, mkNext(a2)),
    albumBuffer(b1, mkNext(b1)),
    albumBuffer(b2, mkNext(b2))
  ])
  assert.strictEqual(captured.calls, 2, `expected 2 next() calls across 2 albums, got ${captured.calls}`)
  const captions = captured.ctxs.map(c => c.message.caption).sort()
  assert.deepStrictEqual(captions, ['A', 'B'])
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
