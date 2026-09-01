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
import { MongoStore, ensureTtlIndex, ensureUniqueIndex, toRightsBlockRecord } from './mongo.js'

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

  /**
   * The two halves answer to different readers, so a missing row resolves them
   * differently. /stats reports traffic and has always shown a member we never
   * counted as zero, which is true. Standing is read by the ballot bar and by
   * every newness signal, and there a zero is an accusation — so the absent row
   * returns no answer at all rather than the worst one.
   */
  it('a member we have no record of has no traffic and no answer on standing', async () => {
    const store = statsStore(null)
    expect(await store.getMemberStats(-100, 42))
      .toEqual({ messagesCount: 0, standingInChat: null, bananCount: 0 })
  })

  it('a chat we have no record of says nothing about standing either', async () => {
    const store = statsStore({ stats: { messagesCount: 99 } }, null)
    expect(await store.getMemberStats(-100, 42))
      .toEqual({ messagesCount: 0, standingInChat: null, bananCount: 0 })
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

  /**
   * The detection counter is not reachable from here AT ALL any more, in either
   * direction. It used to be, on a `detection` flag that did a plain `$inc`,
   * and that made the automatic path able to file any number of detections
   * against one account in one chat — the exact thing `recordSpamDetection`
   * exists to prevent and `voterStandingFor` relies on being impossible.
   */
  it('cannot touch the detection counter in either direction', async () => {
    const { store, updates } = captureUpdates()
    await store.adjustSpamMessages(-100, 42, 1)
    await store.adjustSpamMessages(-100, 42, -1)
    expect(JSON.stringify(updates)).not.toContain('spamDetections')
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
  /** The ballot a pipeline-style `castBallot` write appends after the filter. */
  const writtenBallot = (update: unknown): Record<string, unknown> => {
    const stage = (update as { $set: { ballots: { $concatArrays: unknown[] } } }[])[0]
    const appended = stage?.$set.ballots.$concatArrays[1] as Record<string, unknown>[]
    return appended[0] ?? {}
  }

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
          return {
            limit: () => ({ toArray: async () => rows }),
            project: () => ({ toArray: async () => rows })
          }
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          updates.push({ filter, update })
          return { modifiedCount: modified }
        },
        // The claim reads and flips in one operation, so a question cannot gain
        // a ballot between the sweep seeing it and the sweep taking it.
        findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          updates.push({ filter, update })
          if (modified !== 1) return null
          return rows.find((r) =>
            r['chatId'] === filter['chatId'] && r['messageId'] === filter['messageId']) ?? null
        }
      }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, {
        openVote: MongoStore.prototype.openVote,
        castBallot: MongoStore.prototype.castBallot,
        noteBallotRefusal: MongoStore.prototype.noteBallotRefusal,
        voterDiversity: MongoStore.prototype.voterDiversity,
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
    expect(writtenBallot(updates[0]?.update)).toMatchObject({ userId: 7, choice: 'spam', label: 'Олег' })
  })

  it('a ballot with no name still records the vote', async () => {
    const { store, updates } = voteStore()
    await store.castBallot({ chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'ham' })
    expect(writtenBallot(updates[0]?.update)).toMatchObject({ userId: 7, choice: 'ham' })
    expect(writtenBallot(updates[0]?.update)).not.toHaveProperty('label')
  })

  /**
   * One ballot per voter: the write replaces this voter's earlier ballot and
   * keeps everybody else's. Twenty "expired at three spam ballots" rows in the
   * week to 2026-09-01 were two people, one of them tapping twice.
   */
  it('replaces the voter\'s own earlier ballot rather than appending a second', async () => {
    const { store, updates } = voteStore()
    await store.castBallot({ chatId: -100, messageId: 5, userId: 7, isAdmin: false, choice: 'spam' })
    const stage = (updates[0]?.update as unknown as Record<string, unknown>[])[0] as { $set: { ballots: { $concatArrays: unknown[] } } }
    const [kept] = stage.$set.ballots.$concatArrays as [{ $filter: { cond: { $ne: unknown[] } } }]
    // The kept part is everybody whose userId is not this voter's.
    expect(kept.$filter.cond.$ne).toEqual(['$$b.userId', 7])
    const written = writtenBallot(updates[0]?.update)
    expect(written).toHaveProperty('taps')
    expect(written).toHaveProperty('changedMind')
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

  it('records a refused tap against the question it was refused on', async () => {
    const { store, updates } = voteStore()
    await store.noteBallotRefusal({
      chatId: -100, messageId: 5, userId: 7, reason: 'no_standing',
      messagesInChat: 4, messagesGlobal: 11, tenureDays: 2, detections: 0
    })
    const pushed = (updates[0]?.update as { $push: { refusals: { $each: Record<string, unknown>[] } } })
      .$push.refusals.$each[0]!
    expect(pushed).toMatchObject({
      userId: 7, reason: 'no_standing', inChat: 4, global: 11, tenureDays: 2, detections: 0
    })
    // Only while the question is still askable, and only once per person: five
    // taps are one refusal, and the filter and the push are one operation so
    // two of them racing cannot both land.
    expect(updates[0]?.filter).toMatchObject({
      chatId: -100, messageId: 5, status: 'open', 'refusals.userId': { $ne: 7 }
    })
  })

  it('will not record a refusal on a question whose time is up', async () => {
    // The same guard `castBallot` carries, and for the same reason: the sweep
    // that flips the status runs once a minute, so the status alone leaves a
    // window in which a closed question still takes answers. A refusal past the
    // deadline would be counted as participation the question never had.
    const { store, updates } = voteStore()
    await store.noteBallotRefusal({
      chatId: -100, messageId: 5, userId: 7, reason: 'no_standing',
      messagesInChat: 4, messagesGlobal: 11, tenureDays: 2, detections: 0
    })
    const filter = updates[0]?.filter as { expiresAt?: { $gt: Date } }
    expect(filter.expiresAt?.$gt).toBeInstanceOf(Date)
  })

  it('keeps the refusal array from becoming a membership list', async () => {
    const { store, updates } = voteStore()
    await store.noteBallotRefusal({
      chatId: -100, messageId: 5, userId: 7, reason: 'known_bad',
      messagesInChat: 0, messagesGlobal: 0, tenureDays: null, detections: 3
    })
    const push = (updates[0]?.update as { $push: { refusals: { $slice: number } } }).$push.refusals
    expect(push.$slice).toBeLessThan(0)
  })

  it('measures how wide a chat\'s voting pool actually is', async () => {
    // Two people carrying a room is the shape a per-chat quorum has to see:
    // 2026-08-27 found one chat running 83 questions off six voters.
    const { store } = voteStore([
      { ballots: [{ userId: 1, isAdmin: false }, { userId: 2, isAdmin: false }] },
      { ballots: [{ userId: 1, isAdmin: false }, { userId: 3, isAdmin: false }] },
      { ballots: [{ userId: 1, isAdmin: false }, { userId: 2, isAdmin: false }] },
      { ballots: [], refusals: [{ userId: 9 }, { userId: 9 }] }
    ])
    const pool = await store.voterDiversity(-100)
    expect(pool).toEqual({ questions: 4, voters: 3, refused: 1, topTwoShare: 0.83 })
  })

  it('does not count an admin as an electorate', async () => {
    // An admin decides alone by design, so counting their ballots would report
    // a chat with one attentive admin as a broad community.
    const { store } = voteStore([
      { ballots: [{ userId: 1, isAdmin: true }, { userId: 1, isAdmin: true }] }
    ])
    expect(await store.voterDiversity(-100)).toEqual({
      questions: 1, voters: 0, refused: 0, topTwoShare: 0
    })
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
      {
        chatId: -100, messageId: 5, targetUserId: 42, promptMessageId: 900,
        // Carried out with the claim, because expiry is the one outcome with
        // nothing to show for itself: without these the log can count the
        // questions that lapsed but never say whether anybody tried to answer.
        ballots: [], refusals: []
      }
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
      store: Object.assign(store, {
        recordSpamDetection: MongoStore.prototype.recordSpamDetection,
        clearSpamDetection: MongoStore.prototype.clearSpamDetection
      }),
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

  /**
   * The count and the set have to keep describing the same thing. A bare
   * decrement — which is what a correction did until 2026-08-26 — spends
   * whatever the global counter holds, so restoring a message in one chat could
   * erase a finding another chat earned, leaving a record that said one
   * detection while still naming two rooms.
   */
  it('a correction takes back only the detection its own chat filed', async () => {
    const { store, updates } = detectionStore()
    await store.clearSpamDetection(-100, 42)

    expect(updates[0]?.filter).toEqual({
      telegram_id: 42, 'globalStats.detectionChats': -100
    })
    expect(updates[0]?.update).toEqual({
      $inc: { 'globalStats.spamDetections': -1 },
      $pull: { 'globalStats.detectionChats': -100 }
    })
  })

  it('the membership test is the floor — no chat, nothing to give back', async () => {
    // A chat in the set contributed exactly one, and a chat not in it matches
    // nothing, so a `$gt: 0` guard would be answering a question nobody asks.
    const { store, updates } = detectionStore()
    await store.clearSpamDetection(-100, 42)
    expect(JSON.stringify(updates[0]?.filter)).not.toContain('$gt')
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

  // The baseline's other job (2026-08-28): identify the VERSION it was taken
  // from, so a delivery repeating an already-judged version is recognized after
  // a restart — the in-process cache is gone precisely then. A read that drops
  // these fields silently reopens the replay hole it exists to close.
  it('returns the version identity alongside the counters', async () => {
    const store = baselineStore({
      editBaseline: {
        urls: 1, mentions: 0, invisibles: 0,
        urlKeys: ['5db1f486f81c'], editDate: 1_780_000_100_000, contentKey: 'aabbccddeeff'
      }
    })
    await expect(store.getEditBaseline(-100, 10)).resolves.toEqual({
      urls: 1, mentions: 0, invisibles: 0,
      urlKeys: ['5db1f486f81c'], editDate: 1_780_000_100_000, contentKey: 'aabbccddeeff'
    })
  })

  it('drops identity fields of the wrong type rather than the whole baseline', async () => {
    const store = baselineStore({
      editBaseline: {
        urls: 1, mentions: 0, invisibles: 0,
        urlKeys: 'not-an-array', editDate: 'yesterday', contentKey: 7
      }
    })
    await expect(store.getEditBaseline(-100, 10)).resolves.toEqual({ urls: 1, mentions: 0, invisibles: 0 })
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

/**
 * `pipeline_rights` was the one collection that upserts by a key and had no
 * index on it — `ensureIndexes` covered decisions, feedback, the LLM cache,
 * votes, signatures and profile media, and skipped this one. Production
 * 2026-08-26: 96 documents for 53 chats, 43 of them doubled, several pairs with
 * adjacent `_id`s — two verdicts in the same chat in the same tick, both
 * upserts finding nothing and both inserting.
 *
 * The damage is not the wasted documents. `updateOne` keeps hitting whichever
 * copy comes first, `loadRightsBlocks` returns both, and `restore()` sets the
 * map once per document — so the record the bot adopts at boot is the LAST one
 * returned, which on the chat that prompted this was the copy nothing had
 * written to since the day before: `strikes: 1`, `warnedUntil: 0`. That is the
 * 2026-08-07 regression this file's persistence exists to prevent, coming back
 * through the index list instead of through the code.
 */
describe('ensureUniqueIndex', () => {
  interface FakeDoc {
    _id: string; chatId?: number; messageId?: number
    updatedAt?: Date | number; createdAt?: Date | number
  }

  interface FakeIndex { name: string; key: Record<string, number>; unique?: boolean }

  const fakeCollection = (
    docs: FakeDoc[],
    createIndex?: () => Promise<string>,
    existing: FakeIndex[] = []
  ) => {
    const deleted: unknown[] = []
    const created: { keySpec: unknown; options: unknown }[] = []
    const dropped: string[] = []
    return {
      deleted,
      created,
      dropped,
      collection: {
        collectionName: 'pipeline_rights',
        find: () => ({ project: () => ({ toArray: async () => docs }) }),
        deleteMany: async (filter: { _id: { $in: unknown[] } }) => {
          deleted.push(...filter._id.$in)
          return { deletedCount: filter._id.$in.length }
        },
        indexes: async () => [{ name: '_id_', key: { _id: 1 } }, ...existing],
        dropIndex: async (name: string) => {
          dropped.push(name)
        },
        createIndex: async (keySpec: unknown, options: unknown) => {
          created.push({ keySpec, options })
          return createIndex ? await createIndex() : 'idx'
        }
      } as never
    }
  }

  it('keeps the copy the writes have been landing on, and drops the rest', async () => {
    const { collection, deleted, created } = fakeCollection([
      { _id: 'a', chatId: -100, updatedAt: new Date('2026-08-26T11:46:00Z') },
      { _id: 'b', chatId: -100, updatedAt: new Date('2026-08-25T15:03:00Z') },
      { _id: 'c', chatId: -200, updatedAt: new Date('2026-08-01T00:00:00Z') }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual(['b'])
    expect(created).toEqual([{ keySpec: { chatId: 1 }, options: { unique: true } }])
  })

  /**
   * `pipeline_feedback` is keyed by the PAIR, so two rows sharing only the chat
   * are different labels about different messages and must both survive.
   */
  it('collapses on the whole composite key, not on its first field', async () => {
    const { collection, deleted, created } = fakeCollection([
      { _id: 'a', chatId: -100, messageId: 1, createdAt: 2 },
      { _id: 'b', chatId: -100, messageId: 2, createdAt: 3 },
      { _id: 'c', chatId: -100, messageId: 1, createdAt: 1 }
    ])
    await ensureUniqueIndex(collection, 'chatId', 'messageId')
    expect(deleted).toEqual(['c'])
    expect(created).toEqual([{ keySpec: { chatId: 1, messageId: 1 }, options: { unique: true } }])
  })

  it('leaves a clean collection alone and still creates the index', async () => {
    const { collection, deleted, created } = fakeCollection([
      { _id: 'a', chatId: -100, updatedAt: new Date() }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual([])
    expect(created).toHaveLength(1)
  })

  /**
   * Both copies of a pair are often written in the same millisecond — that is
   * how they came to exist. A rule that cannot separate them would drop both or
   * keep both; the id breaks the tie, and it breaks it towards the later insert.
   */
  it('breaks a tie on the timestamp rather than keeping both', async () => {
    const { collection, deleted } = fakeCollection([
      { _id: 'aaa1', chatId: -100, updatedAt: 1000 },
      { _id: 'aaa2', chatId: -100, updatedAt: 1000 }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual(['aaa1'])
  })

  /**
   * `pipeline_feedback` stamps `createdAt` and never `updatedAt`, and it is the
   * second collection found carrying this defect — 9 doubled pairs in 182
   * documents on 2026-08-26, in the one permanent record of a human saying
   * "this was not spam". Reading only `updatedAt` there would fall back to the
   * id, which happens to pick the same survivor for the wrong reason.
   */
  it('falls back to createdAt for a collection that stamps only that', async () => {
    // The ids are deliberately ordered AGAINST the timestamps: falling back to
    // the id would drop 'a', and only reading `createdAt` drops 'b'.
    const { collection, deleted } = fakeCollection([
      { _id: 'a', chatId: -100, createdAt: new Date('2026-08-26T00:00:00Z') },
      { _id: 'b', chatId: -100, createdAt: new Date('2026-08-20T00:00:00Z') }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual(['b'])
  })

  /** A write stamp beats a creation stamp: it is the later fact about the row. */
  it('prefers updatedAt when a document carries both', async () => {
    const { collection, deleted } = fakeCollection([
      { _id: 'a', chatId: -100, updatedAt: 9000, createdAt: 1 },
      { _id: 'b', chatId: -100, updatedAt: 10, createdAt: 9999 }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual(['b'])
  })

  it('treats a document with no timestamp as the oldest', async () => {
    const { collection, deleted } = fakeCollection([
      { _id: 'a', chatId: -100 },
      { _id: 'b', chatId: -100, updatedAt: 1 }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(deleted).toEqual(['a'])
  })

  /**
   * A second instance can insert a duplicate between the sweep and the create —
   * a rolling deploy is two bots for a few seconds. Refusing to boot over that
   * would trade a doubled document for no moderation at all, which is the wrong
   * side of the 2026-08-20 crash-loop lesson.
   */
  it('REGRESSION: a duplicate that slipped in during the sweep does not stop the boot', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    const { collection } = fakeCollection([], () => Promise.reject(dup))
    await expect(ensureUniqueIndex(collection, 'chatId')).resolves.toBeUndefined()
  })

  /**
   * 2026-08-26, 71 minutes with no moderation: `pipeline_feedback` already
   * carried a NON-unique index on the same key, so `createIndex` raised
   * IndexOptionsConflict (85) rather than 11000, and the boot died on it.
   * There is no failure of index hygiene worth trading for a bot that is not
   * in the chats — the collections here work unindexed, they are tiny.
   */
  it('REGRESSION: no failure to create the index stops the boot', async () => {
    for (const code of [11000, 85, 86, 13, undefined]) {
      const err = Object.assign(new Error(`index failure ${String(code)}`), { code })
      const { collection } = fakeCollection([], () => Promise.reject(err))
      await expect(ensureUniqueIndex(collection, 'chatId')).resolves.toBeUndefined()
    }
  })

  it('REGRESSION: replaces an index that has the right key and is not unique', async () => {
    const { collection, created, dropped } = fakeCollection([], undefined, [
      { name: 'chatId_1_messageId_1', key: { chatId: 1, messageId: 1 } }
    ])
    await ensureUniqueIndex(collection, 'chatId', 'messageId')
    expect(dropped).toEqual(['chatId_1_messageId_1'])
    expect(created).toEqual([
      { keySpec: { chatId: 1, messageId: 1 }, options: { unique: true } }
    ])
  })

  it('leaves an index that is already unique alone', async () => {
    const { collection, created, dropped } = fakeCollection([], undefined, [
      { name: 'chatId_1', key: { chatId: 1 }, unique: true }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(dropped).toEqual([])
    expect(created).toEqual([])
  })

  it('does not touch an index on other fields', async () => {
    const { collection, created, dropped } = fakeCollection([], undefined, [
      { name: 'userId_1', key: { userId: 1 } }
    ])
    await ensureUniqueIndex(collection, 'chatId')
    expect(dropped).toEqual([])
    expect(created).toHaveLength(1)
  })
})


/**
 * The read side of `pipeline_rights`, which is a migration boundary twice over:
 * `strikes`/`probeAt`/`warnedUntil` arrived on 2026-08-07 and
 * `lastRefusalAt`/`blockedAccounts` on 2026-08-26, both into a collection whose
 * documents outlive the release that wrote them. On the second of those days
 * every one of the 52 live documents lacked the newer pair — and the code that
 * adopts them pushes into `blockedAccounts` on the next refusal.
 */
describe('toRightsBlockRecord', () => {
  it('reads a document written before the newest fields existed', () => {
    expect(toRightsBlockRecord({
      chatId: -1001163856087, deleteRefused: false, senderRefused: true,
      strikes: 1, probeAt: 1_787_000_000_000, warnedUntil: 1_787_100_000_000
    })).toEqual({
      chatId: -1001163856087, deleteRefused: false, senderRefused: true,
      strikes: 1, probeAt: 1_787_000_000_000, warnedUntil: 1_787_100_000_000,
      // Never a guess at "now": an unknown last refusal must read as no opinion,
      // so the episode carries on rather than being broken by our own gap.
      lastRefusalAt: 0,
      // An array, not undefined — this one gets pushed into.
      blockedAccounts: []
    })
  })

  it('round-trips a document written by the current code', () => {
    const record = {
      chatId: -100, deleteRefused: true, senderRefused: true,
      strikes: 7, probeAt: 42, warnedUntil: 99,
      lastRefusalAt: 1_787_200_000_000, blockedAccounts: [111, 222]
    }
    expect(toRightsBlockRecord({ ...record, _id: 'x', updatedAt: new Date() })).toEqual(record)
  })

  it('a blockedAccounts that is not a list is dropped, not trusted', () => {
    expect(toRightsBlockRecord({ chatId: -100, blockedAccounts: 'everyone' }).blockedAccounts)
      .toEqual([])
  })

  it('unreadable ids inside the list go, and the readable ones stay', () => {
    expect(toRightsBlockRecord({ chatId: -100, blockedAccounts: [111, null, 'x', 222] }).blockedAccounts)
      .toEqual([111, 222])
  })

  it('a missing count is zero, never NaN', () => {
    // `Number(undefined)` is NaN, and a NaN strike count silently disables the
    // whole backoff ladder: every comparison against it is false.
    const r = toRightsBlockRecord({ chatId: -100 })
    expect([r.strikes, r.probeAt, r.warnedUntil, r.lastRefusalAt]).toEqual([0, 0, 0, 0])
  })
})

/**
 * The captcha funnel, which had no record at all until 2026-08-28.
 *
 * Measured over the 47.6 hours to 2026-08-27: 65 gates, of which exactly four
 * were legible afterwards — the ones nobody answered. Their timing (165s, four
 * times, which is 45 + 120) proves the public fallback fires as designed, but
 * the 61 remaining gates were invisible: a tap wrote nothing anywhere, so
 * "answered at 20s, chat saw nothing" and "answered at 90s, publicly accused
 * first" were the same non-event. `ageMs` and `wentPublic` are the two fields
 * that separate them, and `event` is what finally distinguishes a gate that
 * reached somebody from one that was never delivered.
 */
describe('recordCaptchaEvent — the funnel a tap used to leave no trace of', () => {
  const captureCaptcha = (): { store: MongoStore; docs: Record<string, unknown>[] } => {
    const docs: Record<string, unknown>[] = []
    const store = {
      captchaEvents: { insertOne: async (doc: Record<string, unknown>) => { docs.push(doc); return {} } }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, { recordCaptchaEvent: MongoStore.prototype.recordCaptchaEvent }),
      docs
    }
  }

  it('a pass records how long it took and whether the chat had already seen a card', async () => {
    const { store, docs } = captureCaptcha()
    await store.recordCaptchaEvent({
      chatId: -100, userId: 7, event: 'passed', via: 'whisper', ageMs: 20_400, wentPublic: false
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      chatId: -100, userId: 7, event: 'passed', via: 'whisper', ageMs: 20_400, wentPublic: false
    })
    expect(docs[0]?.['createdAt']).toBeInstanceOf(Date)
  })

  it('a tap after the fallback is the case the 45-second window is about', async () => {
    const { store, docs } = captureCaptcha()
    await store.recordCaptchaEvent({
      chatId: -100, userId: 7, event: 'passed', via: 'visible', ageMs: 91_000, wentPublic: true
    })
    expect(docs[0]).toMatchObject({ ageMs: 91_000, wentPublic: true })
  })

  it('a gate nobody could be asked is recorded, not merely logged', async () => {
    const { store, docs } = captureCaptcha()
    await store.recordCaptchaEvent({ chatId: -100, userId: 7, event: 'undeliverable' })
    expect(docs[0]).toMatchObject({ event: 'undeliverable' })
    // Absent rather than zero: nobody answered, so there is no duration to
    // report, and a 0 here would sink the median of every answered gate.
    expect(docs[0]).not.toHaveProperty('ageMs')
    expect(docs[0]).not.toHaveProperty('via')
  })

  it('telemetry never throws at the caller', async () => {
    const store = Object.assign(
      { captchaEvents: { insertOne: async () => { throw new Error('mongo is down') } } } as unknown as MongoStore,
      { recordCaptchaEvent: MongoStore.prototype.recordCaptchaEvent }
    )
    await expect(store.recordCaptchaEvent({ chatId: -1, userId: 1, event: 'delivered' }))
      .resolves.toBeUndefined()
  })
})

/**
 * Which deterministic rules this chat's admins have worn out.
 *
 * The measurement that motivated it (2026-08-28 audit): one vacancy chat, 5
 * `external_ban_new` bans in a week, 4 reversed by the admin — each reversal a
 * DIFFERENT sender, so the per-user trust an override grants never engaged.
 * The distinct-sender bar is what separates "this rule is wrong for this chat"
 * from one repeatedly-appealed account wearing a rule down alone.
 */
describe('wornRuleIds', () => {
  const over = (userId: number, ruleId: string | null, daysAgo = 1, source = 'admin') => ({
    userId, ruleId, source,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000)
  })
  const feedbackStore = (rows: Record<string, unknown>[]): MongoStore => {
    const filters: Record<string, unknown>[] = []
    const store = {
      feedback: {
        find: (filter: Record<string, unknown>) => {
          filters.push(filter)
          const since = (filter['createdAt'] as { $gte: Date })['$gte']
          return { toArray: async () => rows.filter((r) => (r['createdAt'] as Date) >= since) }
        }
      }
    } as unknown as MongoStore
    return Object.assign(store, { wornRuleIds: MongoStore.prototype.wornRuleIds, filters })
  }

  it('three distinct overridden senders wear a rule out', async () => {
    const store = feedbackStore([
      over(1, 'external_ban_new'), over(2, 'external_ban_new'), over(3, 'external_ban_new')
    ])
    await expect(store.wornRuleIds(-100)).resolves.toEqual(['external_ban_new'])
  })

  it('one sender overridden three times is not three senders', async () => {
    const store = feedbackStore([
      over(1, 'external_ban_new'), over(1, 'external_ban_new'), over(1, 'external_ban_new')
    ])
    await expect(store.wornRuleIds(-100)).resolves.toEqual([])
  })

  it('overrides older than the window do not count', async () => {
    const store = feedbackStore([
      over(1, 'external_ban_new'), over(2, 'external_ban_new'), over(3, 'external_ban_new', 120)
    ])
    await expect(store.wornRuleIds(-100)).resolves.toEqual([])
  })

  it('a verdict without a rule cannot wear one out', async () => {
    const store = feedbackStore([over(1, null), over(2, null), over(3, null)])
    await expect(store.wornRuleIds(-100)).resolves.toEqual([])
  })

  it('asks only for this chat and only for admin corrections', async () => {
    const store = feedbackStore([]) as MongoStore & { filters: Record<string, unknown>[] }
    await store.wornRuleIds(-100)
    expect(store.filters[0]).toMatchObject({
      chatId: -100, kind: 'override_not_spam', source: 'admin'
    })
  })
})

/**
 * Has this sender already been firmly removed in this chat?
 *
 * The question `escalateChannelRecidivism` (core) turns on. Asked of the
 * decisions record rather than memory so a restart does not grant a spamming
 * channel a fresh first offense; the 14-day TTL bounds the lookback, which is
 * plenty against the measured 20–60 minute posting cadence.
 */
describe('hasPriorSenderRemoval', () => {
  const removalStore = (doc: Record<string, unknown> | null): MongoStore & { filters: Record<string, unknown>[] } => {
    const filters: Record<string, unknown>[] = []
    const store = {
      decisions: {
        findOne: async (filter: Record<string, unknown>) => { filters.push(filter); return doc }
      }
    } as unknown as MongoStore
    return Object.assign(store, { hasPriorSenderRemoval: MongoStore.prototype.hasPriorSenderRemoval, filters }) as never
  }

  it('a stored applied removal answers yes', async () => {
    await expect(removalStore({ _id: 1 }).hasPriorSenderRemoval(-100, -1004, 55)).resolves.toBe(true)
  })

  it('no record answers no', async () => {
    await expect(removalStore(null).hasPriorSenderRemoval(-100, -1004, 55)).resolves.toBe(false)
  })

  it('asks for an APPLIED sender-removal, excluding the verdict being executed', async () => {
    const store = removalStore(null)
    await store.hasPriorSenderRemoval(-100, -1004, 55)
    expect(store.filters[0]).toMatchObject({
      chatId: -100,
      userId: -1004,
      action: { $in: ['kick', 'mute', 'ban'] },
      'execution.applied': true,
      messageId: { $ne: 55 }
    })
  })
})

/**
 * The counts behind `/stats`.
 *
 * The card is the only place the bot talks about itself, so what it says has to
 * come from one pass over the window it names — not from a number somebody
 * remembered. These tests pin the query, not the driver.
 */
const statsStore = (
  decisionRows: unknown[],
  extras: { signatures?: number; overrides?: number } = {}
): { store: MongoStore; pipelines: Record<string, unknown>[][] } => {
  const pipelines: Record<string, unknown>[][] = []
  const store = {
    decisions: {
      aggregate: (pipeline: Record<string, unknown>[]) => {
        pipelines.push(pipeline)
        return { toArray: async () => decisionRows }
      }
    },
    spamSignatures: { countDocuments: async () => extras.signatures ?? 0 },
    feedback: { countDocuments: async () => extras.overrides ?? 0 }
  } as unknown as MongoStore
  return {
    store: Object.assign(store, {
      botStats: MongoStore.prototype.botStats,
      chatStats: MongoStore.prototype.chatStats
    }),
    pipelines
  }
}

describe('botStats', () => {
  const facet = (over: Record<string, unknown> = {}): unknown[] => [{
    totals: [{
      checked: 220509, removals: 4970, deletes: 340,
      spammers: 2684, chats: 252, latencyP50Ms: 59.14, ...over
    }],
    reasons: [
      { _id: 'external_ban_new', n: 2303 },
      { _id: 'job_scam', n: 910 }
    ]
  }]

  it('reports one pass over the named window', async () => {
    const { store, pipelines } = statsStore(facet(), { signatures: 2415, overrides: 53 })
    const stats = await store.botStats(14)
    expect(stats.windowDays).toBe(14)
    expect(stats.checked).toBe(220509)
    expect(stats.spammers).toBe(2684)
    expect(stats.chats).toBe(252)
    expect(stats.signatures).toBe(2415)
    expect(stats.overrides).toBe(53)
    // One scan of the decisions, not one per figure.
    expect(pipelines).toHaveLength(1)
  })

  it('rounds the median rather than printing a float at a reader', async () => {
    const { store } = statsStore(facet())
    expect((await store.botStats(14)).latencyP50Ms).toBe(59)
  })

  it('reports no median rather than NaN when nothing was timed', async () => {
    const { store } = statsStore(facet({ latencyP50Ms: null }))
    expect((await store.botStats(14)).latencyP50Ms).toBeNull()
  })

  it('ranks reasons by how often they actually fired', async () => {
    const { store } = statsStore(facet())
    const stats = await store.botStats(14)
    expect(stats.topReasons).toEqual([
      { reasonCode: 'external_ban_new', count: 2303 },
      { reasonCode: 'job_scam', count: 910 }
    ])
  })

  /**
   * An empty window is a fact about the window, not a crash. The card turns
   * this into "numbers unavailable" rather than a row of zeros.
   */
  it('answers an empty collection with zeros instead of throwing', async () => {
    const { store } = statsStore([{ totals: [], reasons: [] }])
    const stats = await store.botStats(14)
    expect(stats.checked).toBe(0)
    expect(stats.topReasons).toEqual([])
    expect(stats.latencyP50Ms).toBeNull()
  })

  it('asks only for the window, so the TTL index carries the query', async () => {
    const { store, pipelines } = statsStore(facet())
    await store.botStats(7)
    const match = pipelines[0]?.[0]?.['$match'] as { createdAt: { $gte: Date } }
    const days = (Date.now() - match.createdAt.$gte.getTime()) / 86_400_000
    expect(days).toBeCloseTo(7, 1)
  })
})

describe('chatStats', () => {
  it('scopes every count to the chat it was asked about', async () => {
    const { store, pipelines } = statsStore([{
      totals: [{ checked: 3481, removals: 27, deletes: 31, spammers: 24, lastActionAt: new Date('2026-08-29T09:41:00Z') }]
    }])
    const stats = await store.chatStats(-100777, 14)
    expect(stats.checked).toBe(3481)
    expect(stats.spammers).toBe(24)
    expect(stats.lastActionAt?.toISOString()).toBe('2026-08-29T09:41:00.000Z')
    const match = pipelines[0]?.[0]?.['$match'] as Record<string, unknown>
    expect(match['chatId']).toBe(-100777)
  })

  it('reports a quiet chat as quiet, with no last-spam moment to show', async () => {
    const { store } = statsStore([{ totals: [{ checked: 900, removals: 0, deletes: 0, spammers: 0, lastActionAt: null }] }])
    const stats = await store.chatStats(-100777, 14)
    expect(stats.removals + stats.deletes).toBe(0)
    expect(stats.lastActionAt).toBeNull()
  })

  it('answers a chat we have never judged with zeros', async () => {
    const { store } = statsStore([{ totals: [] }])
    const stats = await store.chatStats(-100777, 14)
    expect(stats.checked).toBe(0)
    expect(stats.lastActionAt).toBeNull()
  })
})

/**
 * What survives the trip to the database and back.
 *
 * The "Why?" card and the admin's undo both read `recallVerdict`, which tries an
 * in-process map of the last 2000 verdicts and then falls back to this row. At
 * production's rate that map turns over in hours, so the row is what a member
 * actually sees when they tap the link — and the row dropped the grounds.
 *
 * Worse than dropping them: `getDecision` filled `reasonEvidence` from
 * `textPreview`. Those are different facts. The evidence is what convicted
 * somebody — a bio link, a shared avatar, a matched fragment — and the preview
 * is what they wrote. Substituting one for the other showed a spammer's own
 * sentence in the slot the card presents as our reasons, and for a verdict read
 * off a profile (`textPreview: ''`) it showed nothing at all. Measured
 * 2026-09-01: `reasonEvidence` appears on 0 rows of the entire collection.
 *
 * Same defect `requireCaptcha` had, one field over, and the same fix.
 */
describe('recordDecision → getDecision — the grounds survive', () => {
  const roundTrip = (): { store: MongoStore; stored: Record<string, unknown>[] } => {
    const stored: Record<string, unknown>[] = []
    const store = {
      decisions: {
        insertOne: async (doc: Record<string, unknown>) => { stored.push(doc); return {} },
        findOne: async () => stored[stored.length - 1] ?? null
      }
    } as unknown as MongoStore
    return {
      store: Object.assign(store, {
        recordDecision: MongoStore.prototype.recordDecision,
        getDecision: MongoStore.prototype.getDecision
      }),
      stored
    }
  }

  const held: Verdict = {
    pSpam: 0, action: 'mute', needsVote: false, banDurationSeconds: 3600,
    decidedBy: 'join_screen', ruleId: null,
    signals: [{ name: 'avatar_shared_with_accounts' }],
    reasonCode: 'reported_unreachable',
    reasonEvidence: 'same photo on 35 other account(s)',
    meta: {}
  }

  it('reads back the grounds it was given, not the message text', async () => {
    const { store } = roundTrip()
    await store.recordDecision({
      chatId: -100, userId: 42, messageId: 7,
      textPreview: 'бывает и такое', verdict: held, latencyMs: 1
    })
    const back = await store.getDecision(-100, 7)
    expect(back?.reasonEvidence).toBe('same photo on 35 other account(s)')
  })

  it('a verdict with no grounds reads back as none, not as what they wrote', async () => {
    const { store } = roundTrip()
    await store.recordDecision({
      chatId: -100, userId: 42, messageId: 7,
      textPreview: 'Ищем людей на просеивание зерна',
      verdict: { ...held, reasonEvidence: null }, latencyMs: 1
    })
    const back = await store.getDecision(-100, 7)
    expect(back?.reasonEvidence).toBe(null)
  })

  it('REGRESSION: rows written before this stored nothing, and say so', async () => {
    const { store, stored } = roundTrip()
    stored.push({ chatId: -100, messageId: 7, reasonCode: 'job_scam', textPreview: 'пиши в лс' })
    const back = await store.getDecision(-100, 7)
    expect(back?.reasonEvidence).toBe(null)
  })

  it('the grounds are truncated on a codepoint boundary, like the preview', async () => {
    const { store, stored } = roundTrip()
    await store.recordDecision({
      chatId: -100, userId: 42, messageId: 7, textPreview: '',
      verdict: { ...held, reasonEvidence: `bio: ${'🙂'.repeat(400)}` }, latencyMs: 1
    })
    const written = String(stored[0]?.['reasonEvidence'])
    expect(written.length).toBeLessThanOrEqual(300)
    // A cut through a surrogate pair encodes as U+FFFD and is stored wrong
    // forever — the 2026-08-07 lesson, which is silent on this path.
    expect(written).not.toContain('�')
    expect([...written].every((c) => c.codePointAt(0) !== 0xfffd)).toBe(true)
  })
})
