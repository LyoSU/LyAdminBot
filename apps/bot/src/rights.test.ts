import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  RightsMemory, RIGHTS_PROBE_MS, RIGHTS_PROBE_MAX_MS,
  RIGHTS_EPISODE_MS, RIGHTS_NOTICE_REMIND_MS, RIGHTS_NOTICE_MAX, RIGHTS_NOTICE_KEEP_MS,
  failureKind, failureLabels, rightsLogDecision, rightsNoticeDecision, RIGHTS_LOG_REMIND_MS,
  grantedRights, grantedShape,
  type BotMembership, type GrantedRights, type RightsNoticeMark, type RightsRecord, type RightsShape
} from './rights.js'

const at = (t: { ms: number }): RightsMemory => new RightsMemory(() => t.ms)

/** A memory whose writes are captured, standing in for the store. */
const persisting = (t: { ms: number }): {
  rights: RightsMemory
  saved: Map<number, RightsRecord | null>
  writes: number
} => {
  const saved = new Map<number, RightsRecord | null>()
  const counter = { n: 0 }
  const rights = new RightsMemory(() => t.ms, (chatId, record) => {
    counter.n += 1
    // Copy: the class keeps mutating its own record, and a store would not see
    // those mutations. A test that shares the object would.
    saved.set(chatId, record === null ? null : { ...record })
  })
  return { rights, saved, get writes() { return counter.n } }
}

const bothRefused = ['delete: FORBIDDEN', 'mute: CHAT_ADMIN_REQUIRED']
const ALL_RIGHTS: GrantedRights = { canDelete: true, canRestrict: true }
const NO_RIGHTS: GrantedRights = { canDelete: false, canRestrict: false }

describe('RightsMemory', () => {
  it('knows nothing until something is refused', () => {
    const t = { ms: 1_000 }
    expect(at(t).cannotEnforce(-100)).toBe(false)
  })

  it('a chat that refuses only the ban is still worth moderating', () => {
    // Production 2026-07-30: a chat refused the ban while the delete went
    // through. Standing down there would throw away the part that works — and
    // deleting the message is most of the value.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-100, ['ban: Telegram API error 400: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-100)).toBe(false)
    expect(rights.blockedChats()).toEqual([
      { chatId: -100, deleteBlocked: false, senderBlocked: true }
    ])
  })

  it('a chat that refuses both is not worth paying an LLM for', () => {
    // Neither the message nor the sender can be touched here.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-200, [
      'delete: Telegram API error 403: MESSAGE_DELETE_FORBIDDEN',
      'mute: Telegram API error 400: CHAT_ADMIN_REQUIRED'
    ])
    expect(rights.cannotEnforce(-200)).toBe(true)
  })

  it('capabilities accumulate across separate refusals', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-300, ['delete: MESSAGE_DELETE_FORBIDDEN'])
    expect(rights.cannotEnforce(-300)).toBe(false)
    rights.noteOutcome(-300, ['kick: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-300)).toBe(true)
  })

  it('errors that are not about rights never block anything', () => {
    // A flood wait, a network blip or a deleted message must not be mistaken
    // for a permission problem — that would stand the bot down over a hiccup.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-600, [
      'delete: Telegram API error 400: MESSAGE_ID_INVALID',
      'ban: FLOOD_WAIT_30',
      'mute: fetch failed'
    ])
    expect(rights.cannotEnforce(-600)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('an execution that raised nothing is the proof that rights came back', () => {
    // The only positive evidence this class gets for free. A backoff that can
    // grow but never shrink would eventually stand the bot down in a chat that
    // had long since promoted it.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-700, bothRefused)
    expect(rights.cannotEnforce(-700)).toBe(true)
    rights.noteOutcome(-700, [])
    expect(rights.cannotEnforce(-700)).toBe(false)
    expect(rights.strikes(-700)).toBe(0)
    expect(rights.blockedChats()).toEqual([])
  })

  it('nothing to forget is not an error', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-710, [])
    expect(rights.blockedChats()).toEqual([])
    expect(rights.strikes(-710)).toBe(0)
  })

  it('blocks are per chat, never global', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-800, bothRefused)
    expect(rights.cannotEnforce(-800)).toBe(true)
    expect(rights.cannotEnforce(-900)).toBe(false)
  })
})

/**
 * The fact and the timer are separate things (2026-08-07).
 *
 * They used to be one: the block WAS an expiry, so time alone made the bot
 * forget that it is not an admin somewhere — and rediscover it with a full
 * pipeline. What time may now decide is only how often we re-ask.
 */
describe('RightsMemory — the refusal does not lapse, only the probe does', () => {
  it('time alone never clears a refusal', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-400, bothRefused)
    t.ms += RIGHTS_PROBE_MAX_MS * 100
    expect(rights.cannotEnforce(-400), 'nobody granted us anything by waiting').toBe(true)
  })

  it('the probe becomes due, and a granted probe is what clears it', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-410, bothRefused)
    expect(rights.mayProbe(-410)).toBe(false)
    t.ms += RIGHTS_PROBE_MS + 1
    expect(rights.mayProbe(-410)).toBe(true)

    expect(rights.noteProbe(-410, ALL_RIGHTS)).toEqual(['delete', 'sender'])
    expect(rights.cannotEnforce(-410)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('a refused probe pushes the next one out and leaves the block standing', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-420, bothRefused)
    t.ms += RIGHTS_PROBE_MS + 1
    expect(rights.noteProbe(-420, NO_RIGHTS)).toEqual([])
    expect(rights.cannotEnforce(-420)).toBe(true)
    expect(rights.mayProbe(-420)).toBe(false)
  })

  it('a probe may only lift a block, never create one', () => {
    // The asymmetry that makes reading our own membership safe at all. Wrong in
    // the pessimistic direction it changes nothing; wrong in the optimistic
    // direction it costs one evaluation, and the refusal re-blocks the chat.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteProbe(-430, NO_RIGHTS)
    rights.noteProbe(-430, ALL_RIGHTS)
    expect(rights.cannotEnforce(-430)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
    expect(rights.strikes(-430)).toBe(0)
  })

  it('a probe lifts only the block whose right is present', () => {
    // Production 2026-10-15: an admin bot without the delete and ban rights
    // passed a status-only probe, so the block was forgotten and every message
    // paid the full pipeline until the next refusal re-created it.
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noteOutcome(-440, bothRefused, 111)
    rights.noticeDecision(-440)
    t.ms += RIGHTS_PROBE_MS + 1
    expect(rights.noteProbe(-440, NO_RIGHTS), 'an admin with neither right').toEqual([])
    expect(rights.cannotEnforce(-440)).toBe(true)

    t.ms += RIGHTS_PROBE_MAX_MS
    expect(rights.noteProbe(-440, { canDelete: true, canRestrict: false })).toEqual(['delete'])
    expect(rights.cannotEnforce(-440), 'removing messages is possible again').toBe(false)
    expect(rights.knownGap(-440)).toEqual({ deleteBlocked: false, senderBlocked: true })
    // The rest of the record stays: strikes, the accounts, the notice history.
    expect(saved.get(-440)).toMatchObject({ senderRefused: true, strikes: 1, blockedAccounts: [111], noticeCount: 1 })
    expect(rights.mayProbe(-440), 'the next probe is still rate-limited').toBe(false)
  })

  it('the probe interval doubles while the refusal persists', () => {
    // Production 2026-08-01: an advert reposted on a roughly quarter-hourly
    // cadence, just slower than a flat quarter-hour block, so every repost
    // landed after the block lapsed and paid the full pipeline price again.
    const t = { ms: 1_000 }
    const rights = at(t)

    rights.noteOutcome(-810, bothRefused)
    t.ms += RIGHTS_PROBE_MS + 1
    expect(rights.mayProbe(-810)).toBe(true)

    rights.noteOutcome(-810, bothRefused)
    t.ms += RIGHTS_PROBE_MS + 1
    expect(rights.mayProbe(-810), 'a second refusal buys twice as long').toBe(false)
    t.ms += RIGHTS_PROBE_MS
    expect(rights.mayProbe(-810)).toBe(true)
  })

  it('the doubling has a ceiling, so granted rights are never waited on for long', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 20; i += 1) rights.noteOutcome(-820, bothRefused)
    t.ms += RIGHTS_PROBE_MAX_MS + 1
    expect(rights.mayProbe(-820)).toBe(true)
  })

  it('a refusal long after the last one starts a new episode', () => {
    // Otherwise a chat that briefly demoted the bot a year ago jumps straight
    // to the ceiling on its next hiccup.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-830, bothRefused)
    t.ms += RIGHTS_EPISODE_MS + 1
    rights.noteOutcome(-830, bothRefused)
    expect(rights.strikes(-830)).toBe(1)
  })

  it('REGRESSION: a quiet stretch inside a standing refusal is the same episode', () => {
    // This test used to assert the opposite, with `RIGHTS_PROBE_MAX_MS * 3`,
    // because the staleness test read `now - probeAt` and `probeAt` is pinned
    // to that same ceiling by `backoffMs`. Any two refusals more than about
    // half an hour apart counted as separate episodes.
    //
    // Production 2026-08-26, the chat this cost the most: 291 refusals over
    // eight days with a median gap of 6.9 minutes — but 46 gaps over sixteen
    // minutes, so the counter reset roughly every six refusals and read 1 after
    // all 291. A chat is not less blocked because nobody posted for an hour.
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 6; i += 1) {
      rights.noteOutcome(-831, bothRefused)
      t.ms += RIGHTS_PROBE_MAX_MS * 2 + 1
    }
    expect(rights.strikes(-831)).toBe(6)
  })

  it('an episode ends when the chat comes good, not when it goes quiet', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 4; i += 1) rights.noteOutcome(-832, bothRefused)
    rights.noteOutcome(-832, [])
    rights.noteOutcome(-832, bothRefused)
    expect(rights.strikes(-832)).toBe(1)
  })
})

/**
 * The number the public notice carries. "267 refusals" reads as a broken bot;
 * "66 accounts still here" reads as the problem it is.
 */
describe('RightsMemory — the accounts left in place', () => {
  it('counts each account once, however many of its messages were refused', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 5; i += 1) rights.noteOutcome(-840, bothRefused, 111)
    rights.noteOutcome(-840, bothRefused, 222)
    expect(rights.gap(-840).accounts).toBe(2)
  })

  it('a refusal with no account named still counts as a refusal', () => {
    // The manual command paths warn without a sender to blame.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-841, bothRefused)
    expect(rights.strikes(-841)).toBe(1)
    expect(rights.gap(-841).accounts).toBe(0)
  })

  it('the roll is bounded, and understates rather than growing forever', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 700; i += 1) rights.noteOutcome(-842, bothRefused, i)
    expect(rights.gap(-842).accounts).toBe(500)
  })

  it('a new episode starts the roll over, so the number is about now', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-843, bothRefused, 111)
    rights.noteOutcome(-843, bothRefused, 222)
    t.ms += RIGHTS_EPISODE_MS + 1
    rights.noteOutcome(-843, bothRefused, 333)
    expect(rights.gap(-843).accounts).toBe(1)
  })

  it('rights coming back clears the roll with everything else', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-844, bothRefused, 111)
    rights.noteOutcome(-844, [])
    expect(rights.gap(-844).accounts).toBe(0)
  })
})

/**
 * What the notice asks for. Asking for both rights in a chat that grants one is
 * how the group with 267 refused bans was told the bot could not delete spam,
 * which it had been doing all along.
 */
describe('RightsMemory — what to ask for', () => {
  it('names only the capability that was refused', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-850, ['ban: CHAT_ADMIN_REQUIRED'], 111)
    expect(rights.gap(-850)).toEqual({ deleteBlocked: false, senderBlocked: true, accounts: 1 })
  })

  it('names both when both were refused', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-851, bothRefused, 111)
    expect(rights.gap(-851)).toMatchObject({ deleteBlocked: true, senderBlocked: true })
  })

  it('a chat we know nothing about is asked for both', () => {
    // The manual paths reach here with no record at all. "We do not know" must
    // read as the full ask, never as "nothing is missing".
    const t = { ms: 1_000 }
    expect(at(t).gap(-852)).toEqual({ deleteBlocked: true, senderBlocked: true, accounts: 0 })
  })

  it('a record that only holds notice history is not a statement about rights', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noticeDecision(-853)
    expect(rights.gap(-853)).toEqual({ deleteBlocked: true, senderBlocked: true, accounts: 0 })
    expect(rights.knownGap(-853), 'the status line claims only what a refusal proved').toBeNull()
  })

  it('knownGap names exactly what was refused', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    expect(rights.knownGap(-854)).toBeNull()
    rights.noteOutcome(-854, ['delete: FORBIDDEN'])
    expect(rights.knownGap(-854)).toEqual({ deleteBlocked: true, senderBlocked: false })
    rights.noteOutcome(-854, [])
    expect(rights.knownGap(-854)).toBeNull()
  })
})

const HOUR = 60 * 60 * 1000
const never: RightsNoticeMark = { shape: 'none', count: 0, at: 0 }
const SHAPES: readonly RightsShape[] = ['none', 'delete', 'sender', 'all']

/**
 * The in-chat notice cadence, decided 2026-10-15: once when the state becomes
 * blocked, one reminder a day later if unchanged, then silence until it moves.
 */
describe('rightsNoticeDecision', () => {
  const day = RIGHTS_NOTICE_REMIND_MS
  it.each<[string, RightsNoticeMark, RightsShape, number, boolean, string]>([
    ['never noticed, now blocked', never, 'all', 0, true, 'first'],
    ['never noticed, partly blocked', never, 'sender', 0, true, 'first'],
    ['nothing missing', never, 'none', 0, false, 'not_blocked'],
    ['nothing missing after notices', { shape: 'all', count: 2, at: 0 }, 'none', day * 9, false, 'not_blocked'],
    ['one notice, an hour on', { shape: 'all', count: 1, at: 0 }, 'all', HOUR, false, 'not_due'],
    ['one notice, a day on', { shape: 'all', count: 1, at: 0 }, 'all', day, true, 'reminder'],
    ['reminded, a week on', { shape: 'all', count: 2, at: 0 }, 'all', day * 7, false, 'reminded'],
    ['partial became full', { shape: 'sender', count: 2, at: 0 }, 'all', HOUR, true, 'changed'],
    ['full became partial', { shape: 'all', count: 1, at: 0 }, 'delete', 1, true, 'changed'],
    ['clock went backwards', { shape: 'all', count: 1, at: day }, 'all', 0, false, 'not_due']
  ])('%s', (_name, prev, shape, now, post, reason) => {
    const d = rightsNoticeDecision(prev, shape, now)
    expect(d.post).toBe(post)
    expect(d.reason).toBe(reason)
    if (!post) expect(d.next).toEqual(prev)
  })

  it('posts at most twice per uninterrupted blocked state, whatever the timing', () => {
    fc.assert(fc.property(
      fc.constantFrom<RightsShape>('delete', 'sender', 'all'),
      fc.array(fc.integer({ min: 0, max: 30 * 24 * HOUR }), { maxLength: 300 }),
      (shape, gaps) => {
        let mark = never
        let now = 0
        let posts = 0
        for (const gap of gaps) {
          now += gap
          const d = rightsNoticeDecision(mark, shape, now)
          if (d.post) posts += 1
          mark = d.next
        }
        return posts <= RIGHTS_NOTICE_MAX
      }
    ))
  })

  it('hourly checks for any number of hours: one notice, one reminder a day later', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 24 * 60 }), (hours) => {
      let mark = never
      const postedAt: number[] = []
      for (let h = 0; h < hours; h += 1) {
        const d = rightsNoticeDecision(mark, 'all', h * HOUR)
        if (d.post) postedAt.push(h)
        mark = d.next
      }
      expect(postedAt).toEqual(hours > 24 ? [0, 24] : [0])
    }))
  })

  it('each change of state opens its own cycle of at most two', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.constantFrom(...SHAPES), fc.integer({ min: 0, max: 3 * 24 * HOUR })), { maxLength: 200 }),
      (steps) => {
        let mark = never
        let now = 0
        let run = 0
        let last: RightsShape | null = null
        for (const [shape, gap] of steps) {
          now += gap
          if (shape !== last) run = 0
          last = shape
          const d = rightsNoticeDecision(mark, shape, now)
          if (d.post) run += 1
          if (shape === 'none' && d.post) return false
          if (run > RIGHTS_NOTICE_MAX) return false
          mark = d.next
        }
        return true
      }
    ))
  })
})

/**
 * The cadence as the chat sees it, through the memory that persists it.
 */
describe('RightsMemory — asking the admins', () => {
  it('a fully blocked chat checked every hour for a week is asked twice', () => {
    // Production 2026-10-15: such a chat was asked every hour, indefinitely.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-500, bothRefused)
    const posted: number[] = []
    for (let h = 0; h < 24 * 7; h += 1) {
      if (rights.noticeDecision(-500).post) posted.push(h)
      t.ms += HOUR
    }
    expect(posted).toEqual([0, 24])
  })

  it('a different set of missing rights is a new state', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-510, ['ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.noticeDecision(-510)).toMatchObject({ post: true, reason: 'first', shape: 'sender' })
    rights.noteOutcome(-510, ['delete: FORBIDDEN'])
    expect(rights.noticeDecision(-510)).toMatchObject({ post: true, reason: 'changed', shape: 'all' })
    expect(rights.noticeDecision(-510)).toMatchObject({ post: false, reason: 'not_due' })
  })

  it('a chat with nothing recorded may still be asked, for both rights', () => {
    // The manual paths warn from their own failed attempt, without an
    // execution having gone through `noteOutcome` first.
    const t = { ms: 1_000 }
    const rights = at(t)
    expect(rights.noticeDecision(-520)).toMatchObject({ post: true, shape: 'all' })
    expect(rights.noticeDecision(-520).post).toBe(false)
    // Being asked is not being blocked.
    expect(rights.cannotEnforce(-520)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('rights coming back restarts the cycle, so the next episode is heard', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-530, bothRefused)
    expect(rights.noticeDecision(-530).post).toBe(true)
    t.ms += RIGHTS_NOTICE_REMIND_MS
    expect(rights.noticeDecision(-530).post).toBe(true)
    expect(rights.noticeDecision(-530).post).toBe(false)
    rights.noteOutcome(-530, [])
    rights.noteOutcome(-530, bothRefused)
    expect(rights.noticeDecision(-530)).toMatchObject({ post: true, reason: 'first' })
  })

  it('a held notice writes nothing', () => {
    // The blocked gate asks on every message; a write per message is the waste
    // this class exists to avoid.
    const t = { ms: 1_000 }
    const store = persisting(t)
    store.rights.noteOutcome(-540, bothRefused)
    store.rights.noticeDecision(-540)
    const before = store.writes
    for (let i = 0; i < 50; i += 1) store.rights.noticeDecision(-540)
    expect(store.writes).toBe(before)
  })

  it('a posted notice keeps a record of nothing but history for a month', () => {
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noticeDecision(-550)
    expect(saved.get(-550)).toMatchObject({
      deleteRefused: false, senderRefused: false,
      noticeShape: 'all', noticeCount: 1, noticeAt: 1_000, warnedUntil: 1_000 + RIGHTS_NOTICE_KEEP_MS
    })
  })
})

/**
 * The bot's own membership read into the two capabilities refusals are kept
 * against — the mapping the probe trusts to lift a block.
 */
describe('grantedRights', () => {
  const admin = (permissions: BotMembership['permissions']): BotMembership => ({ status: 'admin', permissions })
  it.each<[string, BotMembership | null | undefined, GrantedRights, RightsShape]>([
    ['no answer', null, NO_RIGHTS, 'all'],
    ['undefined answer', undefined, NO_RIGHTS, 'all'],
    ['plain member', { status: 'member', permissions: null }, NO_RIGHTS, 'all'],
    ['restricted', { status: 'restricted', permissions: null }, NO_RIGHTS, 'all'],
    ['left', { status: 'left', permissions: null }, NO_RIGHTS, 'all'],
    ['creator', { status: 'creator', permissions: {} }, ALL_RIGHTS, 'none'],
    ['admin of a basic group (no bitmask)', admin(null), ALL_RIGHTS, 'none'],
    ['admin with neither right', admin({}), NO_RIGHTS, 'all'],
    ['admin with delete only', admin({ deleteMessages: true }), { canDelete: true, canRestrict: false }, 'sender'],
    ['admin with ban only', admin({ banUsers: true }), { canDelete: false, canRestrict: true }, 'delete'],
    ['admin with both', admin({ deleteMessages: true, banUsers: true }), ALL_RIGHTS, 'none'],
    ['admin with both explicitly off', admin({ deleteMessages: false, banUsers: false }), NO_RIGHTS, 'all']
  ])('%s', (_name, member, granted, shape) => {
    expect(grantedRights(member)).toEqual(granted)
    expect(grantedShape(grantedRights(member))).toBe(shape)
  })

  it('never grants a right to anyone but an admin or the creator', () => {
    fc.assert(fc.property(
      fc.constantFrom('member', 'restricted', 'banned', 'left', 'weird'),
      fc.option(fc.record({ deleteMessages: fc.boolean(), banUsers: fc.boolean() }), { nil: null }),
      (status, permissions) => {
        const g = grantedRights({ status, permissions })
        return !g.canDelete && !g.canRestrict
      }
    ))
  })

  it('a probe never lifts a block whose right the bitmask does not show', () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
      (deleteRefused, senderRefused, deleteMessages, banUsers) => {
        const t = { ms: 1_000 }
        const rights = at(t)
        const errors = [...(deleteRefused ? ['delete: FORBIDDEN'] : []), ...(senderRefused ? ['ban: CHAT_ADMIN_REQUIRED'] : [])]
        if (errors.length === 0) return true
        rights.noteOutcome(-450, errors)
        rights.noteProbe(-450, grantedRights({ status: 'admin', permissions: { deleteMessages, banUsers } }))
        const gap = rights.knownGap(-450) ?? { deleteBlocked: false, senderBlocked: false }
        return gap.deleteBlocked === (deleteRefused && !deleteMessages) &&
          gap.senderBlocked === (senderRefused && !banUsers)
      }
    ))
  })
})

/**
 * Surviving a restart, which is the whole point: the bot restarted three times
 * on 2026-08-07 and each restart cost every refusing chat a fresh evaluation
 * plus a fresh public notice.
 */
describe('RightsMemory — persistence', () => {
  it('every change is handed to the store', () => {
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noteOutcome(-600, bothRefused)
    expect(saved.get(-600)).toMatchObject({
      chatId: -600, deleteRefused: true, senderRefused: true, strikes: 1
    })
  })

  it('a chat that came good is removed, not left behind as stale truth', () => {
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noteOutcome(-610, bothRefused)
    rights.noteOutcome(-610, [])
    expect(saved.get(-610)).toBeNull()
  })

  it('a success in a chat we knew nothing about writes nothing', () => {
    // `noteOutcome([])` runs after every applied verdict in every chat. A delete
    // per message against storage would be the waste this class exists to avoid.
    const t = { ms: 1_000 }
    const store = persisting(t)
    store.rights.noteOutcome(-620, [])
    expect(store.writes).toBe(0)
  })

  it('restored state is believed as-is, including the pending probe', () => {
    // Deliberately not trimmed on the way in: a restart is evidence about our
    // own code, not about anybody's rights, and the probe re-checks within
    // fifteen minutes at worst anyway.
    const t = { ms: 1_000_000 }
    const rights = at(t)
    rights.restore([{
      chatId: -700, deleteRefused: true, senderRefused: true, strikes: 4,
      probeAt: t.ms + 5_000, warnedUntil: t.ms + 60_000
    }])
    expect(rights.cannotEnforce(-700)).toBe(true)
    expect(rights.mayProbe(-700)).toBe(false)
    expect(rights.noticeDecision(-700).post, 'already asked before the restart').toBe(false)
    expect(rights.strikes(-700)).toBe(4)
  })

  it('a record written before the newest fields existed is safe to work with', () => {
    // `pipeline_rights` held 52 such documents the day `lastRefusalAt` and
    // `blockedAccounts` were added. A restore that passed them through as-is
    // would hand `undefined` to `push` on the very next refusal.
    const t = { ms: 1_000_000 }
    const rights = at(t)
    rights.restore([{
      chatId: -720, deleteRefused: false, senderRefused: true, strikes: 5,
      probeAt: 0, warnedUntil: 0
    }])
    rights.noteOutcome(-720, ['ban: CHAT_ADMIN_REQUIRED'], 111)
    // An unknown last refusal is not evidence of a gap: the episode carries on
    // rather than being reset by our own missing record.
    expect(rights.strikes(-720)).toBe(6)
    expect(rights.gap(-720)).toEqual({ deleteBlocked: false, senderBlocked: true, accounts: 1 })
  })

  it('the store never sees a record aliased to the live one', () => {
    // `blockedAccounts` is the first mutable field on this record, and
    // `noteOutcome` pushes into it in place.
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noteOutcome(-730, bothRefused, 111)
    const first = saved.get(-730)?.blockedAccounts
    rights.noteOutcome(-730, bothRefused, 222)
    expect(first).toEqual([111])
  })

  it('a restored record is not aliased to the array the caller handed in', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    const mine = [111]
    rights.restore([{
      chatId: -740, deleteRefused: false, senderRefused: true, strikes: 1,
      probeAt: 0, warnedUntil: 0, lastRefusalAt: t.ms, blockedAccounts: mine
    }])
    rights.noteOutcome(-740, ['ban: FORBIDDEN'], 222)
    expect(mine).toEqual([111])
  })

  it('a restored refusal survives a restart that a lapsed expiry would not have', () => {
    // The regression this replaces: 2026-08-07 16:44:44 a chat reached
    // `blocked: true`; the process restarted at 17:00:24; at 17:05:15 the same
    // chat paid vectors, moderation and enrichment to be refused again.
    const t = { ms: 1_000_000 }
    const rights = at(t)
    rights.restore([{
      chatId: -710, deleteRefused: true, senderRefused: true, strikes: 3,
      probeAt: 0, warnedUntil: 0
    }])
    expect(rights.cannotEnforce(-710)).toBe(true)
    // Due for a probe, so recovery is one cheap call — not a full pipeline.
    expect(rights.mayProbe(-710)).toBe(true)
  })
})

/**
 * `execution.failed` stored the STEP that failed and nothing else — `["ban"]`.
 * Deliberately: the messages are Telegram's own unbounded strings and
 * `pipeline_decisions` is the largest collection in a database that has hit its
 * quota twice.
 *
 * The cost showed up on 2026-08-26. 306 refused calls in 48 hours, and the
 * first question — is this a chat that never granted the right, a flood wait,
 * or an account that had already left — could not be answered from the record
 * at all. It took a second collection (`pipeline_rights`) and a guess to learn
 * that one chat accounted for 271 of them because it grants delete and not ban.
 *
 * A CLASS is not a message: four fixed words, six bytes on the row, and the
 * question becomes one query. The classes stay coarse on purpose — they exist
 * to route an operator's attention, not to reproduce Telegram's error list.
 */
describe('failureKind — what kind of "no" this was', () => {
  it('reads a refusal of rights, whichever way Telegram phrases it', () => {
    expect(failureKind('ban: CHAT_ADMIN_REQUIRED')).toBe('rights')
    expect(failureKind('delete: MESSAGE_DELETE_FORBIDDEN')).toBe('rights')
    expect(failureKind('mute: not enough rights to restrict')).toBe('rights')
  })

  /**
   * The executor absorbs a flood wait up to a minute and lets longer ones
   * through, so what reaches the record is the bot being told to slow down for
   * a while — a fact about our own pace, not about the chat's settings. Filed
   * with the rights refusals it would look like a chat that took the right away
   * and gave it back.
   */
  it('separates being told to wait from being told no', () => {
    expect(failureKind('ban: FLOOD_WAIT_420')).toBe('flood')
  })

  /** Nothing to act on: the account left, or the message is already gone. */
  it('separates a target that is no longer there', () => {
    expect(failureKind('ban: USER_NOT_PARTICIPANT')).toBe('gone')
    expect(failureKind('delete: MESSAGE_ID_INVALID')).toBe('gone')
    expect(failureKind('mute: PARTICIPANT_ID_INVALID')).toBe('gone')
  })

  it('never guesses: an unrecognised failure is its own class', () => {
    expect(failureKind('ban: TIMEOUT')).toBe('other')
    expect(failureKind('')).toBe('other')
  })
})

describe('failureLabels — what the decision row stores', () => {
  it('keeps the step and adds the class, and nothing of the message', () => {
    expect(failureLabels(['delete: MESSAGE_DELETE_FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED']))
      .toEqual(['delete:rights', 'ban:rights'])
  })

  /**
   * The label half is what every stored row already carries, so a query written
   * against the old shape must still find these — `execution.failed` matching
   * /^ban/ has to keep meaning "the ban failed".
   */
  it('keeps the step first so the old prefix still identifies it', () => {
    expect(failureLabels(['ban: FLOOD_WAIT_420'])[0]?.startsWith('ban')).toBe(true)
  })

  /**
   * The executor writes `${label}: ${message}` and nothing else, so a string
   * without a colon cannot come from it — it is a shape we do not recognise,
   * and the whole of it is the most honest thing to call the step. `unknown` is
   * reached only by an empty string: the previous `?? 'unknown'` could never
   * fire at all, because `split` always returns at least one element.
   */
  it('does not invent a label it was not given', () => {
    expect(failureLabels(['boom'])).toEqual(['boom:other'])
    expect(failureLabels([''])).toEqual(['unknown:other'])
    expect(failureLabels([])).toEqual([])
  })

  /**
   * A refusal of no known kind used to store `ban:other` and nothing else —
   * 138 such rows in the week to 2026-09-01, and no way to tell a vanished
   * peer from an account Telegram had already deleted from them.
   */
  it('names the wire error for a refusal of no known kind', () => {
    // `INPUT_USER_DEACTIVATED` is what Telegram answers for an account it has
    // itself deleted since the message arrived — the likeliest reading of the
    // 124 rows in that one chat, and now a distinguishable one.
    expect(failureLabels(['ban: INPUT_USER_DEACTIVATED'])).toEqual(['ban:INPUT_USER_DEACTIVATED'])
    expect(failureLabels(['delete: CHAT_RESTRICTED'])).toEqual(['delete:CHAT_RESTRICTED'])
  })

  it('never stores free text from the error', () => {
    expect(failureLabels(['ban: something went badly wrong with Ivan'])).toEqual(['ban:other'])
  })
})

describe('rightsLogDecision', () => {
  const DAY = RIGHTS_LOG_REMIND_MS
  const shapes: RightsShape[] = ['none', 'delete', 'sender', 'all']

  it('nothing ever refused is not a log line', () => {
    expect(rightsLogDecision(undefined, 'none', 0)).toBeNull()
  })

  it('a first refusal is a WARN', () => {
    expect(rightsLogDecision(undefined, 'all', 0)).toEqual({ level: 'warn', change: 'lost' })
  })

  it('a different refused set is a WARN at once', () => {
    expect(rightsLogDecision({ shape: 'delete', at: 0 }, 'all', 1)).toEqual({ level: 'warn', change: 'changed' })
  })

  it('a refusal lifted is a WARN', () => {
    expect(rightsLogDecision({ shape: 'all', at: 0 }, 'none', 1)).toEqual({ level: 'warn', change: 'restored' })
  })

  it('an unchanged refusal is silent inside a day and an INFO after it', () => {
    expect(rightsLogDecision({ shape: 'all', at: 0 }, 'all', DAY - 1)).toBeNull()
    expect(rightsLogDecision({ shape: 'all', at: 0 }, 'all', DAY)).toEqual({ level: 'info', change: 'still' })
  })

  it('a clock running backwards is not a day passing', () => {
    expect(rightsLogDecision({ shape: 'all', at: 10 * DAY }, 'all', 0)).toBeNull()
  })

  it('property: WARN exactly on a change of shape, never for an unchanged one', () => {
    for (const prev of [undefined, ...shapes.map((shape) => ({ shape, at: 0 }))]) {
      for (const shape of shapes) {
        for (const now of [0, 1, DAY - 1, DAY, 5 * DAY]) {
          const d = rightsLogDecision(prev, shape, now)
          const before = prev?.shape ?? 'none'
          if (before !== shape) expect(d?.level).toBe('warn')
          else if (shape === 'none') expect(d).toBeNull()
          else expect(d === null || d.level === 'info').toBe(true)
        }
      }
    }
  })
})

describe('RightsMemory — notice history across a restart', () => {
  it('a restart in the middle of a cycle neither re-posts nor skips the reminder', () => {
    const t = { ms: 1_000 }
    const { rights, saved } = persisting(t)
    rights.noteOutcome(-760, bothRefused)
    expect(rights.noticeDecision(-760).post).toBe(true)
    const reborn = at(t)
    reborn.restore([saved.get(-760) as RightsRecord])
    expect(reborn.noticeDecision(-760).post).toBe(false)
    t.ms += RIGHTS_NOTICE_REMIND_MS
    expect(reborn.noticeDecision(-760)).toMatchObject({ post: true, reason: 'reminder' })
    expect(reborn.noticeDecision(-760).post).toBe(false)
  })

  it('a record asked under the old hourly quota counts as already reminded', () => {
    const t = { ms: 100 * HOUR }
    const rights = at(t)
    rights.restore([{
      chatId: -770, deleteRefused: true, senderRefused: true, strikes: 1,
      probeAt: 0, warnedUntil: t.ms - HOUR
    }])
    for (let h = 0; h < 72; h += 1) {
      expect(rights.noticeDecision(-770).post).toBe(false)
      t.ms += HOUR
    }
  })

  it('a record never asked under the old quota starts its cycle', () => {
    const t = { ms: 1_000_000 }
    const rights = at(t)
    rights.restore([{
      chatId: -780, deleteRefused: false, senderRefused: true, strikes: 1,
      probeAt: 0, warnedUntil: 0
    }])
    expect(rights.noticeDecision(-780)).toMatchObject({ post: true, reason: 'first', shape: 'sender' })
  })
})

describe('RightsMemory.logDecision', () => {
  const DAY = RIGHTS_LOG_REMIND_MS

  it('a block observed hourly logs one WARN, then one INFO a day', () => {
    // Production 2026-10-15: the same blocked chat logged a WARN every hour.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-900, bothRefused)
    const levels: string[] = []
    for (let hour = 0; hour <= 48; hour += 1) {
      const d = rights.logDecision(-900)
      if (d) levels.push(d.level)
      t.ms += 60 * 60 * 1000
    }
    expect(levels).toEqual(['warn', 'info', 'info'])
  })

  it('a granted probe does not flap the log; a success restores it', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-901, bothRefused)
    expect(rights.logDecision(-901)?.change).toBe('lost')
    rights.noteProbe(-901, ALL_RIGHTS)
    t.ms += 60_000
    rights.noteOutcome(-901, bothRefused)
    expect(rights.logDecision(-901)).toBeNull()
    rights.noteOutcome(-901, [])
    expect(rights.logDecision(-901)).toMatchObject({ level: 'warn', change: 'restored', shape: 'none' })
    expect(rights.logDecision(-901)).toBeNull()
  })

  it('a restart restates nothing until the daily reminder', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.restore([{
      chatId: -902, deleteRefused: true, senderRefused: true,
      strikes: 1, probeAt: 0, warnedUntil: 0
    }])
    expect(rights.logDecision(-902)).toBeNull()
    t.ms += DAY
    expect(rights.logDecision(-902)?.level).toBe('info')
  })
})
