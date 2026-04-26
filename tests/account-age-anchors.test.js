// Regression: cross-bot anchors added 2026-04-26 must give plausible
// predicted creation dates for the post-2024 id ranges. Previously the
// table cut off at id=6925870357 (2023-11-29) and accounts with id>>7B
// were extrapolated by linear growth-rate, which dramatically under-aged
// 2026 accounts (id=8.7B predicted as Nov 2024 — 17 months too old).
// That false "veteran" verdict fed the sleeper-awakened detector and
// threatened auto-bans on real fresh accounts.

const assert = require('assert')

delete require.cache[require.resolve('../helpers/account-age')]
const { predictCreationDate, getAccountAgeParadox } = require('../helpers/account-age')

const ymd = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
const expectMonth = (id, expected, label) => {
  const [, date] = predictCreationDate(id)
  const got = ymd(date)
  assert.strictEqual(got, expected, `${label}: id=${id} expected ${expected} got ${got}`)
}

// ── 1. Existing entry preserved ─────────────────────────────────────────
expectMonth(6925870357, '2023-11', 'existing 6.925B anchor → Nov 2023')

// ── 2. New 2024 anchors land in the right months ────────────────────────
expectMonth(7050000000, '2024-02', '7.05B → Feb 2024 (between 7.0B and 7.1B)')
expectMonth(7150000000, '2024-04', '7.15B → ~Apr 2024 (between 7.1B and 7.2B)')
expectMonth(7250000000, '2024-05', '7.25B → May 2024')
expectMonth(7350000000, '2024-05', '7.35B → May 2024')
expectMonth(7450000000, '2024-07', '7.45B → ~Jul 2024 (between 7.4B 5/26 and 7.5B 8/14)')
expectMonth(7550000000, '2024-09', '7.55B → ~Sep 2024 (50% between 8/14 and 9/18)')

// ── 3. 2024-09-18 plateau — interpolation stays in that month ───────────
//    Real-world fact: ~0.5B IDs alloc'd in one day. Detectors should NOT
//    interpolate "12% through Sept" for id=7.65B because the entire band
//    7.6B–8.1B was one allocation event.
expectMonth(7650000000, '2024-09', '7.65B (plateau) → Sep 2024')
expectMonth(7800000000, '2024-09', '7.8B (plateau) → Sep 2024')
expectMonth(7950000000, '2024-09', '7.95B (plateau) → Sep 2024')
expectMonth(8050000000, '2024-09', '8.05B (plateau) → Sep 2024')

// ── 4. Long lull after plateau — 8.1B → 8.2B is 308 days ───────────────
expectMonth(8150000000, '2025-02', '8.15B → mid-lull (Sep24→Jul25 midpoint)')

// ── 5. New 2025 anchors ─────────────────────────────────────────────────
expectMonth(8250000000, '2025-07', '8.25B → Jul 2025')
expectMonth(8350000000, '2025-07', '8.35B → Jul 2025')
expectMonth(8450000000, '2025-09', '8.45B → ~Sep 2025 (between Jul23 and Oct31)')
expectMonth(8550000000, '2025-12', '8.55B → ~Dec 2025 (between Oct31 and Feb22)')

// ── 6. New 2026 anchors — the headline win ──────────────────────────────
//    Before patch: extrapolation from old end-entry [6925870357, Nov 2023]
//    used a 55.8 IDs/sec growth rate, putting 8.7B at ~Nov 2024 — i.e.
//    1.25 years in the past, triggering sleeper-awakened on every fresh
//    user with a 2026 id. After patch: anchored to real Feb 2026.
expectMonth(8650000000, '2026-02', '8.65B → Feb 2026 (was Nov 2024 extrapolated)')
expectMonth(8700000000, '2026-02', '8.7B → Feb 2026')

// ── 7. Extrapolation past the new last anchor still works ───────────────
{
  const [prefix, date] = predictCreationDate(8800000000)
  assert.strictEqual(prefix, '>', '8.8B is beyond known anchors → extrapolation marker')
  assert.ok(
    date.getTime() >= new Date('2026-02-23').getTime(),
    `extrapolated date should be ≥ last anchor; got ${date.toISOString()}`
  )
}

// ── 8. The downstream invariant: a fresh 2026 account must NOT trigger
//      sleeper-awakened. With the old extrapolation it would have, because
//      predictedAgeDays read >365 even for accounts created last week.
{
  const today = Date.now()
  const firstSeen = new Date(today - 2 * 86400_000)   // 2 days ago
  const paradox = getAccountAgeParadox(8700000000, firstSeen, today)
  assert.ok(paradox, 'paradox returned for valid input')
  assert.strictEqual(
    paradox.isSleeperAwakened, false,
    `2026 account, fresh in our DB, must NOT be flagged as sleeper. Got predictedAgeDays=${paradox.predictedAgeDays}, localAgeDays=${paradox.localAgeDays}`
  )
}

// ── 9. Real veterans still ARE flagged. id=2.0B is 2021, fresh in our DB
//      (firstSeen yesterday) → real sleeper.
{
  const today = Date.now()
  const firstSeen = new Date(today - 1 * 86400_000)
  const paradox = getAccountAgeParadox(2000000000, firstSeen, today)
  assert.strictEqual(
    paradox.isSleeperAwakened, true,
    'true 2021 veteran posting first message today MUST flag as sleeper'
  )
}

console.log('account-age-anchors: OK')
