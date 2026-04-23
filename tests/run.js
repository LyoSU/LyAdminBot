#!/usr/bin/env node
// Auto-discovering sequential test runner. Drops-in replaces the &&-chain in
// package.json. Runs every `tests/*.test.js` in its own Node process, prints a
// compact per-file line, exits non-zero if any file fails.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const dir = __dirname
const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => only.length === 0 || only.some(p => f.includes(p)))
  .sort()

if (files.length === 0) {
  console.error('No test files matched.')
  process.exit(1)
}

const start = Date.now()
const failed = []

for (const f of files) {
  const fileStart = Date.now()
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const ms = Date.now() - fileStart
  const ok = r.status === 0
  const mark = ok ? '✓' : '✗'
  process.stdout.write(`${mark} ${f}  ${ms}ms\n`)
  if (!ok) {
    failed.push(f)
    const out = (r.stdout || '').toString().trim()
    const err = (r.stderr || '').toString().trim()
    if (out) process.stdout.write(out + '\n')
    if (err) process.stderr.write(err + '\n')
  }
}

const totalMs = Date.now() - start
const line = `${files.length - failed.length}/${files.length} passed  ${totalMs}ms`

if (failed.length === 0) {
  console.log('\n' + line)
  process.exit(0)
}

console.error('\n' + line)
for (const f of failed) console.error('  FAIL: ' + f)
process.exit(1)
