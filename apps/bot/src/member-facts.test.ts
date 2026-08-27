import { describe, expect, it } from 'vitest'
import { MemberFactsCache, MEMBER_FACTS_TTL_MS } from './member-facts.js'

const DAY_MS = 86_400_000

/** A lookup that counts how often it was actually asked. */
const lookup = (answers: (() => unknown)[]): { call: () => Promise<never>; calls: number } => {
  const state = { n: 0 }
  return {
    call: (() => {
      const answer = answers[Math.min(state.n, answers.length - 1)]
      state.n += 1
      return Promise.resolve().then(() => answer?.())
    }) as () => Promise<never>,
    get calls() { return state.n }
  }
}

const member = (status: string, joinedDate: Date | null = null) => () => ({ status, joinedDate })
const throws = (text: string) => () => { throw new Error(text) }

describe('MemberFactsCache', () => {
  it('reports an admin, and remembers the answer', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('admin')])

    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(true)
    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(true)
    expect(l.calls).toBe(1)
  })

  it('asks again once the answer has gone stale', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('member'), member('creator')])

    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(false)
    t.ms += MEMBER_FACTS_TTL_MS + 1
    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(true)
    expect(l.calls).toBe(2)
  })

  it('does not remember a failure, so the next tap asks again', async () => {
    // The bug this class exists for: a timeout used to be written down as
    // "not an admin" for ten minutes, which took an admin's authority away
    // from the vote and the undo button over one dropped RPC.
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([throws('TIMEOUT'), member('creator')])

    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(false)
    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(true)
    expect(l.calls).toBe(2)
  })

  it('treats "not a participant" as an answer, and remembers it', async () => {
    // Otherwise every tap from a non-member costs an RPC, which is a tap-loop
    // away from being a way to spend our rate limit for us.
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([throws('Telegram API error 400: USER_NOT_PARTICIPANT')])

    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(false)
    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(false)
    expect(l.calls).toBe(1)
  })

  it('reports how long ago Telegram says they joined', async () => {
    const t = { ms: 10 * DAY_MS }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('member', new Date(3 * DAY_MS))])

    expect((await cache.get(-100, 7, l.call)).joinedAgoSeconds).toBe(7 * 86_400)
  })

  it('says nothing about tenure when Telegram did not', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('member', null)])

    expect((await cache.get(-100, 7, l.call)).joinedAgoSeconds).toBeNull()
  })

  it('never reports a join date from the future as negative tenure', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('member', new Date(t.ms + DAY_MS))])

    expect((await cache.get(-100, 7, l.call)).joinedAgoSeconds).toBe(0)
  })

  it('a lookup that answers with nothing is still an answer', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([() => null])

    const facts = await cache.get(-100, 7, l.call)
    expect(facts).toEqual({ isAdmin: false, joinedAgoSeconds: null, isParticipant: false })
    expect(l.calls).toBe(1)
  })

  it('keeps chats and users apart', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('creator'), member('member'), member('member')])

    expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(true)
    expect((await cache.get(-200, 7, l.call)).isAdmin).toBe(false)
    expect((await cache.get(-100, 8, l.call)).isAdmin).toBe(false)
    expect(l.calls).toBe(3)
  })

  it('peeks without asking, and says when it does not know', async () => {
    // The incident short-circuit runs before any enrichment and must not spend
    // the call it exists to avoid — so "unknown" has to be distinguishable
    // from "not an admin", which a bare boolean cannot do.
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('creator')])

    expect(cache.peek(-100, 7)).toBeNull()
    await cache.get(-100, 7, l.call)
    expect(cache.peek(-100, 7)?.isAdmin).toBe(true)

    t.ms += MEMBER_FACTS_TTL_MS + 1
    expect(cache.peek(-100, 7)).toBeNull()
    expect(l.calls).toBe(1)
  })

  it('sweeps stale answers instead of holding every user forever', async () => {
    // A bot lives for weeks across hundreds of chats; an entry per person per
    // chat that is never released is a slow leak.
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    const l = lookup([member('member')])
    for (let i = 0; i < 10_000; i += 1) await cache.get(-100, i, l.call)
    expect(cache.size).toBe(10_000)

    t.ms += MEMBER_FACTS_TTL_MS + 1
    await cache.get(-100, 999_999, l.call)
    expect(cache.size).toBe(1)
  })

  it('a garbage status is not adminship', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    for (const junk of [undefined, null, 42, 'ADMIN', {}]) {
      const l = lookup([() => ({ status: junk })])
      expect((await cache.get(-100, 7, l.call)).isAdmin).toBe(false)
    }
  })

  it('an unusable join date reads as no answer, never as tenure', async () => {
    const t = { ms: 1_000 }
    const cache = new MemberFactsCache(() => t.ms)
    for (const junk of [new Date('nonsense'), 'yesterday', {}, Number.NaN]) {
      const l = lookup([() => ({ status: 'member', joinedDate: junk })])
      expect((await cache.get(-100, 7, l.call)).joinedAgoSeconds).toBeNull()
    }
  })
})


/**
 * Telegram already told us, and we already read it.
 *
 * Production 2026-08-26, three captchas in seventy minutes: every one was
 * issued, failed to whisper with `USER_NOT_PARTICIPANT`, and was lifted 30ms
 * later. A commenter in a linked discussion group is frequently not a MEMBER of
 * it, and the whisper is the only delivery this branch is allowed — so in those
 * chats the captcha is a moderation call and a log line, never a question.
 *
 * The fact was in hand before the ask: `NO_SUCH_MEMBER_REGEX` already sorted
 * "there is no such member here" from a failed RPC, and the answer was used to
 * decide whether to CACHE and then thrown away. Now it is carried.
 */
describe('MemberFacts — is this person in the chat at all', () => {
  it('a refusal that names the person is an answer: not a participant', async () => {
    const cache = new MemberFactsCache()
    const facts = await cache.get(1, 2, () => {
      throw new Error('Telegram API error 400: USER_NOT_PARTICIPANT')
    })
    expect(facts.isParticipant).toBe(false)
  })

  it('any other failure says nothing about membership', async () => {
    const cache = new MemberFactsCache()
    const facts = await cache.get(1, 2, () => {
      throw new Error('Telegram API error 500: TIMEOUT')
    })
    expect(facts.isParticipant).toBeNull()
    expect(facts.isAdmin).toBe(false)
  })

  it('an answer about a member says they are one', async () => {
    const cache = new MemberFactsCache()
    const facts = await cache.get(1, 2, async () => ({ status: 'member', joinedDate: new Date() }))
    expect(facts.isParticipant).toBe(true)
  })

  /**
   * The real contract of `getChatMember`, which is not what the mock above
   * describes: mtcute 0.31 CATCHES `USER_NOT_PARTICIPANT` itself and returns
   * `null` (highlevel/methods/chats/get-chat-member.js). So the ordinary
   * non-member — a commenter under a channel post who never joined the linked
   * group — arrives here as an empty answer, never as a throw.
   *
   * Read as "unknown", it made the `senderIsParticipant` guard in
   * `mayAskCaptcha` unreachable in production: every such commenter was still
   * asked a captcha that can only be delivered to a member.
   */
  it('the null mtcute returns for a non-member is a denial, not a shrug', async () => {
    const cache = new MemberFactsCache()
    const facts = await cache.get(1, 2, async () => null)
    expect(facts.isParticipant).toBe(false)
  })

  it('and that denial is remembered, like any other answer', async () => {
    const cache = new MemberFactsCache()
    const l = lookup([async () => null])
    await cache.get(1, 2, l.call)
    await cache.get(1, 2, l.call)
    expect(l.calls).toBe(1)
  })
})
