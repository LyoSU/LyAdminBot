// Regression: admin override (post-vote `[👍 Не спам]` and compact
// `[↩️ Розблокувати]`) must roll back the data-layer side-effects of the
// auto-action that triggered it. Production showed 9 of 10 overridden users
// staying `restricted` with score 10, manualUnbans=0, no whitelist — the
// very next message they sent was auto-banned again. See helpers/admin-
// override.js header comment for the full design rationale.

const assert = require('assert')

delete require.cache[require.resolve('../helpers/admin-override')]
const { applyAdminOverride, REP_BOOST, REP_CAP } = require('../helpers/admin-override')

// Minimal in-memory mock of ctx.db.User and ctx.db.Group covering the
// Mongoose method shapes the helper actually calls.
const mkDb = ({ user = null, group = null } = {}) => {
  const users = new Map()
  if (user) users.set(user.telegram_id, { ...user })

  const groups = new Map()
  if (group) groups.set(group.group_id, JSON.parse(JSON.stringify(group)))

  // tiny dot-path setter (handles 'a.b.c' = v)
  const setDeep = (obj, path, value) => {
    const parts = path.split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = value
  }
  const incDeep = (obj, path, by) => {
    const parts = path.split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = (cur[parts[parts.length - 1]] || 0) + by
  }
  const getDeep = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
  const unsetTop = (obj, key) => { delete obj[key] }
  const matches = (doc, filter) => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'telegram_id' || k === 'group_id') {
        if (doc[k] !== v) return false
      } else if (typeof v === 'object' && v !== null && '$gte' in v) {
        const cur = getDeep(doc, k)
        if (typeof cur !== 'number' || cur < v.$gte) return false
      } else {
        if (getDeep(doc, k) !== v) return false
      }
    }
    return true
  }

  const applyOps = (doc, ops) => {
    if (ops.$set) for (const [k, v] of Object.entries(ops.$set)) setDeep(doc, k, v)
    if (ops.$inc) for (const [k, v] of Object.entries(ops.$inc)) incDeep(doc, k, v)
    if (ops.$unset) for (const k of Object.keys(ops.$unset)) unsetTop(doc, k)
    if (ops.$addToSet) {
      for (const [k, v] of Object.entries(ops.$addToSet)) {
        const arr = getDeep(doc, k)
        if (!Array.isArray(arr)) setDeep(doc, k, [v])
        else if (!arr.includes(v)) arr.push(v)
      }
    }
  }

  return {
    User: {
      findOne: async (filter) => users.get(filter.telegram_id) || null,
      updateOne: async (filter, ops, opts = {}) => {
        let doc = null
        for (const u of users.values()) { if (matches(u, filter)) { doc = u; break } }
        if (!doc) {
          if (opts.upsert) {
            doc = { telegram_id: filter.telegram_id }
            users.set(filter.telegram_id, doc)
          } else {
            return { matchedCount: 0, modifiedCount: 0 }
          }
        }
        applyOps(doc, ops)
        return { matchedCount: 1, modifiedCount: 1 }
      }
    },
    Group: {
      updateOne: async (filter, ops) => {
        const doc = groups.get(filter.group_id)
        if (!doc) return { matchedCount: 0, modifiedCount: 0 }
        const before = JSON.stringify(doc)
        applyOps(doc, ops)
        const after = JSON.stringify(doc)
        return { matchedCount: 1, modifiedCount: before === after ? 0 : 1 }
      }
    },
    _users: users,
    _groups: groups
  }
}

;(async () => {
  // ── 1. Channel target (negative id) → no-op ─────────────────────────────
  {
    const db = mkDb()
    const r = await applyAdminOverride(db, { userId: -1001234567890, chatId: -100 })
    assert.strictEqual(r, null, 'channels are skipped')
    assert.strictEqual(db._users.size, 0, 'no user write for channel')
  }

  // ── 2. Missing db / userId → null ───────────────────────────────────────
  {
    assert.strictEqual(await applyAdminOverride(null, { userId: 1 }), null, 'null db skipped')
    assert.strictEqual(await applyAdminOverride({}, { userId: 1 }), null, 'db without User skipped')
    assert.strictEqual(await applyAdminOverride(mkDb(), {}), null, 'no userId skipped')
    assert.strictEqual(await applyAdminOverride(mkDb(), { userId: 0 }), null, 'zero userId skipped')
    assert.strictEqual(await applyAdminOverride(mkDb(), { userId: 'x' }), null, 'non-number userId skipped')
  }

  // ── 3. Reputation boost from 50 → 70 ────────────────────────────────────
  {
    const db = mkDb({
      user: {
        telegram_id: 100,
        reputation: { score: 50, status: 'neutral' },
        globalStats: { spamDetections: 1, manualUnbans: 0, totalMessages: 5 }
      }
    })
    const r = await applyAdminOverride(db, { userId: 100, chatId: -200 })
    assert.strictEqual(r.oldScore, 50)
    assert.strictEqual(r.newScore, 70, '50 + 20 = 70 (within cap)')
    const u = db._users.get(100)
    assert.strictEqual(u.reputation.score, 70)
    assert.strictEqual(u.globalStats.manualUnbans, 1, 'manualUnbans++')
    assert.strictEqual(u.globalStats.spamDetections, 0, 'spamDetections--')
  }

  // ── 4. Reputation cap at 74 ─────────────────────────────────────────────
  {
    const db = mkDb({
      user: {
        telegram_id: 101,
        reputation: { score: 60, status: 'neutral' },
        globalStats: { spamDetections: 0 }
      }
    })
    const r = await applyAdminOverride(db, { userId: 101 })
    assert.strictEqual(r.newScore, REP_CAP, 'capped, not 80')
    assert.strictEqual(REP_CAP, 74, 'cap is 74')
    assert.strictEqual(REP_BOOST, 20, 'boost is 20')
  }

  // ── 5. Reputation lifts user out of `restricted` (the production cascade) ─
  {
    const db = mkDb({
      user: {
        telegram_id: 102,
        reputation: { score: 10, status: 'restricted' },
        globalStats: { spamDetections: 1 }
      }
    })
    const r = await applyAdminOverride(db, { userId: 102 })
    assert.strictEqual(r.oldScore, 10)
    assert.strictEqual(r.newScore, 30, '10 + 20')
    // status thresholds in helpers/reputation.js: <20=restricted, <40=suspicious,
    // <80=neutral. score=30 → suspicious. The key win is leaving `restricted`
    // so shouldFullBan no longer triggers full ban for the next message.
    assert.notStrictEqual(r.newStatus, 'restricted', 'no longer restricted')
  }

  // ── 6. spamDetections floor: never goes negative ────────────────────────
  {
    const db = mkDb({
      user: {
        telegram_id: 103,
        reputation: { score: 50 },
        globalStats: { spamDetections: 0, manualUnbans: 0 }
      }
    })
    await applyAdminOverride(db, { userId: 103 })
    const u = db._users.get(103)
    assert.strictEqual(u.globalStats.spamDetections, 0, 'floor at 0, no -1')
    assert.strictEqual(u.globalStats.manualUnbans, 1, 'manualUnbans still increments')
  }

  // ── 7. Two consecutive overrides — counter still doesn't go negative ────
  {
    const db = mkDb({
      user: {
        telegram_id: 104,
        reputation: { score: 50 },
        globalStats: { spamDetections: 1, manualUnbans: 0 }
      }
    })
    await applyAdminOverride(db, { userId: 104 })
    await applyAdminOverride(db, { userId: 104 })
    const u = db._users.get(104)
    assert.strictEqual(u.globalStats.spamDetections, 0, 'still 0 after second override')
    assert.strictEqual(u.globalStats.manualUnbans, 2, 'two unbans recorded')
  }

  // ── 8. Drops global ban fields ──────────────────────────────────────────
  {
    const db = mkDb({
      user: {
        telegram_id: 105,
        isGlobalBanned: true,
        globalBanReason: 'auto: high confidence spam',
        globalBanDate: new Date('2026-04-20'),
        reputation: { score: 5 },
        globalStats: { spamDetections: 3 }
      }
    })
    await applyAdminOverride(db, { userId: 105 })
    const u = db._users.get(105)
    assert.strictEqual('isGlobalBanned' in u, false, 'isGlobalBanned unset')
    assert.strictEqual('globalBanReason' in u, false, 'globalBanReason unset')
    assert.strictEqual('globalBanDate' in u, false, 'globalBanDate unset')
  }

  // ── 9. Per-chat whitelist on settings.openaiSpamCheck.trustedUsers ──────
  {
    const db = mkDb({
      user: { telegram_id: 106, reputation: { score: 50 }, globalStats: {} },
      group: { group_id: -200, settings: { openaiSpamCheck: { trustedUsers: [] } } }
    })
    const r = await applyAdminOverride(db, { userId: 106, chatId: -200 })
    assert.strictEqual(r.whitelistAdded, true, 'first whitelist add')
    const g = db._groups.get(-200)
    assert.deepStrictEqual(g.settings.openaiSpamCheck.trustedUsers, [106])

    // idempotency — second call must not duplicate
    const r2 = await applyAdminOverride(db, { userId: 106, chatId: -200 })
    assert.strictEqual(r2.whitelistAdded, false, 'addToSet idempotent')
    assert.deepStrictEqual(g.settings.openaiSpamCheck.trustedUsers, [106])
  }

  // ── 10. No chatId → user mutations still run, whitelist skipped ────────
  {
    const db = mkDb({
      user: { telegram_id: 107, reputation: { score: 50 }, globalStats: {} }
    })
    const r = await applyAdminOverride(db, { userId: 107 })
    assert.strictEqual(r.whitelistAdded, false, 'no chatId → no whitelist write')
    const u = db._users.get(107)
    assert.strictEqual(u.reputation.score, 70, 'rep still applied')
  }

  // ── 11. Non-existent user — upsert creates the row with the boost ──────
  {
    const db = mkDb()
    const r = await applyAdminOverride(db, { userId: 108, chatId: -300 })
    // Default oldScore is 50 when user is missing
    assert.strictEqual(r.oldScore, 50)
    assert.strictEqual(r.newScore, 70)
    const u = db._users.get(108)
    assert.ok(u, 'user upserted')
    assert.strictEqual(u.reputation.score, 70)
    assert.strictEqual(u.globalStats.manualUnbans, 1)
  }

  console.log('admin-override: OK')
})().catch(err => {
  console.error('admin-override: FAIL', err)
  process.exit(1)
})
