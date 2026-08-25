import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import {
  hasTextualContent, isEmojiOnly, isWellFormed, redactLinks, stripEmoji, stripInvisible,
  toWellFormed, truncate
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

  test('REGRESSION: a short word is not an emoji', () => {
    // Until 2026-08-22 this borrowed `hasTextualContent`'s default of five
    // characters, so ANY text under five characters read as emoji-only and
    // collected the reaction discount. Production 2026-08-20 logged
    // `emoji_only=-1.5` against the two-letter text "NV". The question here is
    // not "is there enough text to embed" but "is there any text at all".
    expect(isEmojiOnly('NV')).toBe(false)
    expect(isEmojiOnly('ок')).toBe(false)
    expect(isEmojiOnly('...')).toBe(false)
    expect(isEmojiOnly('+')).toBe(false)
    // One stray character is enough to stop it being emoji-only.
    expect(isEmojiOnly('😀!')).toBe(false)
  })

  test('flags read as emoji whatever the count', () => {
    // Regional indicators sit at U+1F1E6-1F1FF, below the range `stripEmoji`
    // covered, so they survived stripping and counted as text. One flag slipped
    // through as emoji-only anyway — four code units, under the old five-char
    // bar — while two flags did not. Same input shape, opposite answers.
    expect(isEmojiOnly('🇺🇦')).toBe(true)
    expect(isEmojiOnly('🇺🇦🇺🇦')).toBe(true)
    expect(isEmojiOnly('🇺🇦 слава')).toBe(false)
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

describe('redactLinks', () => {
  const m = { link: '[посилання]', mention: '[@згадка]', invite: '[запрошення]' }

  test('an invite is named an invite, not merely a link', () => {
    expect(redactLinks('заходь t.me/+AbCd123 швидко', m)).toBe('заходь [запрошення] швидко')
    expect(redactLinks('https://t.me/joinchat/XYZ', m)).toBe('[запрошення]')
  })

  test('channels, sites and handles all lose their destination', () => {
    expect(redactLinks('канал t.me/promo тут', m)).toBe('канал [посилання] тут')
    expect(redactLinks('пиши @cryptoking', m)).toBe('пиши [@згадка]')
    expect(redactLinks('деталі example.com/promo', m)).toBe('деталі [посилання]')
    expect(redactLinks('www.foo.bar/x', m)).toBe('[посилання]')
    expect(redactLinks('tg://user?id=1', m)).toBe('[посилання]')
    expect(redactLinks('лист a.b@gmail.com', m)).toBe('лист [посилання]')
  })

  test('ordinary writing survives', () => {
    // The whole failure mode of a redactor is eating the words it was asked to
    // show. A filename and a module name are not destinations; neither is the
    // "t.me" that hides inside an ordinary word.
    const plain = 'звіт.pdf і node.js лежать у part.men, і т.д.'
    expect(redactLinks(plain, m)).toBe(plain)
    expect(redactLinks('пиши @всім і @ok', m)).toBe('пиши @всім і @ok')
  })

  test('a message made only of a link keeps a body', () => {
    // Replacement, never deletion: the ballot decides between "quote this" and
    // "there was no text" on whether anything is left, and a link-only advert
    // has text.
    expect(redactLinks('https://evil.example/a', m)).not.toBe('')
  })

  test('markers containing a dollar sign are not read as group references', () => {
    expect(redactLinks('http://x.test/a', { link: '$1 $&', mention: '$$', invite: '$`' }))
      .toBe('$1 $&')
  })

  test('never leaves an orphaned surrogate half', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => isWellFormed(redactLinks(s, m)) || !isWellFormed(s))
    )
  }, 20000)

  test('a second pass finds nothing left to redact', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = redactLinks(s, m)
        return redactLinks(once, m) === once
      })
    )
  }, 20000)
})
