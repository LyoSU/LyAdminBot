import { describe, expect, it } from 'vitest'
import { RightsMemory, RIGHTS_BLOCK_MS } from './rights.js'

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
    rights.noteFailures(-100, ['ban: Telegram API error 400: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-100)).toBe(false)
    expect(rights.blockedChats()).toEqual([
      { chatId: -100, deleteBlocked: false, senderBlocked: true }
    ])
  })

  it('a chat that refuses both is not worth paying an LLM for', () => {
    // Neither the message nor the sender can be touched here.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-200, [
      'delete: Telegram API error 403: MESSAGE_DELETE_FORBIDDEN',
      'mute: Telegram API error 400: CHAT_ADMIN_REQUIRED'
    ])
    expect(rights.cannotEnforce(-200)).toBe(true)
  })

  it('capabilities accumulate across separate refusals', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-300, ['delete: MESSAGE_DELETE_FORBIDDEN'])
    expect(rights.cannotEnforce(-300)).toBe(false)
    rights.noteFailures(-300, ['kick: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-300)).toBe(true)
  })

  it('the block expires on its own, so granted rights resume moderation', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-400, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-400)).toBe(true)
    t.ms += RIGHTS_BLOCK_MS + 1
    expect(rights.cannotEnforce(-400)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('a fresh refusal extends the block', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-500, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    t.ms += RIGHTS_BLOCK_MS - 1
    rights.noteFailures(-500, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    t.ms += 2
    expect(rights.cannotEnforce(-500)).toBe(true)
  })

  it('errors that are not about rights never block anything', () => {
    // A flood wait, a network blip or a deleted message must not be mistaken
    // for a permission problem — that would stand the bot down over a hiccup.
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-600, [
      'delete: Telegram API error 400: MESSAGE_ID_INVALID',
      'ban: FLOOD_WAIT_30',
      'mute: fetch failed'
    ])
    expect(rights.cannotEnforce(-600)).toBe(false)
    expect(rights.blockedChats()).toEqual([])
  })

  it('an empty error list is not evidence of anything', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-700, [])
    expect(rights.blockedChats()).toEqual([])
  })

  it('blocks are per chat, never global', () => {
    const t = { ms: 1_000 }
    const rights = at(t)
    rights.noteFailures(-800, ['delete: FORBIDDEN', 'ban: CHAT_ADMIN_REQUIRED'])
    expect(rights.cannotEnforce(-800)).toBe(true)
    expect(rights.cannotEnforce(-900)).toBe(false)
  })
})
