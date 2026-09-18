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

/**
 * `recordIdentity` keeps a value only when it differs from the newest one, and
 * that rule lives in a `$ne` on element 0 — whose meaning for a document with
 * no history at all is the server's call, not the driver's.
 */
describe.skipIf(!uri)('recordIdentity against a live server', () => {
  const store = new MongoStore()
  const id = 990_000_001

  beforeAll(async () => { await store.connect(uri as string) })
  afterAll(async () => {
    await store.users.deleteMany({ telegram_id: id })
    await store.close()
  })
  beforeEach(async () => {
    await store.users.deleteMany({ telegram_id: id })
    await store.touchUser(id)
  })

  const history = async (): Promise<{ names: unknown[]; usernames: unknown[] }> => {
    const doc = await store.users.findOne({ telegram_id: id }) as
      { nameHistory?: { value: string }[]; usernameHistory?: { value: string }[] } | null
    return {
      names: (doc?.nameHistory ?? []).map((e) => e.value),
      usernames: (doc?.usernameHistory ?? []).map((e) => e.value)
    }
  }

  it('seeds an empty document, and the same name again adds nothing', async () => {
    await store.recordIdentity(id, 'Anna K', 'anna')
    await store.recordIdentity(id, 'Anna K', 'anna')
    expect(await history()).toEqual({ names: ['Anna K'], usernames: ['anna'] })
  })

  it('puts a changed name first and leaves the unchanged username alone', async () => {
    await store.recordIdentity(id, 'Anna K', 'anna')
    await store.recordIdentity(id, 'Anna Kovalenko', 'anna')
    expect(await history()).toEqual({ names: ['Anna Kovalenko', 'Anna K'], usernames: ['anna'] })
  })

  it('keeps ten, newest first', async () => {
    for (let i = 0; i < 12; i += 1) await store.recordIdentity(id, `name ${i}`, '')
    const { names } = await history()
    expect(names).toHaveLength(10)
    expect(names[0]).toBe('name 11')
  })

  it('reads back the newest name for the leaderboard', async () => {
    await store.recordIdentity(id, 'Anna K', 'anna')
    await store.recordIdentity(id, 'Anna Kovalenko', 'anna')
    const names = await store.getLastNames([id, 990_000_002])
    expect(names.get(id)).toBe('Anna Kovalenko')
    expect(names.has(990_000_002)).toBe(false)
  })
})
