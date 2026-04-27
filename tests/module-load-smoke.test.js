// Boot-smoke test — every JS module under bot/ helpers/ middlewares/
// handlers/ must parse and load cleanly. Today's incident
// (helpers/ban-database-sync.js shipped with `return { status, error.message }`
// — a SyntaxError) made it past CI because the runner never required
// that module: it's only pulled in by bot/background-jobs.js, which is
// only required from bot.js, which init()s as a side effect, which
// the test runner avoids on purpose.
//
// This test takes the cheapest possible defence: walk the source tree
// and `require()` every file. Any SyntaxError, missing import, or
// circular-require failure surfaces here, in a few hundred ms, instead
// of in a production boot loop at 3am.
//
// Files that intentionally have side effects on require (open DB
// connections, start polling, mutate process listeners) are NOT
// good candidates — we skip the top-level entry points.

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.resolve(__dirname, '..')

// Top-level orchestration files boot the whole app on require — skip.
// Tests have their own coverage via launchBot etc.
const SKIP = new Set([
  'bot.js',
  'index.js'
])

const SCAN_DIRS = ['bot', 'helpers', 'middlewares', 'handlers', 'database', 'routes', 'utils']

function* walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.js')) yield full
  }
}

const failures = []
let loaded = 0

// Top-level files
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue
  if (SKIP.has(entry.name)) continue
  const full = path.join(ROOT, entry.name)
  try {
    require(full)
    loaded++
  } catch (err) {
    failures.push({ file: path.relative(ROOT, full), err })
  }
}

for (const dirName of SCAN_DIRS) {
  const dir = path.join(ROOT, dirName)
  if (!fs.existsSync(dir)) continue
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file)
    try {
      require(file)
      loaded++
    } catch (err) {
      failures.push({ file: rel, err })
    }
  }
}

if (failures.length > 0) {
  console.error(`\n  ${failures.length} module(s) failed to load:`)
  for (const { file, err } of failures) {
    console.error(`  ✗ ${file}`)
    console.error(`      ${err.name}: ${err.message}`)
    if (err.stack) {
      // First two stack frames — usually enough to spot the call site.
      const frames = err.stack.split('\n').slice(1, 3).join('\n')
      console.error(frames)
    }
  }
  console.error(`\n${loaded} loaded, ${failures.length} failed`)
  process.exit(1)
}

assert.ok(loaded > 50, `expected to load at least 50 modules, got ${loaded}`)
console.log(`  ✓ ${loaded} modules require() cleanly`)
console.log(`\n${loaded} passed, 0 failed`)

// Some required modules (helpers/spam-check, etc.) open Mongo/Qdrant
// clients on import. Force-exit so spawnSync() in tests/run.js
// doesn't hang on those handles.
process.exit(0)
