import { describe, expect, it } from 'vitest'
import { conversationLineFor } from './conversation.js'

const member = { id: 42, isChannel: false }
const channel = { id: -1001, isChannel: true }

describe('conversationLineFor — whose line is it', () => {
  it('a member commenting under a channel post is still the member', () => {
    // The inverted version of this filed the commenter's own words as
    // `channel_post` with a null author, because it read the reply target
    // instead of the author (2026-07-31).
    const line = conversationLineFor({ text: 'Вітаю молодят!' }, member)
    expect(line).toEqual({ authorId: 42, authorKind: 'user', textPreview: 'Вітаю молодят!' })
  })

  it('a message sent AS a channel is the channel post', () => {
    expect(conversationLineFor({ text: 'новий допис' }, channel)?.authorKind).toBe('channel_post')
  })

  it('keeps the author id so the sender can be recognised next time', () => {
    // `[SENDER]` in the prompt is matched on this id. A null here is what made
    // a sender's own escalating messages unattributable to them.
    expect(conversationLineFor({ text: 'раз' }, member)?.authorId).toBe(42)
    expect(conversationLineFor({ text: 'два' }, channel)?.authorId).toBe(-1001)
  })

  it('drops a message with nothing to remember', () => {
    expect(conversationLineFor({ text: '' }, member)).toBeNull()
    expect(conversationLineFor({ text: '   \n  ' }, member)).toBeNull()
  })

  it('remembers the text as written, not trimmed', () => {
    // Only the emptiness test trims; leading layout can itself be the message.
    expect(conversationLineFor({ text: '  привіт  ' }, member)?.textPreview).toBe('  привіт  ')
  })
})
