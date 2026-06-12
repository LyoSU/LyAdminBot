import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { hasTextualContent, isEmojiOnly, stripEmoji, stripInvisible } from './normalize.js'

describe('stripEmoji', () => {
  test('removes plain emoji, keeps cyrillic text', () => {
    expect(stripEmoji('привіт 😀😀 друже')).toBe('привіт  друже')
  })

  test('removes ZWJ emoji sequences entirely', () => {
    // Family emoji: 👨 ZWJ 👩 ZWJ 👧 — must not leave stray joiners behind
    expect(stripEmoji('hi 👨‍👩‍👧 there')).toBe('hi  there')
  })

  test('removes keycap and variation-selector sequences', () => {
    expect(stripEmoji('1️⃣ test')).toBe('1 test')
  })

  test('returns empty string for empty input', () => {
    expect(stripEmoji('')).toBe('')
  })
})

describe('stripInvisible', () => {
  test('removes zero-width and directional format chars', () => {
    expect(stripInvisible('a​b‌c‍d‮e')).toBe('abcde')
  })

  test('is idempotent for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = stripInvisible(s)
        return stripInvisible(once) === once
      })
    )
  })

  test('never increases string length', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => stripInvisible(s).length <= s.length)
    )
  })
})

describe('hasTextualContent', () => {
  test('false for emoji-only message', () => {
    expect(hasTextualContent('😀🔥🚀')).toBe(false)
  })

  test('false for emoji + whitespace only', () => {
    expect(hasTextualContent('  😀  🔥  ')).toBe(false)
  })

  test('false for invisible-char padding around short text', () => {
    // Invisible chars must not count toward the textual minimum
    expect(hasTextualContent('​​​ok​​​')).toBe(false)
  })

  test('true for a normal sentence', () => {
    expect(hasTextualContent('привіт, як справи?')).toBe(true)
  })

  test('respects custom minimum length', () => {
    expect(hasTextualContent('обід', 5)).toBe(false)
    expect(hasTextualContent('обід', 4)).toBe(true)
  })

  test('false for empty and whitespace-only input', () => {
    expect(hasTextualContent('')).toBe(false)
    expect(hasTextualContent('   \n\t ')).toBe(false)
  })
})

describe('isEmojiOnly', () => {
  test('true for emoji-only, false for mixed, false for empty', () => {
    expect(isEmojiOnly('😀🔥')).toBe(true)
    expect(isEmojiOnly('привіт 😀 друже')).toBe(false)
    expect(isEmojiOnly('')).toBe(false)
  })
})
