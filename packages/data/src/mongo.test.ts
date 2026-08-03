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
import { MongoStore } from './mongo.js'

interface Captured { doc: Record<string, unknown> | null }

/** A store whose feedback insert is captured instead of performed. */
const captureStore = (): { store: MongoStore; captured: Captured } => {
  const captured: Captured = { doc: null }
  const store = {
    feedback: {
      insertOne: async (doc: Record<string, unknown>) => { captured.doc = doc; return {} }
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

  it('only an admin may retire a signature — a chat is not authority over the network', async () => {
    // A signature fires in every chat for ninety days. If a ballot could retire
    // one, a crew posting spam in a group they control could vote their own text
    // clean and take the rule down everywhere.
    const retired: unknown[] = []
    const make = () => {
      const store = {
        feedback: { insertOne: async () => ({}) },
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
