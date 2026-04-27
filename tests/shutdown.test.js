// Tests for bot/shutdown.js — pins SIGTERM/SIGINT handling and the
// invariant that we tear down telegraf → background jobs → mongo in
// the right order, with a hard deadline so we never hang.

const assert = require('assert')

// Stub the logger so logs don't pollute test output.
const Module = require('module')
const realLoad = Module._load
const stubMap = new Map()
Module._load = function (request, parent, ...rest) {
  if (stubMap.has(request)) return stubMap.get(request)
  return realLoad.call(this, request, parent, ...rest)
}
stubMap.set('../helpers/logger', {
  bot: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
})

// Reset shared module-level `shuttingDown` flag between cases by
// re-requiring the module each time.
const requireFresh = () => {
  delete require.cache[require.resolve('../bot/shutdown')]
  return require('../bot/shutdown')
}

let passed = 0
let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name} — ${err.message}\n${err.stack}`)
    failed++
  }
}

// We can't actually invoke `process.exit` in a test process — it
// would kill mocha-style runners. So we stub it via a sentinel.
const captureExit = () => {
  const calls = []
  const orig = process.exit
  process.exit = (code) => { calls.push(code) }
  return { calls, restore: () => { process.exit = orig } }
}

;(async () => {
  await test('shutdown drains telegraf, jobs, mongo in order', async () => {
    const { installShutdownHandlers } = requireFresh()
    const order = []
    const bot = {
      stop: (sig) => { order.push(`telegraf:${sig}`) }
    }
    const backgroundJobs = {
      stop: async () => { order.push('jobs') }
    }
    const db = {
      connection: {
        close: async () => { order.push('mongo') }
      }
    }
    const exitStub = captureExit()
    try {
      installShutdownHandlers({ bot, db, backgroundJobs })
      // Manually emit SIGTERM (process.once handler is attached).
      process.emit('SIGTERM')
      // setImmediate(exit) — give the handler microtask + setImmediate to drain.
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      exitStub.restore()
      process.removeAllListeners('SIGTERM')
      process.removeAllListeners('SIGINT')
      process.removeAllListeners('unhandledRejection')
      process.removeAllListeners('uncaughtException')
    }
    assert.deepStrictEqual(order, ['telegraf:SIGTERM', 'jobs', 'mongo'])
    assert.deepStrictEqual(exitStub.calls, [0], 'process.exit(0) must be called')
  })

  await test('shutdown is idempotent (second signal is a no-op)', async () => {
    const { installShutdownHandlers } = requireFresh()
    let stopCalls = 0
    const bot = { stop: () => { stopCalls++ } }
    const backgroundJobs = { stop: async () => {} }
    const db = { connection: { close: async () => {} } }
    const exitStub = captureExit()
    try {
      installShutdownHandlers({ bot, db, backgroundJobs })
      process.emit('SIGTERM')
      process.emit('SIGTERM')
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      exitStub.restore()
      process.removeAllListeners('SIGTERM')
      process.removeAllListeners('SIGINT')
      process.removeAllListeners('unhandledRejection')
      process.removeAllListeners('uncaughtException')
    }
    assert.strictEqual(stopCalls, 1, 'telegraf.stop must be called exactly once')
  })

  await test('shutdown survives a stopper that throws', async () => {
    const { installShutdownHandlers } = requireFresh()
    const order = []
    const bot = {
      stop: () => { throw new Error('telegraf boom') }
    }
    const backgroundJobs = {
      stop: async () => { order.push('jobs ran despite telegraf throw') }
    }
    const db = {
      connection: {
        close: async () => { order.push('mongo ran despite telegraf throw') }
      }
    }
    const exitStub = captureExit()
    try {
      installShutdownHandlers({ bot, db, backgroundJobs })
      process.emit('SIGTERM')
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      exitStub.restore()
      process.removeAllListeners('SIGTERM')
      process.removeAllListeners('SIGINT')
      process.removeAllListeners('unhandledRejection')
      process.removeAllListeners('uncaughtException')
    }
    assert.deepStrictEqual(order, [
      'jobs ran despite telegraf throw',
      'mongo ran despite telegraf throw'
    ])
    assert.deepStrictEqual(exitStub.calls, [0])
  })

  await test('handlers are installed for all four signals', async () => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
    const { installShutdownHandlers } = requireFresh()
    installShutdownHandlers({
      bot: { stop: () => {} },
      db: { connection: { close: async () => {} } },
      backgroundJobs: { stop: async () => {} }
    })
    assert.strictEqual(process.listenerCount('SIGTERM'), 1)
    assert.strictEqual(process.listenerCount('SIGINT'), 1)
    assert.ok(process.listenerCount('unhandledRejection') >= 1)
    assert.ok(process.listenerCount('uncaughtException') >= 1)
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
  })

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  console.log(`\n${passed} passed, 0 failed`)
  process.exit(0)
})().catch(err => {
  console.error('Test crashed:', err)
  process.exit(1)
})
