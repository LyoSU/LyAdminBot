import { describe, expect, it } from 'vitest'
import { RightsMemory, RIGHTS_BLOCK_MS, RIGHTS_BLOCK_MAX_MS } from './rights.js'

const at = (t: { ms: number }): RightsMemory => new RightsMemory(() => t.ms)

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

  it('the block expires on its own, so granted rights resume moderation', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-400, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-400)).toBe(true)
    t.ms += RIGHTS_BLOCK_MS + 1
    expect(rights.cannotEnforce(-400)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('a fresh refusal extends the block', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-500, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    t.ms += RIGHTS_BLOCK_MS - 1
    rights.noteOutcome(-500, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    t.ms += 2
    expect(rights.cannotEnforce(-500)).toBe(true)
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
    // The only positive evidence this class ever gets. A backoff that can grow
    // but never shrink would eventually stand the bot down in a chat that had
    // long since promoted it.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-700, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
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

  it('the block doubles while the refusal persists', () => {
    // Production 2026-08-01: an advert reposted on a roughly quarter-hourly
    // cadence, just slower than a flat quarter-hour block, so every repost
    // landed after the block lapsed and paid the full pipeline price again.
    // Six evaluations, nothing enforced. The block has to outgrow the cadence.
    const t = { ms: 1_000 }
    const rights = at(t)
    const bothRefused = ['delete: FORBIDDEN', 'mute: CHAT_ADMIN_REQUIRED']

    rights.noteOutcome(-800, bothRefused)
    t.ms += RIGHTS_BLOCK_MS + 1
    expect(rights.cannotEnforce(-800)).toBe(false)

    rights.noteOutcome(-800, bothRefused)
    t.ms += RIGHTS_BLOCK_MS + 1
    expect(rights.cannotEnforce(-800), 'second refusal buys twice as long').toBe(true)
    t.ms += RIGHTS_BLOCK_MS
    expect(rights.cannotEnforce(-800)).toBe(false)
  })

  it('the doubling has a ceiling, so granted rights are never waited on for long', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    for (let i = 0; i < 20; i += 1) {
      rights.noteOutcome(-810, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    }
    t.ms += RIGHTS_BLOCK_MAX_MS + 1
    expect(rights.cannotEnforce(-810)).toBe(false)
  })

  it('a refusal long after the last one starts a new episode', () => {
    // Otherwise a chat that briefly demoted the bot a year ago jumps straight
    // to the ceiling on its next hiccup.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-820, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    t.ms += RIGHTS_BLOCK_MAX_MS * 3
    rights.noteOutcome(-820, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.strikes(-820)).toBe(1)
    t.ms += RIGHTS_BLOCK_MS + 1
    expect(rights.cannotEnforce(-820)).toBe(false)
  })

  it('blocks are per chat, never global', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteOutcome(-800, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-800)).toBe(true)
    expect(rights.cannotEnforce(-900)).toBe(false)
  })
})
