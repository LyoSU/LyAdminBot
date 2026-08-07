import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import {
  hasTextualContent, isEmojiOnly, isWellFormed, stripEmoji, stripInvisible, toWellFormed, truncate
} from './normalize.js'

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

  // Generous timeout: these property runs are fast in isolation (~2s) but can
  // exceed vitest's 5s default purely from CPU starvation when the whole suite
  // runs its files in parallel — a wall-clock flake, not a slow assertion.
  test('is idempotent for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = stripInvisible(s)
        return stripInvisible(once) === once
      })
    )
  }, 20000)

  test('never increases string length', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => stripInvisible(s).length <= s.length)
    )
  }, 20000)
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

describe('truncate', () => {
  test('REGRESSION: an odd boundary must not cut a surrogate pair in half', () => {
    // 2026-08-07: a bio was cut at 200 code units, one leading ASCII char put the
    // boundary inside an emoji, and the orphaned half travelled to OpenAI as the
    // escape \udXXX — legal JSON, so the body shipped, and the API answered 400
    // "unpaired UTF-16 surrogate code point and cannot be encoded as valid UTF-8"
    // for every message that hit it. A plain .slice() is what produced it.
    const cut = truncate(`a${'🔥'.repeat(150)}`, 200)
    expect(isWellFormed(cut)).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(200)
    // The dangling half is dropped, not replaced: half an emoji is not a
    // character, and a U+FFFD here would be an artifact we invented.
    expect(cut.endsWith('🔥')).toBe(true)
  })

  test('leaves anything within the limit untouched, including lone surrogates', () => {
    expect(truncate('привіт 😀', 200)).toBe('привіт 😀')
    // Not this function's job to repair input — only to cut without breaking.
    expect(truncate('\ud83d', 200)).toBe('\ud83d')
  })

  test('never exceeds the limit and never creates a lone surrogate', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 0, max: 40 }), (s, limit) => {
        const cut = truncate(s, limit)
        if (cut.length > limit) return false
        // A well-formed input must stay well-formed. A malformed one is passed
        // through as-is, so it may still carry the surrogates it arrived with.
        return !isWellFormed(s) || isWellFormed(cut)
      })
    )
  }, 20000)
})

describe('toWellFormed', () => {
  test('replaces orphaned surrogates, keeps valid pairs intact', () => {
    expect(toWellFormed('hi \ud83d there')).toBe('hi � there')
    expect(toWellFormed('hi \ude00 there')).toBe('hi � there')
    expect(toWellFormed('hi 😀 there')).toBe('hi 😀 there')
  })

  test('output is well-formed for any input, and idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = toWellFormed(s)
        return isWellFormed(once) && toWellFormed(once) === once && once.length === s.length
      })
    )
  }, 20000)

  test('agrees with the runtime\'s own String.prototype.toWellFormed', () => {
    // ES2024 ships exactly this operation; the repo targets lib ES2023 so it is
    // not typed, but Node 22 has it and it is the reference implementation.
    const native = (s: string): string =>
      (s as unknown as { toWellFormed?: () => string }).toWellFormed?.() ?? s
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => toWellFormed(s) === native(s))
    )
  }, 20000)
})
