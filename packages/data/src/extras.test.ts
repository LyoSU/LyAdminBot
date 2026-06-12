import { describe, expect, it } from 'vitest'
import { matchExtras, normalizeExtra, parseHashtags } from './extras.js'

describe('parseHashtags', () => {
  it('extracts hashtag names without the #', () => {
    expect(parseHashtags('hello #rules and #faq')).toEqual(['rules', 'faq'])
  })

  it('handles unicode and underscores, ignores lone #', () => {
    expect(parseHashtags('#правила #faq_2 # nope')).toEqual(['правила', 'faq_2'])
  })

  it('returns empty for no hashtags', () => {
    expect(parseHashtags('just text')).toEqual([])
  })
})

describe('normalizeExtra', () => {
  it('passes through the v2 shape', () => {
    expect(normalizeExtra({ name: 'rules', text: 'be nice', fileId: null }))
      .toEqual({ name: 'rules', text: 'be nice', fileId: null })
  })

  it('reads a v1 text extra (telegraf payload)', () => {
    expect(normalizeExtra({ name: 'rules', type: 'text', message: { text: 'be nice' } }))
      .toEqual({ name: 'rules', text: 'be nice', fileId: null })
  })

  it('reads a v1 media extra, taking caption + bot-api file id', () => {
    expect(normalizeExtra({ name: 'meme', type: 'animation', message: { animation: 'BAAD123', caption: 'lol' } }))
      .toEqual({ name: 'meme', text: 'lol', fileId: 'BAAD123' })
  })

  it('returns null for an unnamed or empty extra', () => {
    expect(normalizeExtra({ type: 'text', message: { text: 'x' } })).toBeNull()
    expect(normalizeExtra(null)).toBeNull()
  })
})

describe('matchExtras', () => {
  const extras = [
    { name: 'rules', text: 'be nice', fileId: null },
    { name: 'faq', text: 'read pinned', fileId: null }
  ]

  it('matches hashtags to extras case-insensitively, capped by maxExtra', () => {
    expect(matchExtras('see #RULES and #faq', extras, 5).map((e) => e.name)).toEqual(['rules', 'faq'])
  })

  it('respects the maxExtra cap', () => {
    expect(matchExtras('#rules #faq', extras, 1)).toHaveLength(1)
  })

  it('ignores hashtags that name no extra', () => {
    expect(matchExtras('#nope #rules', extras, 5).map((e) => e.name)).toEqual(['rules'])
  })
})
