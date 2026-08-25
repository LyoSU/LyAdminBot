/**
 * What a ground-truth label has to contain.
 *
 * `pipeline_feedback` is the only permanent record of a human saying "this was
 * not spam", and it is the whole corpus available for judging a calibration
 * change. It used to store `decidedBy`/`ruleId`/`reasonCode` — how the verdict
 * was reached — while the signals and the score lived in `pipeline_decisions`,
 * which expires after 14 days. Two weeks on, a permanent label pointed at
 * evidence that no longer existed, so no weight change could ever be checked
 * against the false positives we already knew about.
 *
 * Hence a test on the document shape rather than on behaviour: the value of this
 * write is entirely in what it preserves.
 */
import { describe, expect, it } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { VOTE_WINDOW_SECONDS } from '@lyadmin/core'
import { MongoStore, ensureTtlIndex } from './mongo.js'

interface Captured {
  doc: Record<string, unknown> | null
  /** Distinct documents the collection ends up holding, keyed by the filter. */
  rows: Map<string, Record<string, unknown>>
  filters: Record<string, unknown>[]
}

/**
 * A store whose feedback write is captured instead of performed.
 *
 * The double applies `$setOnInsert` / `$set` the way an upsert does rather than
 * just recording the call, because one of the things under test is that a second
 * correction of the same message produces one document and not two.
 */
const captureStore = (): { store: MongoStore; captured: Captured } => {
  const captured: Captured = { doc: null, rows: new Map(), filters: [] }
  const store = {
    feedback: {
      updateOne: async (
        filter: Record<string, unknown>,
        update: Record<string, Record<string, unknown>>,
        options?: { upsert?: boolean }
      ) => {
        captured.filters.push(filter)
        const key = JSON.stringify(filter)
        const existing = captured.rows.get(key)
        const doc = {
          ...(existing ?? (options?.upsert === true ? update['$setOnInsert'] ?? {} : {})),
          ...(update['$set'] ?? {})
        }
        captured.rows.set(key, doc)
        captured.doc = doc
        return {}
      }
    },
    // recordOverride also deactivates a matched signature; not under test here.
    spamSignatures: { updateOne: async () => ({}) }
  } as unknown as MongoStore
  // The method under test is the real one; only the collections are stubbed.
  return { store: Object.assign(store, { recordOverride: MongoStore.prototype.recordOverride }), captured }
}

const verdict: Pick<Verdict, 'decidedBy' | 'ruleId' | 'reasonCode' | 'pSpam' | 'action' | 'signals' | 'meta'> = {
  decidedBy: 'score',
  ruleId: null,
  reasonCode: 'promo',
  pSpam: 0.82,
  action: 'delete',
  signals: [{ name: 'sleeper_awakened' }, { name: 'promo_in_bio' }, { name: 'new_globally' }],
  meta: { scorePSpam: 0.82, contentEvidence: '0/0', cappedGroups: 'newness' }
}

/**
 * Standing must be earned by participating, not by posting.
 *
 * `touchMember` runs BEFORE the pipeline, because the number of prior messages
 * is an input to the verdict — so by the time a message is judged, its credit
 * has already been paid. Production 2026-07-31 showed what that buys an
 * attacker: one advert reposted nine times into one chat, `new_in_chat` and
 * `new_globally` dropping out of the signal list as the count grew, and the
 * score sinking from 0.91 to 0.75 while the evidence against it accumulated.
 *
 * The raw counter is left alone — it is a v1 field and it answers the
 * user-facing "how active is this person" question honestly. Standing is the
 * raw count minus the messages we judged to be spam.
 */
describe('touchMember — what counts as standing', () => {
  const memberStore = (stats: Record<string, number> | undefined) => {
    const writes: Record<string, unknown>[] = []
    const store = {
      groups: { findOneAndUpdate: async () => ({ _id: 'group-oid' }) },
      groupMembers: {
        findOneAndUpdate: async (_filter: unknown, update: Record<string, unknown>) => {
          writes.push(update)
          return stats ? { stats } : null
        }
      }
    } as unknown as MongoStore
    return { store: Object.assign(store, { touchMember: MongoStore.prototype.touchMember }), writes }
  }

  it('credits only the messages that were not judged spam', async () => {
    const { store } = memberStore({ messagesCount: 14, spamMessages: 9 })
    expect(await store.touchMember(-100, 42, 30)).toBe(5)
  })

  it('a member with no spam counter is unaffected', async () => {
    const { store } = memberStore({ messagesCount: 14 })
    expect(await store.touchMember(-100, 42, 30)).toBe(14)
  })

  it('never returns a negative count', async () => {
    const { store } = memberStore({ messagesCount: 2, spamMessages: 7 })
    expect(await store.touchMember(-100, 42, 30)).toBe(0)
  })

  it('keeps incrementing the raw activity counter', async () => {
    // Changing what `stats.messagesCount` means would distort the /stats view
    // and every v1 document alongside it. The subtraction happens on read.
    const { store, writes } = memberStore({ messagesCount: 14, spamMessages: 9 })
    await store.touchMember(-100, 42, 30)
    expect(writes[0]?.['$inc']).toMatchObject({ 'stats.messagesCount': 1 })
    expect(writes[0]?.['$inc']).not.toHaveProperty('stats.spamMessages')
  })

  it('a first-ever message counts as zero prior standing', async () => {
    const { store } = memberStore(undefined)
    expect(await store.touchMember(-100, 42, 30)).toBe(0)
  })
})

/**
 * Traffic and standing are different questions and this method answers both.
 *
 * `/stats` wants traffic — how much this member wrote, which is what the v1
 * counter has always meant. The ballot bar wants standing, the same reading
 * `touchMember` returns to the pipeline. Handing one number to both callers is
 * how the vote came to be bought with the very messages the chat had removed:
 * ten deleted adverts in one chat still read as ten messages of belonging, and
 * a chat can only ever produce ONE detection against an account, so the
 * `known_bad` check does not catch that sender either.
 */
describe('getMemberStats — traffic and standing are different questions', () => {
  const statsStore = (member: unknown, group: unknown = { _id: 'group-oid' }) => {
    const store = {
      groups: { findOne: async () => group },
      groupMembers: { findOne: async () => member }
    } as unknown as MongoStore
    return Object.assign(store, { getMemberStats: MongoStore.prototype.getMemberStats })
  }

  it('reports traffic raw and standing net of the messages judged spam', async () => {
    const store = statsStore({ stats: { messagesCount: 14, spamMessages: 9 } })
    expect(await store.getMemberStats(-100, 42))
      .toMatchObject({ messagesCount: 14, standingInChat: 5 })
  })

  it('standing equals traffic for a member with no spam behind them', async () => {
    const store = statsStore({ stats: { messagesCount: 14 } })
    expect(await store.getMemberStats(-100, 42))
      .toMatchObject({ messagesCount: 14, standingInChat: 14 })
  })

  it('never reports negative standing', async () => {
    const store = statsStore({ stats: { messagesCount: 2, spamMessages: 7 } })
    expect((await store.getMemberStats(-100, 42)).standingInChat).toBe(0)
  })

  it('a member we have no record of has neither', async () => {
    const store = statsStore(null)
    expect(await store.getMemberStats(-100, 42))
      .toEqual({ messagesCount: 0, standingInChat: 0, bananCount: 0 })
  })

  it('a chat we have no record of has neither', async () => {
    const store = statsStore({ stats: { messagesCount: 99 } }, null)
    expect(await store.getMemberStats(-100, 42))
      .toEqual({ messagesCount: 0, standingInChat: 0, bananCount: 0 })
  })
})

describe('adjustSpamMessages', () => {
  const captureUpdates = () => {
    const updates: { collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }[] = []
    const collection = (name: string) => ({
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ collection: name, filter, update })
        return {}
      }
    })
    const store = {
      users: collection('users'),
      groupMembers: collection('groupMembers'),
      groups: { findOne: async () => ({ _id: 'group-oid' }) }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, { adjustSpamMessages: MongoStore.prototype.adjustSpamMessages }),
      updates
    }
  }

  it('debits standing in both scopes — the chat and the network', async () => {
    // A cross-chat blaster posts once per chat, so a purely per-chat counter
    // would never notice: their global standing is what grows.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1)

    expect(updates.find((u) => u.collection === 'users')?.update).toEqual({
      $inc: { 'globalStats.spamMessages': 1 }
    })
    expect(updates.find((u) => u.collection === 'groupMembers')?.update).toEqual({
      $inc: { 'stats.spamMessages': 1 }
    })
  })

  it('gives the credit back when an admin says it was not spam', async () => {
    // Otherwise a false positive costs its victim standing permanently, and
    // standing is what makes the next false positive less likely.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, -1)

    expect(updates.find((u) => u.collection === 'users')?.update).toEqual({
      $inc: { 'globalStats.spamMessages': -1 }
    })
  })

  it('a decrement cannot drive the counter below zero', async () => {
    // Two independent writers, so the guard belongs in the filter rather than
    // in a read-then-write.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, -1)

    expect(updates.find((u) => u.collection === 'users')?.filter)
      .toMatchObject({ 'globalStats.spamMessages': { $gt: 0 } })
    expect(updates.find((u) => u.collection === 'groupMembers')?.filter)
      .toMatchObject({ 'stats.spamMessages': { $gt: 0 } })
  })

  it('an increment is unguarded — the field may not exist yet', async () => {
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1)

    expect(updates.find((u) => u.collection === 'users')?.filter).toEqual({ telegram_id: 42 })
  })

  it('never creates a document — both were written by the touch calls', async () => {
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1)
    for (const u of updates) expect(u).not.toHaveProperty('options.upsert')
  })

  it('leaves the detection counter alone unless the verdict earned one', async () => {
    // Deleting a message and concluding something about the account are two
    // different claims, and two detections strip an account of the exempt, the
    // ban shield and a clean signal list at once.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1)
    expect(JSON.stringify(updates)).not.toContain('spamDetections')
  })

  it('records the detection globally — it is about the account, not the chat', async () => {
    // Nothing in v2 wrote this field until 2026-08-01, so three mechanisms that
    // read it could only ever see what v1 had left behind.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1, true)

    const users = updates.filter((u) => u.collection === 'users')
    expect(users.map((u) => u.update)).toEqual([
      { $inc: { 'globalStats.spamMessages': 1 } },
      { $inc: { 'globalStats.spamDetections': 1 } }
    ])
    expect(JSON.stringify(updates.filter((u) => u.collection === 'groupMembers')))
      .not.toContain('spamDetections')
  })

  it('the two counters cannot veto each other on the way down', async () => {
    // The floor lives in the filter, so a shared filter would let an
    // already-zero counter block the other one's decrement.
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, -1, true)

    const users = updates.filter((u) => u.collection === 'users')
    expect(users).toHaveLength(2)
    expect(users[0]?.filter).toMatchObject({ 'globalStats.spamMessages': { $gt: 0 } })
    expect(users[0]?.filter).not.toHaveProperty('globalStats.spamDetections')
    expect(users[1]?.filter).toMatchObject({ 'globalStats.spamDetections': { $gt: 0 } })
    expect(users[1]?.filter).not.toHaveProperty('globalStats.spamMessages')
  })
})

describe('recordOverride', () => {
  it('keeps the evidence, not just a pointer to how the verdict was reached', async () => {
    const { store, captured } = captureStore()
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })

    expect(captured.doc).toMatchObject({
      kind: 'override_not_spam',
      // Without these three the label cannot be replayed against new weights.
      signals: ['sleeper_awakened', 'promo_in_bio', 'new_globally'],
      pSpam: 0.82,
      action: 'delete'
    })
    // The score breakdown is what makes the arithmetic reproducible for a
    // verdict that came from a port or the model rather than from signals alone.
    expect((captured.doc?.['meta'] as Record<string, unknown>)['scorePSpam']).toBe(0.82)
  })

  it('still records a label when the verdict could not be recalled', async () => {
    // The decision record expired or the process restarted. An admin did say
    // "not spam", so the label is kept — it simply cannot join a replay.
    const { store, captured } = captureStore()
    await store.recordOverride({
      chatId: -100, messageId: 7, userId: 42, adminId: 1,
      verdict: { decidedBy: 'error', ruleId: null, reasonCode: 'unknown', pSpam: 0, action: 'none', signals: [], meta: {} }
    })

    expect(captured.doc).toMatchObject({ kind: 'override_not_spam', signals: [] })
  })

  it('says who overturned it, because the two do not carry the same authority', async () => {
    const { store, captured } = captureStore()
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })
    expect(captured.doc?.['source'], 'callers written before votes could get here')
      .toBe('admin')

    await store.recordOverride({
      chatId: -100, messageId: 7, userId: 42, adminId: 1, source: 'community_vote', verdict
    })
    expect(captured.doc?.['source']).toBe('community_vote')
  })

  it('REGRESSION: one message, one label — a second tap is not a second mistake', async () => {
    // 2026-08-07: the store held 61 documents for 52 distinct messages, one pair
    // seven seconds apart from the same admin. This collection is the ground
    // truth every false-positive rate is counted over, so a duplicated
    // correction weighs twice in calibration.
    const { store, captured } = captureStore()
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })
    const first = captured.doc?.['createdAt']
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })

    expect(captured.rows.size).toBe(1)
    // The honest timestamp is when we first learned we were wrong.
    expect(captured.doc?.['createdAt']).toBe(first)
    // Keyed on the message: two admins agreeing is not two mistakes either.
    for (const filter of captured.filters) {
      expect(filter).toEqual({ chatId: -100, messageId: 7 })
    }
  })

  it('a different message is still its own label', async () => {
    const { store, captured } = captureStore()
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })
    await store.recordOverride({ chatId: -100, messageId: 8, userId: 42, adminId: 1, verdict })
    expect(captured.rows.size).toBe(2)
  })

  it('only an admin may retire a signature — a chat is not authority over the network', async () => {
    // A signature fires in every chat for ninety days. If a ballot could retire
    // one, a crew posting spam in a group they control could vote their own text
    // clean and take the rule down everywhere.
    const retired: unknown[] = []
    const make = () => {
      const store = {
        feedback: { updateOne: async () => ({}) },
        spamSignatures: { updateOne: async (f: unknown) => { retired.push(f); return {} } }
      } as unknown as MongoStore
      return Object.assign(store, { recordOverride: MongoStore.prototype.recordOverride })
    }
    const bySignature = { ...verdict, decidedBy: 'signature' as const, ruleId: 'abc' }

    await make().recordOverride({
      chatId: -100, messageId: 7, userId: 42, adminId: 1,
      source: 'community_vote', verdict: bySignature
    })
    expect(retired).toHaveLength(0)

    await make().recordOverride({
      chatId: -100, messageId: 7, userId: 42, adminId: 1, source: 'admin', verdict: bySignature
    })
    expect(retired).toHaveLength(1)
  })
})

describe('openVote — the text a resolved vote will teach', () => {
  const capture = (): { store: MongoStore; docs: Record<string, unknown>[] } => {
    const docs: Record<string, unknown>[] = []
    const store = {
      votes: { insertOne: async (d: Record<string, unknown>) => { docs.push(d); return {} } }
    } as unknown as MongoStore
    return { store: Object.assign(store, { openVote: MongoStore.prototype.openVote }), docs }
  }

  it('keeps the text whole enough to hash back to the message that produced it', async () => {
    // 2026-08-02: the field was capped at 1000 characters. A signature is a hash
    // of exactly the text it is handed, so for anything longer the lesson a
    // confirmed vote wrote was filed under a hash no copy of that message can
    // ever produce — while the auto-learned entry, which keeps the text whole,
    // stayed a candidate forever. One text in one chat was voted spam six times
    // and the seventh copy still raised nothing but a candidate signal.
    const { store, docs } = capture()
    const text = 'ц'.repeat(4096) // Telegram's own ceiling for a text message
    await store.openVote({
      chatId: -100, messageId: 1, targetUserId: 2, targetLabel: 'x',
      textPreview: text, openedBy: 3
    })
    expect(docs[0]?.['learnText']).toBe(text)
  })

  it('the display preview stays short — it is a different field for a reason', async () => {
    const { store, docs } = capture()
    await store.openVote({
      chatId: -100, messageId: 1, targetUserId: 2, targetLabel: 'x',
      textPreview: 'я'.repeat(500), openedBy: 3
    })
    expect(String(docs[0]?.['textPreview'])).toHaveLength(200)
  })
})

describe('saveExternalBan', () => {
  const captureStore = () => {
    const updates: Record<string, unknown>[] = []
    const store = {
      users: {
        updateOne: async (_f: unknown, update: Record<string, unknown>) => {
          updates.push(update)
          return {}
        }
      }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, { saveExternalBan: MongoStore.prototype.saveExternalBan }),
      updates
    }
  }
  const NOW = new Date('2026-08-03T12:00:00Z')

  it('writes each answer it has and clears that source failure marker', async () => {
    const { store, updates } = captureStore()
    await store.saveExternalBan(42, { lols: { banned: false }, cas: null }, NOW)
    expect(updates).toEqual([{
      $set: { 'externalBan.lols': { banned: false } },
      $unset: { 'externalBan.failedAt.lols': '' }
    }])
  })

  it('REGRESSION: a source that was asked and said nothing leaves a mark', async () => {
    // Silence used to write nothing, so the retry had no floor: every later
    // message from the same account re-queried both databases (2026-08-03).
    const { store, updates } = captureStore()
    await store.saveExternalBan(42, {
      lols: null, cas: { banned: true }, attempted: { lols: true, cas: true }
    }, NOW)
    expect(updates).toEqual([{
      $set: { 'externalBan.failedAt.lols': NOW, 'externalBan.cas': { banned: true } },
      $unset: { 'externalBan.failedAt.cas': '' }
    }])
  })

  it('a source that was never asked is not recorded as having failed', async () => {
    const { store, updates } = captureStore()
    await store.saveExternalBan(42, {
      lols: null, cas: { banned: false }, attempted: { lols: false, cas: true }
    }, NOW)
    expect(updates[0]?.['$set']).toEqual({ 'externalBan.cas': { banned: false } })
  })

  it('writes nothing at all when there is nothing to say', async () => {
    const { store, updates } = captureStore()
    await store.saveExternalBan(42, { lols: null, cas: null })
    expect(updates).toEqual([])
  })
})

/**
 * Startup must survive a collection that does not exist yet.
 *
 * Production 2026-08-20 08:23: the bot crash-looped on
 * `ns does not exist: LyAdminBot.burst_windows`. `burst_windows` was the newest
 * TTL collection and nothing had written to it, so it had no namespace —
 * `listIndexes` on a missing namespace is an error, while `createIndex` would
 * have created the collection implicitly. Reading the existing indexes before
 * writing one therefore made every NEW TTL collection an unbootable bot on its
 * first deploy, in a restart loop that never reaches the write that fixes it.
 */
describe('ensureTtlIndex', () => {
  interface FakeIndex { key: Record<string, number>; name?: string; expireAfterSeconds?: number }

  const fakeCollection = (indexes: () => Promise<FakeIndex[]>) => {
    const created: { keySpec: unknown; options: unknown }[] = []
    const dropped: string[] = []
    return {
      created,
      dropped,
      collection: {
        collectionName: 'burst_windows',
        indexes,
        createIndex: async (keySpec: unknown, options: unknown) => {
          created.push({ keySpec, options })
          return 'idx'
        },
        dropIndex: async (name: string) => { dropped.push(name) }
      } as never
    }
  }

  it('REGRESSION: a missing namespace is not an error, it is an empty collection', async () => {
    const nsNotFound = Object.assign(
      new Error('ns does not exist: LyAdminBot.burst_windows'),
      { code: 26, codeName: 'NamespaceNotFound' }
    )
    const { collection, created } = fakeCollection(() => Promise.reject(nsNotFound))
    await ensureTtlIndex(collection, { startedAt: 1 }, 600)
    expect(created).toEqual([{ keySpec: { startedAt: 1 }, options: { expireAfterSeconds: 600 } }])
  })

  it('any OTHER failure to read the indexes still propagates', async () => {
    // Not authorized, not reachable, wrong database: configuration faults. A bot
    // that quietly carried on without its TTL indexes would fill the cluster
    // instead of saying so. Only the empty case is benign.
    const unauthorized = Object.assign(new Error('not authorized'), { code: 13 })
    const { collection, created } = fakeCollection(() => Promise.reject(unauthorized))
    await expect(ensureTtlIndex(collection, { startedAt: 1 }, 600)).rejects.toThrow('not authorized')
    expect(created).toEqual([])
  })

  it('an existing index with a different expiry is dropped and recreated', async () => {
    const { collection, created, dropped } = fakeCollection(async () =>
      [{ key: { startedAt: 1 }, name: 'startedAt_1', expireAfterSeconds: 999 }])
    await ensureTtlIndex(collection, { startedAt: 1 }, 600)
    expect(dropped).toEqual(['startedAt_1'])
    expect(created).toEqual([{ keySpec: { startedAt: 1 }, options: { expireAfterSeconds: 600 } }])
  })

  it('a matching index is left alone', async () => {
    const { collection, dropped } = fakeCollection(async () =>
      [{ key: { startedAt: 1 }, name: 'startedAt_1', expireAfterSeconds: 600 }])
    await ensureTtlIndex(collection, { startedAt: 1 }, 600)
    expect(dropped).toEqual([])
  })
})

/**
 * A vote nobody answers used to stay open forever: the prompt was the only
 * notice the bot posts without a deletion timer, and the document behind it
 * expired after seven days while the buttons stayed in the chat — so a tap on
 * day eight answered "already closed" about a question that never closed.
 *
 * Worse than untidy: nothing is learned from an unresolved vote, so every
 * question the chat ignored dropped the correction channel on the floor.
 */
describe('vote lifetime', () => {
  const voteStore = (rows: Record<string, unknown>[] = []) => {
    const inserted: Record<string, unknown>[] = []
    const finds: Record<string, unknown>[] = []
    const updates: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = []
    let modified = 1
    const store = {
      votes: {
        insertOne: async (doc: Record<string, unknown>) => { inserted.push(doc); return {} },
        find: (filter: Record<string, unknown>) => {
          finds.push(filter)
          return { limit: () => ({ toArray: async () => rows }) }
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          updates.push({ filter, update })
          return { modifiedCount: modified }
        }
      }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, {
        openVote: MongoStore.prototype.openVote,
        castBallot: MongoStore.prototype.castBallot,
        claimExpiredVotes: MongoStore.prototype.claimExpiredVotes
      }),
      inserted,
      finds,
      updates,
      setModified: (n: number) => { modified = n }
    }
  }

  it('stamps an opened vote with the moment it stops accepting ballots', async () => {
    const { store, inserted } = voteStore()
    const before = Date.now()
    await store.openVote({
      chatId: -100, messageId: 5, targetUserId: 42, targetLabel: 'Alex',
      textPreview: 'buy now', openedBy: 1
    })
    const expiresAt = inserted[0]?.['expiresAt'] as Date
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(VOTE_WINDOW_SECONDS * 1000 - 1000)
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(VOTE_WINDOW_SECONDS * 1000 + 1000)
  })

  it('records the voter name alongside the ballot', async () => {
    // Resolved later, the roster has to name who voted; the display name is
    // free at tap time and a lookup afterwards would cost a call per voter.
    const { store, updates } = voteStore()
    await store.castBallot({
      chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'spam', label: 'Олег'
    })
    const pushed = (updates[0]?.update as Record<string, Record<string, unknown>>)['$push']
    expect(pushed?.['ballots']).toMatchObject({ userId: 7, choice: 'spam', label: 'Олег' })
  })

  it('a ballot with no name still records the vote', async () => {
    const { store, updates } = voteStore()
    await store.castBallot({ chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'ham' })
    const pushed = (updates[0]?.update as Record<string, Record<string, unknown>>)['$push']
    expect(pushed?.['ballots']).toMatchObject({ userId: 7, choice: 'ham' })
    expect(pushed?.['ballots']).not.toHaveProperty('label')
  })

  it('refuses a ballot for a window that has already passed', async () => {
    // The sweep runs once a minute, so `status: 'open'` alone leaves up to a
    // minute — and the whole of a restart gap — in which a closed question
    // still accepts answers.
    const { store, updates } = voteStore()
    await store.castBallot({ chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'spam' })
    expect(updates[0]?.filter).toMatchObject({ status: 'open' })
    expect(updates[0]?.filter).toHaveProperty('expiresAt')
  })

  it('reports whether the ballot was actually written', async () => {
    // The filter can miss for two reasons the caller must not confuse with
    // success: the question closed, or its window ran out before the sweep
    // noticed. Both used to come back as `void` and be answered "counted".
    const { store, setModified } = voteStore()
    expect(await store.castBallot({
      chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'spam'
    })).toBe(true)
    setModified(0)
    expect(await store.castBallot({
      chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'spam'
    })).toBe(false)
  })

  it('also claims a vote written before votes had a window at all', async () => {
    // Rows from before this field existed matched neither the ballot filter
    // (`expiresAt > now`) nor a plain `expiresAt <= now` sweep, so they stayed
    // apparently open, silently refused every ballot, and kept their prompt in
    // the chat until the collection TTL took the document — and not the
    // prompt — seven days later.
    const { store, finds } = voteStore()
    await store.claimExpiredVotes()
    expect(JSON.stringify(finds[0])).toContain('$or')
  })

  it('claims a vote whose window has passed and marks it expired', async () => {
    const { store, updates } = voteStore([
      { chatId: -100, messageId: 5, targetUserId: 42, promptMessageId: 900 }
    ])
    const claimed = await store.claimExpiredVotes()
    expect(claimed).toEqual([
      { chatId: -100, messageId: 5, targetUserId: 42, promptMessageId: 900 }
    ])
    expect(updates[0]?.update).toMatchObject({ $set: { status: 'expired' } })
    // The claim must only take a vote that is still open, or two sweeps racing
    // would both act on it.
    expect(updates[0]?.filter).toMatchObject({ chatId: -100, messageId: 5, status: 'open' })
  })

  it('does not claim a vote another sweep already took', async () => {
    const { store, setModified } = voteStore([
      { chatId: -100, messageId: 5, targetUserId: 42, promptMessageId: 900 }
    ])
    setModified(0)
    expect(await store.claimExpiredVotes()).toEqual([])
  })

  it('reports no prompt when the vote never got one', async () => {
    const { store } = voteStore([{ chatId: -100, messageId: 5, targetUserId: 42 }])
    expect((await store.claimExpiredVotes())[0]?.promptMessageId).toBeNull()
  })
})

/**
 * A community verdict becomes hard history about the account, and two of them
 * strip the vote, the exempt and the ban shield. So the second one has to come
 * from somewhere else: one chat can be captured by the very crew being judged,
 * two rarely are — the same reasoning the signature layer already applies to
 * learning a rule.
 */
describe('recordSpamDetection', () => {
  const detectionStore = () => {
    const updates: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = []
    const store = {
      users: {
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          updates.push({ filter, update })
          return {}
        }
      }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, { recordSpamDetection: MongoStore.prototype.recordSpamDetection }),
      updates
    }
  }

  it('counts a detection only for a chat that has not produced one', async () => {
    const { store, updates } = detectionStore()
    await store.recordSpamDetection(-100, 42)
    expect(updates[0]?.filter).toMatchObject({
      telegram_id: 42,
      'globalStats.detectionChats': { $ne: -100 }
    })
  })

  it('remembers which chat it came from, so the next one must differ', async () => {
    const { store, updates } = detectionStore()
    await store.recordSpamDetection(-100, 42)
    expect(updates[0]?.update).toMatchObject({
      $inc: { 'globalStats.spamDetections': 1 },
      $addToSet: { 'globalStats.detectionChats': -100 }
    })
  })

  it('does not touch the standing counters', async () => {
    // The message was already debited by the enforcement that opened the vote.
    const { store, updates } = detectionStore()
    await store.recordSpamDetection(-100, 42)
    expect(JSON.stringify(updates)).not.toContain('spamMessages')
  })
})


/**
 * `requireCaptcha` is the one verdict field whose reader runs long after the
 * verdict left memory, so a serializer that drops it fails only in production
 * and only for the person it hurts.
 *
 * `restitutionLiftsRestrictions` uses it to decide whether a ham vote owes the
 * sender an unmute. Until 2026-08-25 `recordDecision` never wrote it, so once
 * the in-process cache evicted the verdict — or the bot restarted — a
 * delete-plus-captcha reloaded as a plain delete, and the chat's own
 * exoneration quietly failed to lift the restriction it had imposed.
 */
describe('recordDecision / getDecision — requireCaptcha round-trip', () => {
  const verdict = (requireCaptcha: boolean): Parameters<typeof MongoStore.prototype.recordDecision>[0]['verdict'] =>
    ({
      pSpam: 0.7, action: 'delete', needsVote: true, banDurationSeconds: null,
      decidedBy: 'score', ruleId: null, signals: [], reasonCode: 'content_unconfirmed',
      reasonEvidence: null, meta: {}, requireCaptcha
    }) as never

  const writer = (): { inserted: Record<string, unknown>[]; store: MongoStore } => {
    const inserted: Record<string, unknown>[] = []
    const store = Object.assign(
      { decisions: { insertOne: async (doc: Record<string, unknown>) => { inserted.push(doc) } } } as unknown as MongoStore,
      { recordDecision: MongoStore.prototype.recordDecision }
    )
    return { inserted, store }
  }

  it('stores the flag so restitution can find it later', async () => {
    const { inserted, store } = writer()
    await store.recordDecision({
      chatId: -100, userId: 7, messageId: 10, textPreview: 'x',
      verdict: verdict(true), latencyMs: 1
    })
    expect(inserted[0]?.['requireCaptcha']).toBe(true)
  })

  it('stores a definite false rather than omitting the field', async () => {
    const { inserted, store } = writer()
    await store.recordDecision({
      chatId: -100, userId: 7, messageId: 10, textPreview: 'x',
      verdict: verdict(false), latencyMs: 1
    })
    expect(inserted[0]?.['requireCaptcha']).toBe(false)
  })

  it('reads the flag back, and reads a pre-2026-08-25 record as false', async () => {
    const load = (doc: Record<string, unknown>): Promise<unknown> => {
      const store = Object.assign(
        { decisions: { findOne: async () => doc } } as unknown as MongoStore,
        { getDecision: MongoStore.prototype.getDecision }
      )
      return store.getDecision(-100, 10)
    }
    await expect(load({ action: 'delete', requireCaptcha: true }))
      .resolves.toMatchObject({ requireCaptcha: true })
    // The field simply did not exist on older records; false is what the code
    // effectively assumed for all of them anyway.
    await expect(load({ action: 'delete' })).resolves.toMatchObject({ requireCaptcha: false })
  })
})

/**
 * The baseline is the only thing that survives a restart to tell an edit from a
 * fresh message, and it is read straight into a signal that carries a 0.93 rule.
 * So the question under test is not "does it read the field" but "what does it
 * do with a field that is only half there" — a record from an older build, or a
 * write that lost a key. Reading a missing count as zero would report the whole
 * message as freshly injected and convict an ordinary edit.
 */
describe('getEditBaseline', () => {
  const baselineStore = (doc: Record<string, unknown> | null): MongoStore => {
    const store = {
      decisions: { findOne: async () => doc }
    } as unknown as MongoStore
    return Object.assign(store, { getEditBaseline: MongoStore.prototype.getEditBaseline })
  }

  it('returns the stored counters', async () => {
    const store = baselineStore({ editBaseline: { urls: 2, mentions: 1, invisibles: 0 } })
    await expect(store.getEditBaseline(-100, 10)).resolves.toEqual({ urls: 2, mentions: 1, invisibles: 0 })
  })

  it('reads no record as no baseline, never as a zero baseline', async () => {
    await expect(baselineStore(null).getEditBaseline(-100, 10)).resolves.toBeNull()
  })

  it('refuses a partial record rather than defaulting its counts to zero', async () => {
    const store = baselineStore({ editBaseline: { urls: 2 } })
    await expect(store.getEditBaseline(-100, 10)).resolves.toBeNull()
  })

  it('asks for the newest version of the message', async () => {
    const calls: Record<string, unknown>[] = []
    const store = Object.assign(
      { decisions: { findOne: async (filter: Record<string, unknown>, opts: Record<string, unknown>) => { calls.push({ filter, opts }); return null } } } as unknown as MongoStore,
      { getEditBaseline: MongoStore.prototype.getEditBaseline }
    )
    await store.getEditBaseline(-100, 10)
    expect(calls[0]).toMatchObject({
      filter: { chatId: -100, messageId: 10 },
      opts: { sort: { createdAt: -1 } }
    })
  })
})

/**
 * The one method here that destroys data, and the one whose mistakes would not
 * be visible until somebody lost their standing. Both queries are pinned in
 * full, and a document is run through each of them, because every clause is
 * load-bearing and a filter that quietly matches nothing looks exactly like a
 * filter that has nothing to do.
 */
describe('pruneDormantRecords', () => {
  const DAY = 86_400_000

  /** Records every filter and reports a fixed number of hits. */
  const pruneStore = (): {
    store: MongoStore
    seen: { members?: Record<string, unknown>; users?: Record<string, unknown> }
    deleted: unknown[]
  } => {
    const seen: { members?: Record<string, unknown>; users?: Record<string, unknown> } = {}
    const deleted: unknown[] = []
    const collection = (key: 'members' | 'users', ids: string[]) => ({
      find: (filter: Record<string, unknown>, opts: Record<string, unknown>) => {
        seen[key] = { filter, opts }
        return { toArray: async () => ids.map((_id) => ({ _id })) }
      },
      deleteMany: async (filter: unknown) => {
        deleted.push(filter)
        return { deletedCount: ids.length }
      }
    })
    const store = {
      groupMembers: collection('members', ['m1', 'm2']),
      users: collection('users', ['u1'])
    } as unknown as MongoStore
    return {
      store: Object.assign(store, { pruneDormantRecords: MongoStore.prototype.pruneDormantRecords }),
      seen,
      deleted
    }
  }

  it('deletes on the predicate AND the ids, not on the ids alone', async () => {
    const { store, deleted, seen } = pruneStore()
    await expect(store.pruneDormantRecords()).resolves.toEqual({ members: 2, users: 1 })
    // The ids bound the batch; the predicate still decides. On `_id` alone, a
    // member who posts between the select and the delete has their row updated
    // and then removed anyway — the one case worth protecting against, because
    // it is the only one where the record had stopped being dormant. Re-asserting
    // the filter makes the delete a no-op for exactly those rows.
    expect(deleted[0]).toEqual({ ...(seen.members?.['filter'] as object), _id: { $in: ['m1', 'm2'] } })
    expect(deleted[1]).toEqual({ ...(seen.users?.['filter'] as object), _id: { $in: ['u1'] } })
  })

  it('honours the batch ceiling on both collections', async () => {
    const { store, seen } = pruneStore()
    await store.pruneDormantRecords(7)
    expect(seen.members?.['opts']).toMatchObject({ limit: 7 })
    expect(seen.users?.['opts']).toMatchObject({ limit: 7 })
  })

  /** Applies a captured Mongo filter to a plain object, for the clauses used here. */
  const matches = (filter: Record<string, unknown>, doc: Record<string, unknown>): boolean => {
    const read = (path: string): unknown =>
      path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], doc)
    const test = (cond: unknown, value: unknown): boolean => {
      if (cond === null || typeof cond !== 'object') return value === cond
      return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
        switch (op) {
          case '$lte': return typeof value === 'number' && value <= (arg as number)
          case '$lt': return value instanceof Date && value < (arg as Date)
          case '$ne': return value !== arg
          case '$gt': return typeof value === 'number' && value > (arg as number)
          // Mongo matches a missing field against a null in the list.
          case '$in': return Array.isArray(arg) &&
            (arg.includes(value) || (value === undefined && arg.includes(null)))
          case '$exists': return (value !== undefined) === arg
          case '$not': return !test(arg, value)
          default: throw new Error(`unsupported operator ${op}`)
        }
      })
    }
    return Object.entries(filter).every(([key, cond]) =>
      key === '$or'
        ? (cond as Record<string, unknown>[]).some((c) => matches(c, doc))
        : test(cond, read(key)))
  }

  const memberFilter = async (): Promise<Record<string, unknown>> => {
    const { store, seen } = pruneStore()
    await store.pruneDormantRecords()
    return seen.members?.['filter'] as Record<string, unknown>
  }
  const userFilter = async (): Promise<Record<string, unknown>> => {
    const { store, seen } = pruneStore()
    await store.pruneDormantRecords()
    return seen.users?.['filter'] as Record<string, unknown>
  }

  const ancient = new Date(Date.now() - 400 * DAY)
  const recent = new Date(Date.now() - 2 * DAY)

  it('takes a member who left one message and never came back, by either clock', async () => {
    const filter = await memberFilter()
    // v1 wrote `updatedAt`, and v2 does since 2026-08-24...
    expect(matches(filter, { stats: { messagesCount: 1 }, updatedAt: ancient })).toBe(true)
    // ...but 33567 rows predate that write and can never acquire one, because a
    // member who posted once and never returned is never touched again. Those
    // carry `stats.firstMessageAt` from their insert.
    expect(matches(filter, { stats: { messagesCount: 1, firstMessageAt: ancient } })).toBe(true)
    // A recent first message is not dormancy whichever field records it.
    expect(matches(filter, { stats: { messagesCount: 1, firstMessageAt: recent } })).toBe(false)
  })

  it('spares a member with standing, a record, or a recent visit', async () => {
    const filter = await memberFilter()
    for (const doc of [
      { stats: { messagesCount: 40 }, updatedAt: ancient }, // a regular
      { stats: { messagesCount: 1 }, updatedAt: recent }, // still around
      { stats: { messagesCount: 1, spamMessages: 1 }, updatedAt: ancient }, // caught once
      { stats: { messagesCount: 1 }, banan: { num: 2 }, updatedAt: ancient }, // warned
      { stats: { messagesCount: 1 }, score: -5, updatedAt: ancient } // scored
    ]) expect(matches(filter, doc), JSON.stringify(doc)).toBe(false)
  })

  it('takes a user seen once, by either clock', async () => {
    const filter = await userFilter()
    // v1 wrote lastActive...
    expect(matches(filter, { globalStats: { totalMessages: 1, lastActive: ancient } })).toBe(true)
    // ...and v2 documents have only firstSeen.
    expect(matches(filter, { globalStats: { totalMessages: 1, firstSeen: ancient } })).toBe(true)
  })

  it('spares any user somebody has passed judgement on', async () => {
    const filter = await userFilter()
    const seenOnce = { totalMessages: 1, lastActive: ancient }
    for (const doc of [
      { globalStats: { ...seenOnce, totalMessages: 5 } },
      { globalStats: { totalMessages: 1, lastActive: recent } },
      { globalStats: { totalMessages: 1, firstSeen: recent } },
      { globalStats: { ...seenOnce, spamDetections: 1 } },
      { globalStats: seenOnce, reputation: { status: 'suspicious' } },
      { globalStats: seenOnce, reputation: { status: 'trusted' } },
      { globalStats: seenOnce, externalBan: { cas: { banned: true } } },
      { globalStats: seenOnce, externalBan: { lols: { banned: true } } },
      { globalStats: seenOnce, isGlobalBanned: true }
    ]) expect(matches(filter, doc), JSON.stringify(doc)).toBe(false)
  })

  it('spares a user we have seen in more than one chat', async () => {
    // `many_shared_chats` fires on this counter for accounts with almost no
    // messages — the very population every other clause here selects. Without
    // the guard the sweep would delete the only records that signal can read.
    const filter = await userFilter()
    const base = { totalMessages: 1, lastActive: ancient }
    expect(matches(filter, { globalStats: { ...base, groupsActive: 1 } })).toBe(true)
    expect(matches(filter, { globalStats: { ...base, groupsActive: 5 } })).toBe(false)
  })

  it('never takes a record with no date at all', async () => {
    // The failure that would have made this destructive: a document with
    // neither clock must not fall through into "older than the cutoff".
    expect(matches(await userFilter(), { globalStats: { totalMessages: 1 } })).toBe(false)
    expect(matches(await memberFilter(), { stats: { messagesCount: 1 } })).toBe(false)
  })
})

describe('touchMember', () => {
  it('stamps updatedAt, or nothing it writes is ever prunable', async () => {
    // v1 (mongoose) maintained this field and v2 did not, so it meant "last
    // seen" on old rows and nothing at all on new ones. `dormantFilters` asks
    // `updatedAt < cutoff` and Mongo does not match a missing field against
    // `$lt`, which made every row this method created permanently unsweepable:
    // the backlog would clear once and the collection would then grow for ever.
    let update: Record<string, Record<string, unknown>> = {}
    const store = Object.assign(
      {
        groups: { findOneAndUpdate: async () => ({ _id: 'g1' }) },
        groupMembers: {
          findOneAndUpdate: async (_f: unknown, u: Record<string, Record<string, unknown>>) => {
            update = u
            return { stats: { messagesCount: 3 } }
          }
        }
      } as unknown as MongoStore,
      { touchMember: MongoStore.prototype.touchMember }
    )
    await store.touchMember(-100, 42, 10)
    expect(update['$set']?.['updatedAt']).toBeInstanceOf(Date)

    // And the field the sweep reads must be the one a message moves — not the
    // insert-only stamps beside it, which never change again.
    expect(update['$setOnInsert']).not.toHaveProperty('updatedAt')
  })
})
