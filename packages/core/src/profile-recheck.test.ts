import { describe, expect, it } from 'vitest'
import {
  createProfileRecheckQueue,
  profileRecheckOutcome,
  wantsProfileRecheck
} from './profile-recheck.js'

describe('wantsProfileRecheck', () => {
  const bare = { isUser: true, newish: true, avatarCount: 0, action: 'none' as const }

  it('a newcomer who wrote with no picture at all, and was left alone', () => {
    expect(wantsProfileRecheck(bare)).toBe(true)
    expect(wantsProfileRecheck({ ...bare, action: 'observe' })).toBe(true)
  })

  it('not a lookup that failed — no answer is not "no picture"', () => {
    expect(wantsProfileRecheck({ ...bare, avatarCount: null })).toBe(false)
  })

  it('not somebody with a picture, a member with history, a channel, or anyone already acted on', () => {
    expect(wantsProfileRecheck({ ...bare, avatarCount: 1 })).toBe(false)
    expect(wantsProfileRecheck({ ...bare, newish: false })).toBe(false)
    expect(wantsProfileRecheck({ ...bare, isUser: false })).toBe(false)
    expect(wantsProfileRecheck({ ...bare, action: 'mute' })).toBe(false)
    expect(wantsProfileRecheck({ ...bare, action: 'captcha' })).toBe(false)
  })
})

describe('profileRecheckOutcome', () => {
  it('names the three things a second look can find', () => {
    expect(profileRecheckOutcome(false, [])).toBe('still_bare')
    expect(profileRecheckOutcome(true, [{ name: 'avatar_recently_set', evidence: '' }])).toBe('dressed')
    expect(profileRecheckOutcome(true, [
      { name: 'avatar_recently_set', evidence: '' },
      { name: 'avatar_shared_with_accounts', evidence: '' }
    ])).toBe('dressed_farm')
  })
})

describe('createProfileRecheckQueue', () => {
  const harness = (maxPending = 10) => {
    const timers: Array<{ ms: number; fn: () => void }> = []
    const queue = createProfileRecheckQueue({
      delaysMs: [1000, 5000],
      maxPending,
      setTimer: (fn, ms) => { timers.push({ ms, fn }) }
    })
    const fire = async (): Promise<void> => {
      timers.shift()!.fn()
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { queue, timers, fire }
  }

  it('looks again at each delay until the look says it is done', async () => {
    const { queue, timers, fire } = harness()
    const attempts: Array<[number, boolean]> = []
    queue.schedule('1:7', async (attempt, last) => { attempts.push([attempt, last]); return 'again' })
    expect(timers.map((t) => t.ms)).toEqual([1000])
    await fire()
    // The second delay is measured from the message, not from the first look.
    expect(timers.map((t) => t.ms)).toEqual([4000])
    await fire()
    expect(attempts).toEqual([[0, false], [1, true]])
    expect(timers).toEqual([])
    expect(queue.size()).toBe(0)
  })

  it('stops as soon as there is something to report', async () => {
    const { queue, timers, fire } = harness()
    queue.schedule('1:7', async () => 'done')
    await fire()
    expect(timers).toEqual([])
    expect(queue.size()).toBe(0)
  })

  it('one account is one question, however many messages it sends', () => {
    const { queue, timers } = harness()
    expect(queue.schedule('1:7', async () => 'done')).toBe(true)
    expect(queue.schedule('1:7', async () => 'done')).toBe(false)
    expect(timers).toHaveLength(1)
  })

  it('a raid does not become a queue of lookups', () => {
    const { queue } = harness(2)
    expect(queue.schedule('a', async () => 'done')).toBe(true)
    expect(queue.schedule('b', async () => 'done')).toBe(true)
    expect(queue.schedule('c', async () => 'done')).toBe(false)
    expect(queue.size()).toBe(2)
  })

  it('a look that throws frees its place', async () => {
    const { queue, fire } = harness()
    queue.schedule('1:7', async () => { throw new Error('flood') })
    await fire()
    expect(queue.size()).toBe(0)
  })
})
