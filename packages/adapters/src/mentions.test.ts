import { describe, expect, it } from 'vitest'
import { resolveMentionKinds } from './mentions.js'

describe('resolveMentionKinds', () => {
  it('classifies a username that ends with "bot" as a bot (Telegram rule)', () => {
    expect(resolveMentionKinds(['SomeCryptoBot'])).toEqual([
      { username: 'SomeCryptoBot', kind: 'bot', isNewish: null }
    ])
  })

  it('is case-insensitive about the bot suffix', () => {
    expect(resolveMentionKinds(['PUMPBOT'])[0]?.kind).toBe('bot')
  })

  it('leaves ordinary mentions unknown (no network resolution)', () => {
    expect(resolveMentionKinds(['durov'])[0]?.kind).toBe('unknown')
  })

  it('handles a leading @ and dedupes case-insensitively', () => {
    expect(resolveMentionKinds(['@Spambot', 'spambot'])).toEqual([
      { username: 'Spambot', kind: 'bot', isNewish: null }
    ])
  })

  it('returns an empty list for no mentions', () => {
    expect(resolveMentionKinds([])).toEqual([])
  })
})
