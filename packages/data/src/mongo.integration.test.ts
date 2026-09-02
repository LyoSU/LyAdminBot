/**
 * The ballot write, run against a real server.
 *
 * `castBallot` is an aggregation-pipeline update, and the unit suite can only
 * check the shape of the pipeline it sends: what the server makes of that
 * shape is exactly what went wrong on 2026-09-01, when a missing previous
 * ballot compared as not-null and every first vote was recorded as a change of
 * mind. Nothing short of the server can catch that class of defect, so this
 * file runs only when one is offered:
 *
 *   docker run --rm -d -p 27099:27017 mongo:7
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27099/lyadmin-test npm test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoStore } from './mongo.js'

const uri = process.env['MONGO_TEST_URI']

describe.skipIf(!uri)('castBallot against a live server', () => {
  const store = new MongoStore()
  const chatId = -100
  let messageId = 0

  beforeAll(async () => { await store.connect(uri as string) })
  afterAll(async () => {
    await store.votes.deleteMany({ chatId })
    await store.close()
  })
  beforeEach(async () => {
    messageId += 1
    await store.openVote({
      chatId, messageId, targetUserId: 42, targetLabel: 'target', textPreview: 'text', openedBy: 1
    })
  })

  const ballots = async (): Promise<Record<string, unknown>[]> =>
    ((await store.getVote(chatId, messageId))?.['ballots'] ?? []) as Record<string, unknown>[]

  const cast = (userId: number, choice: 'spam' | 'ham'): Promise<boolean> =>
    store.castBallot({ chatId, messageId, userId, isAdmin: false, choice, label: `voter ${userId}` })

  it('a first ballot is one tap and not a change of mind', async () => {
    expect(await cast(7, 'spam')).toBe(true)
    expect(await ballots()).toMatchObject([{ userId: 7, choice: 'spam', taps: 1, changedMind: false }])
  })

  it('a first ballot next to other voters\' ballots is still not a change of mind', async () => {
    await cast(1, 'spam')
    await cast(7, 'spam')
    const rows = await ballots()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r['userId'] === 7)).toMatchObject({ taps: 1, changedMind: false })
  })

  it('tapping the same side again counts the tap and keeps the mind unchanged', async () => {
    await cast(7, 'spam')
    await cast(7, 'spam')
    expect(await ballots()).toMatchObject([{ userId: 7, choice: 'spam', taps: 2, changedMind: false }])
  })

  it('switching sides is a change of mind, and stays one after switching back', async () => {
    await cast(7, 'spam')
    await cast(7, 'ham')
    expect(await ballots()).toMatchObject([{ userId: 7, choice: 'ham', taps: 2, changedMind: true }])
    await cast(7, 'spam')
    expect(await ballots()).toMatchObject([{ userId: 7, choice: 'spam', taps: 3, changedMind: true }])
  })
})

describe.skipIf(!uri)('forgetUnearnedChangeOfMind against a live server', () => {
  const store = new MongoStore()
  const chatId = -200

  beforeAll(async () => { await store.connect(uri as string) })
  afterAll(async () => {
    await store.votes.deleteMany({ chatId })
    await store.close()
  })

  /** A question as the buggy write left it: every ballot flagged, whatever the taps. */
  const damaged = (messageId: number, createdAt: Date, ballots: Record<string, unknown>[]): Promise<unknown> =>
    store.votes.insertOne({ chatId, messageId, status: 'resolved', createdAt, ballots })

  const ballotsOf = async (messageId: number): Promise<Record<string, unknown>[]> =>
    ((await store.getVote(chatId, messageId))?.['ballots'] ?? []) as Record<string, unknown>[]

  it('a single tap becomes false, a repeated tap loses the flag, the rest of the ballot survives', async () => {
    const cutoff = new Date('2026-09-02T12:00:00Z')
    await damaged(1, new Date('2026-09-01T20:00:00Z'), [
      { userId: 1, choice: 'spam', isAdmin: false, label: 'one', taps: 1, changedMind: true },
      { userId: 2, choice: 'spam', isAdmin: true, label: 'two', taps: 2, changedMind: true }
    ])
    expect(await store.forgetUnearnedChangeOfMind(cutoff)).toEqual({ questions: 1 })
    const rows = await ballotsOf(1)
    expect(rows[0]).toMatchObject({ userId: 1, choice: 'spam', label: 'one', taps: 1, changedMind: false })
    expect(rows[1]).toMatchObject({ userId: 2, choice: 'spam', isAdmin: true, label: 'two', taps: 2 })
    expect(rows[1]).not.toHaveProperty('changedMind')
  })

  it('leaves questions written after the cutoff and questions from before deduplication alone', async () => {
    const cutoff = new Date('2026-09-02T12:00:00Z')
    await damaged(2, new Date('2026-09-02T13:00:00Z'), [
      { userId: 1, choice: 'ham', isAdmin: false, taps: 2, changedMind: true }
    ])
    await damaged(3, new Date('2026-08-20T13:00:00Z'), [
      { userId: 1, choice: 'spam', isAdmin: false },
      { userId: 1, choice: 'ham', isAdmin: false }
    ])
    expect(await store.forgetUnearnedChangeOfMind(cutoff)).toEqual({ questions: 0 })
    expect(await ballotsOf(2)).toMatchObject([{ taps: 2, changedMind: true }])
    expect(await ballotsOf(3)).toHaveLength(2)
  })

  it('is safe to run twice', async () => {
    const cutoff = new Date('2026-09-02T12:00:00Z')
    await damaged(4, new Date('2026-09-01T20:00:00Z'), [
      { userId: 1, choice: 'spam', isAdmin: false, taps: 1, changedMind: true }
    ])
    await store.forgetUnearnedChangeOfMind(cutoff)
    const once = await ballotsOf(4)
    await store.forgetUnearnedChangeOfMind(cutoff)
    expect(await ballotsOf(4)).toEqual(once)
  })
})
