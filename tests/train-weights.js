#!/usr/bin/env node
/**
 * Offline rule-precision calibration.
 *
 * Purpose: replay our deterministic rules over the CURRENT production DB
 * (banned users as positive label, reputation≥70 users as negative label)
 * and compute per-rule precision / recall. Output is a human-readable
 * table plus a JSON file at helpers/deterministic-weights.json that
 * future iterations can consume for calibrated confidence tuning.
 *
 * This is a READ-ONLY script — it never mutates the DB. Safe to run in
 * prod environment against a live replica.
 *
 * Usage:
 *   MONGO_URI="mongodb://..." node tests/train-weights.js [--limit=5000]
 *
 * The `--limit` knob caps samples per class (banned / clean) so the run
 * terminates in a reasonable time on very large databases. Default 2000.
 */

const path = require('path')
const fs = require('fs')
const mongoose = require('mongoose')

// Pull sample limit from CLI.
const LIMIT_ARG = (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]
const LIMIT = Number.isFinite(Number(LIMIT_ARG)) && Number(LIMIT_ARG) > 0 ? Number(LIMIT_ARG) : 2000

const { computeDeterministicVerdict, buildUserSignals } = require('../helpers/spam-signals')
const { analyzeContactMessage } = require('../helpers/contact-spam')
const { evaluateProfileChurn } = require('../helpers/profile-churn')

// Accumulator per verdict-rule name: { tp, fp, total }
const counts = new Map()
const bump = (rule, label) => {
  if (!counts.has(rule)) counts.set(rule, { tp: 0, fp: 0, total: 0 })
  const c = counts.get(rule)
  c.total += 1
  if (label === 'banned') c.tp += 1
  else if (label === 'clean') c.fp += 1
}

const replayUser = (userDoc, label) => {
  // Build a minimal ctx that our detectors can read from. We synthesize a
  // "current message" from the user's last observed text snippet or fall
  // back to a neutral placeholder. For banned users, the detectors
  // wouldn't normally fire at training time because the user history is
  // already marked — but our goal here is precision sanity, not recall.
  const userSignals = buildUserSignals(userDoc, {
    id: userDoc.telegram_id,
    is_premium: userDoc.isPremium,
    username: userDoc.username,
    language_code: userDoc.languageCode
  })

  // Deterministic verdict replay.
  const qa = { risk: 'medium', signals: [], trustSignals: [] }
  const userCtx = {
    isNewAccount: ((userSignals.accountAge && userSignals.accountAge.predictedDays) || 0) < 180,
    messageCount: userSignals.totalMessages || 0,
    globalMessageCount: userSignals.totalMessages || 0,
    hourHistogram: userDoc.globalStats?.messageStats?.hourHistogram || null
  }
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: qa,
    userContext: userCtx,
    text: ''
  })
  if (verdict) bump(`determ::${verdict.rule}::${verdict.decision}`, label)

  // Contact-card detector replay (empty message payload — will no-op).
  const contact = analyzeContactMessage(
    { from: { id: userDoc.telegram_id }, message: {} },
    userDoc,
    userCtx
  )
  if (contact.verdict) bump(`contact::${contact.verdict.rule}`, label)

  // Profile-churn detector replay.
  const churn = evaluateProfileChurn(userDoc)
  if (churn.verdict) bump(`churn::${churn.verdict.rule}`, label)
}

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error('Set MONGO_URI to a read-only replica or local DB')
    process.exit(1)
  }
  await mongoose.connect(process.env.MONGO_URI)
  const userSchema = require('../database/models/user')
  const User = mongoose.model('User', userSchema)

  console.log(`[train] pulling up to ${LIMIT} banned + ${LIMIT} clean users`)
  const bannedCursor = User.find({ isGlobalBanned: true }).limit(LIMIT).lean().cursor()
  let bannedSeen = 0
  for await (const u of bannedCursor) {
    replayUser(u, 'banned')
    bannedSeen++
    if (bannedSeen % 500 === 0) console.log(`  [banned] ${bannedSeen}`)
  }

  const cleanCursor = User.find({
    isGlobalBanned: false,
    'reputation.score': { $gte: 70 },
    'globalStats.totalMessages': { $gte: 30 }
  }).limit(LIMIT).lean().cursor()
  let cleanSeen = 0
  for await (const u of cleanCursor) {
    replayUser(u, 'clean')
    cleanSeen++
    if (cleanSeen % 500 === 0) console.log(`  [clean] ${cleanSeen}`)
  }

  console.log(`\n[train] finished. banned=${bannedSeen}, clean=${cleanSeen}\n`)

  // Build precision table.
  const rows = Array.from(counts.entries()).map(([rule, c]) => {
    const fired = c.tp + c.fp
    const precision = fired === 0 ? 0 : c.tp / fired
    return { rule, fired, tp: c.tp, fp: c.fp, precision }
  }).sort((a, b) => b.fired - a.fired)

  console.log('Rule                                                          Fired   TP    FP   Precision')
  console.log('----------------------------------------------------------------------------------------')
  for (const r of rows) {
    console.log(
      `${r.rule.padEnd(60)}  ${String(r.fired).padStart(5)}  ${String(r.tp).padStart(4)}  ${String(r.fp).padStart(4)}   ${(r.precision * 100).toFixed(1)}%`
    )
  }

  // Write JSON for future calibration code to consume.
  const outPath = path.join(__dirname, '..', 'helpers', 'deterministic-weights.json')
  const payload = {
    generatedAt: new Date().toISOString(),
    bannedSampleSize: bannedSeen,
    cleanSampleSize: cleanSeen,
    rules: Object.fromEntries(rows.map(r => [r.rule, {
      fired: r.fired, tp: r.tp, fp: r.fp, precision: Math.round(r.precision * 10000) / 10000
    }]))
  }
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`\n[train] wrote ${outPath}`)

  await mongoose.disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
