import { describe, expect, it } from 'vitest'
import {
  RightsMemory, RIGHTS_PROBE_MS, RIGHTS_PROBE_MAX_MS, RIGHTS_WARN_MS, RIGHTS_WARN_MAX_MS,
  failureKind, failureLabels,
  type RightsRecord
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

    rights.noteProbe(-410, true)
    expect(rights.cannotEnforce(-410)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('a refused probe pushes the next one out and leaves the block standing', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-420, bothRefused)
    t.ms += RIGHTS_PROBE_MS + 1
    rights.noteProbe(-420, false)
    expect(rights.cannotEnforce(-420)).toBe(true)
    expect(rights.mayProbe(-420)).toBe(false)
  })

  it('a probe may only lift a block, never create one', () => {
    // The asymmetry that makes reading our own membership safe at all. Wrong in
    // the pessimistic direction it changes nothing; wrong in the optimistic
    // direction it costs one evaluation, and the refusal re-blocks the chat.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteProbe(-430, false)
    expect(rights.cannotEnforce(-430)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
    expect(rights.strikes(-430)).toBe(0)
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
    t.ms += RIGHTS_PROBE_MAX_MS * 3
    rights.noteOutcome(-830, bothRefused)
    expect(rights.strikes(-830)).toBe(1)
  })
})

/**
 * The nag quota, which is the part of this mechanism a chat can see.
 */
describe('RightsMemory — asking the admins', () => {
  it('asks once, then keeps quiet', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-500, bothRefused)
    expect(rights.shouldWarn(-500)).toBe(true)
    expect(rights.shouldWarn(-500)).toBe(false)
    t.ms += RIGHTS_WARN_MS + 1
    expect(rights.shouldWarn(-500)).toBe(true)
  })

  it('the quiet period grows with the strikes and stops at a day', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 20; i += 1) rights.noteOutcome(-510, bothRefused)
    expect(rights.shouldWarn(-510)).toBe(true)
    t.ms += RIGHTS_WARN_MAX_MS - 1
    expect(rights.shouldWarn(-510)).toBe(false)
    t.ms += 2
    expect(rights.shouldWarn(-510)).toBe(true)
  })

  it('a chat with nothing recorded may still be asked', () => {
    // The /banan path warns from its own failed attempt, without an execution
    // having gone through `noteOutcome` first.
    const t = { ms: 1_000 }
    const rights = at(t)
    expect(rights.shouldWarn(-520)).toBe(true)
    expect(rights.shouldWarn(-520)).toBe(false)
    // Being asked is not being blocked.
    expect(rights.cannotEnforce(-520)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('rights coming back resets the quota, so the next episode is heard', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-530, bothRefused)
    expect(rights.shouldWarn(-530)).toBe(true)
    rights.noteOutcome(-530, [])
    expect(rights.shouldWarn(-530)).toBe(true)
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
    expect(rights.shouldWarn(-700), 'already asked before the restart').toBe(false)
    expect(rights.strikes(-700)).toBe(4)
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
})
