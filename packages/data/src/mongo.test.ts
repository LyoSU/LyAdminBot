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
