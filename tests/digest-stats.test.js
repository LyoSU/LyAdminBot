// Regression coverage for helpers/digest-stats.js.
//
// Pins:
//   - computeDigestStats aggregates ModLog rows correctly by eventType
//   - distinctExternalAdmins is a SET size (dedupes repeat actors)
//   - isWorthSending is false for empty weeks
//   - renderDigest uses i18n for every user-visible string (no hardcoded
//     Ukrainian/English leakage — render with a stub i18n that returns
//     predictable tokens and verify the output contains only those tokens)
//   - pluralKey picks the correct Slavic form for n=1, 2-4, 5-20, 11-14

const assert = require('assert')
const { computeDigestStats, renderDigest, pickFeature, pluralKey, isWorthSending } = require('../helpers/digest-stats')

// ---- pluralKey --------------------------------------------------------
assert.strictEqual(pluralKey(1, 'x'), 'x_one')
assert.strictEqual(pluralKey(2, 'x'), 'x_few')
assert.strictEqual(pluralKey(4, 'x'), 'x_few')
assert.strictEqual(pluralKey(5, 'x'), 'x_many')
assert.strictEqual(pluralKey(11, 'x'), 'x_many', '11 is always many')
assert.strictEqual(pluralKey(14, 'x'), 'x_many', '14 is always many')
assert.strictEqual(pluralKey(21, 'x'), 'x_one', '21 ends in 1 → one')
assert.strictEqual(pluralKey(22, 'x'), 'x_few')
assert.strictEqual(pluralKey(25, 'x'), 'x_many')
assert.strictEqual(pluralKey(111, 'x'), 'x_many', '111 is in [11,14] mod 100')

// ---- computeDigestStats ----------------------------------------------
const makeDb = (rows) => ({
  ModLog: {
    find: () => ({
      lean: async () => rows
    })
  }
})

;(async () => {
  // Empty db → zeroes.
  {
    const stats = await computeDigestStats(makeDb([]), -100, { since: new Date(0) })
    assert.strictEqual(stats.totalEvents, 0)
    assert.strictEqual(stats.autoBans, 0)
    assert.strictEqual(isWorthSending(stats), false)
  }

  // Mixed events.
  const rows = [
    { eventType: 'auto_ban', actorId: null },
    { eventType: 'auto_ban', actorId: null },
    { eventType: 'auto_del', actorId: null },
    { eventType: 'auto_del', actorId: null },
    { eventType: 'auto_del', actorId: null },
    { eventType: 'manual_ban', actorId: 10 },
    { eventType: 'override', actorId: 10 },
    { eventType: 'vote_resolved', actorId: null },
    { eventType: 'captcha_passed', actorId: null },
    { eventType: 'captcha_passed', actorId: null },
    { eventType: 'captcha_failed', actorId: null },
    { eventType: 'external_ban', actorId: 100 },
    { eventType: 'external_ban', actorId: 100 },  // same admin twice
    { eventType: 'external_ban', actorId: 200 },
    { eventType: 'external_restrict', actorId: 300 },
    { eventType: 'external_unban', actorId: 100 },
    { eventType: 'external_unrestrict', actorId: 300 }
  ]
  const stats = await computeDigestStats(makeDb(rows), -100, { since: new Date(0) })
  assert.strictEqual(stats.totalEvents, rows.length)
  assert.strictEqual(stats.autoBans, 2)
  assert.strictEqual(stats.autoDeletes, 3)
  assert.strictEqual(stats.manualBans, 1)
  assert.strictEqual(stats.overrides, 1)
  assert.strictEqual(stats.votesResolved, 1)
  assert.strictEqual(stats.captchaPassed, 2)
  assert.strictEqual(stats.captchaFailed, 1)
  assert.strictEqual(stats.externalBans, 3)
  assert.strictEqual(stats.externalRestricts, 1)
  assert.strictEqual(stats.externalUnbans, 1, 'unbans counted separately from unrestricts')
  assert.strictEqual(stats.externalUnrestricts, 1, 'unrestricts have their own counter now')
  assert.strictEqual(stats.distinctExternalAdmins, 2, 'dedup repeat admin')
  assert.strictEqual(stats.totalBotActions, 5)
  assert.strictEqual(stats.totalAdminActions, 1)
  assert.strictEqual(isWorthSending(stats), true)

  // ---- renderDigest uses i18n for ALL text ----------------------------
  // Stub i18n returns "[[key]]" for every key — if any hardcoded string
  // leaks into the output, this test will catch it because "[[" won't
  // appear where hardcoded text would.
  const stubI18n = {
    t: (key, params = {}) => {
      // Substitute ${var} placeholders like telegraf-i18n does so the
      // row-count assertions still work.
      let out = `[[${key}]]`
      for (const [k, v] of Object.entries(params)) {
        out += `|${k}=${v}`
      }
      return out
    }
  }
  const html = renderDigest(stats, {
    chatTitle: 'Test Chat',
    e: {},
    i18n: stubI18n
  })

  assert.ok(html.includes('[[digest.title]]'), 'title key used')
  assert.ok(html.includes('[[digest.period]]'), 'period key used')
  assert.ok(html.includes('[[digest.row.auto_del]]'), 'auto_del row rendered')
  assert.ok(html.includes('[[digest.row.auto_ban]]'), 'auto_ban row rendered')
  assert.ok(html.includes('[[digest.row.external]]'), 'external row rendered')
  assert.ok(html.includes('[[digest.row.captcha]]'), 'captcha row rendered')
  assert.ok(html.includes('[[digest.row.votes]]'), 'votes row rendered')
  assert.ok(html.includes('[[digest.footer]]'), 'footer key used')
  assert.ok(html.includes('[[digest.feature.external_ban]]'), 'external feature picked (3 bans / 2 admins)')
  // Should NOT contain direct Ukrainian/English digest strings — catches
  // accidental hardcoding.
  assert.ok(!html.includes('Тижневий звіт'), 'no hardcoded UA title')
  assert.ok(!html.includes('Weekly digest'), 'no hardcoded EN title')
  assert.ok(!html.includes('Працюю поки'), 'no hardcoded UA footer')
  assert.ok(!html.includes('Spam deleted'), 'no hardcoded EN row')

  // ---- renderDigest with empty stats shows empty-week copy -------------
  const emptyStats = await computeDigestStats(makeDb([]), -100, { since: new Date(0) })
  const emptyHtml = renderDigest(emptyStats, { chatTitle: 'X', e: {}, i18n: stubI18n })
  assert.ok(emptyHtml.includes('[[digest.empty]]'), 'empty-week copy shown')

  // ---- pickFeature ordering: external > hot_week > captcha > votes -----
  {
    const many = {
      autoBans: 0, autoDeletes: 0, autoMutes: 0,
      externalBans: 2, distinctExternalAdmins: 2,
      captchaPassed: 10, captchaFailed: 2,
      votesResolved: 3, overrides: 0
    }
    const feat = pickFeature(many, stubI18n, {})
    assert.ok(feat.includes('external_ban'), 'external takes priority over other features')
  }
  {
    const hot = {
      autoBans: 10, autoDeletes: 15, autoMutes: 5,
      externalBans: 0, distinctExternalAdmins: 0,
      captchaPassed: 0, captchaFailed: 0,
      votesResolved: 0, overrides: 0
    }
    const feat = pickFeature(hot, stubI18n, {})
    assert.ok(feat.includes('hot_week'), 'hot_week picked when ≥20 auto actions')
  }
  {
    const overrode = {
      autoBans: 0, autoDeletes: 0, autoMutes: 0,
      externalBans: 0, distinctExternalAdmins: 0,
      captchaPassed: 0, captchaFailed: 0,
      votesResolved: 0, overrides: 3
    }
    const feat = pickFeature(overrode, stubI18n, {})
    assert.ok(feat.includes('overrides'), 'overrides surfaced honestly')
  }

  // ---- combined/multi-chat path -----------------------------------------
  const { computeDigestStatsForChats, renderCombinedDigest } = require('../helpers/digest-stats')

  const rowsMultiChat = [
    { chatId: -1, eventType: 'auto_ban', actorId: null },
    { chatId: -1, eventType: 'auto_del', actorId: null },
    { chatId: -2, eventType: 'auto_del', actorId: null },
    { chatId: -2, eventType: 'auto_del', actorId: null },
    { chatId: -2, eventType: 'external_ban', actorId: 50 },
    { chatId: -3, eventType: 'external_ban', actorId: 50 }, // same admin as -2
    { chatId: -3, eventType: 'external_ban', actorId: 60 }
  ]
  const batchedDb = {
    ModLog: {
      find: () => ({
        lean: async () => rowsMultiChat
      })
    }
  }
  const { aggregate, perChat } = await computeDigestStatsForChats(
    batchedDb,
    [-1, -2, -3],
    { since: new Date(0) }
  )

  // Per-chat integrity.
  assert.strictEqual(perChat[-1].autoBans, 1)
  assert.strictEqual(perChat[-1].autoDeletes, 1)
  assert.strictEqual(perChat[-2].autoDeletes, 2)
  assert.strictEqual(perChat[-2].externalBans, 1)
  assert.strictEqual(perChat[-2].distinctExternalAdmins, 1)
  assert.strictEqual(perChat[-3].externalBans, 2)
  assert.strictEqual(perChat[-3].distinctExternalAdmins, 2)

  // Aggregate: distinct external admins dedups across chats.
  assert.strictEqual(aggregate.autoBans, 1)
  assert.strictEqual(aggregate.autoDeletes, 3)
  assert.strictEqual(aggregate.externalBans, 3)
  assert.strictEqual(aggregate.distinctExternalAdmins, 2,
    'distinct admins across chats = 2 (50 banned in -2 AND -3, but counted once)')
  assert.strictEqual(aggregate.totalEvents, 7)

  // Render combined digest — same stub i18n as before.
  const combined = renderCombinedDigest(
    { aggregate, perChat, chats: [
      { group_id: -1, title: 'Chat A' },
      { group_id: -2, title: 'Chat B' },
      { group_id: -3, title: 'Chat C' }
    ] },
    { e: {}, i18n: stubI18n }
  )
  assert.ok(combined.includes('[[digest.combined.title]]'), 'combined title key used')
  assert.ok(combined.includes('[[digest.combined.totals_header]]'), 'totals header used')
  assert.ok(combined.includes('[[digest.combined.per_chat_header]]'), 'per-chat header used')
  assert.ok(combined.includes('[[digest.combined.per_chat_row]]'), 'per-chat row used')
  // All 3 chats had events → all 3 rows rendered.
  const rowMatches = combined.match(/\[\[digest\.combined\.per_chat_row\]\]/g) || []
  assert.strictEqual(rowMatches.length, 3, '3 per-chat rows (one per interesting chat)')

  // Combined with 1 chat → degrades gracefully to single-chat render.
  const oneChatCombined = renderCombinedDigest(
    { aggregate, perChat, chats: [{ group_id: -1, title: 'Solo' }] },
    { e: {}, i18n: stubI18n }
  )
  assert.ok(oneChatCombined.includes('[[digest.title]]'),
    'single-chat combined falls back to renderDigest (digest.title, not digest.combined.title)')
  assert.ok(!oneChatCombined.includes('[[digest.combined.title]]'),
    'single-chat combined should NOT use combined.title')

  console.log('digest-stats regression: all cases OK (single + combined paths)')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
