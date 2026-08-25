import { describe, expect, it } from 'vitest'
import { velocityKey } from './persistent-ports.js'

/**
 * What the six-hour window counts copies of.
 *
 * The rules here are not stylistic: one of them was the hole a whole class of
 * account walked through for months, and the other is the guard that stops the
 * fix from becoming the 2026-02 hash-collapse defect again.
 */
describe('velocityKey', () => {
  it('keys a normal message on its template', () => {
    const key = velocityKey('Заходьте на мій канал, там усе про роботу')
    expect(key).toMatch(/^t:[0-9a-f]{32}$/)
  })

  it('gives one template key to two messages that differ only in noise', () => {
    const a = velocityKey('Заходьте на канал 111')
    const b = velocityKey('Заходьте на канал 222')
    expect(a).toBe(b)
  })

  /**
   * The default, unchanged: a template under five characters describes half the
   * chat, so it is refused rather than counted. This is what made emoji
   * repetition invisible, and it stays the default for everybody who does not
   * explicitly ask otherwise.
   */
  it('refuses a text whose template is too short to mean anything', () => {
    expect(velocityKey('💗')).toBeNull()
    expect(velocityKey('👍👍')).toBeNull()
    expect(velocityKey('ок')).toBeNull()
  })

  /**
   * The 2026-08-25 case: one heart emoji, six times, twelve hours, one chat,
   * from an account whose bio held a private invite. Every clock in the
   * pipeline is shorter than the gap between the copies, and the one that is
   * not refused to key on the text at all.
   */
  it('counts the exact text when the caller asks and the template is unusable', () => {
    const key = velocityKey('💗', { countExactWhenTemplateUnusable: true })
    expect(key).toMatch(/^x:[0-9a-f]{32}$/)
  })

  it('gives two different emoji two different keys — exact means exact', () => {
    const heart = velocityKey('💗', { countExactWhenTemplateUnusable: true })
    const thumb = velocityKey('👍', { countExactWhenTemplateUnusable: true })
    expect(heart).not.toBe(thumb)
  })

  it('ignores surrounding whitespace, so a padded repeat is still a repeat', () => {
    const bare = velocityKey('💗', { countExactWhenTemplateUnusable: true })
    const padded = velocityKey('  💗\n', { countExactWhenTemplateUnusable: true })
    expect(padded).toBe(bare)
  })

  /**
   * Template and exact keys must never share a counter: one means "messages
   * shaped like this", the other "this message, again". A caller reading a
   * count has to know which it got.
   */
  it('never lets a template and an exact text collide', () => {
    const template = velocityKey('приходьте до нас у канал')
    const exact = velocityKey('приходьте до нас у канал', { countExactWhenTemplateUnusable: true })
    // A usable template still wins — the option only covers the unusable case.
    expect(exact).toBe(template)
    expect(exact?.startsWith('t:')).toBe(true)
  })

  /**
   * The empty message is the one thing exact matching must still refuse. It is
   * the same collapse the template rule exists to prevent, arriving by another
   * road — and this codebase has shipped it twice: `normalizeHeavy` giving every
   * emoji-only message the hash of the empty string, and an empty ballot
   * collecting votes.
   */
  it('refuses an empty or whitespace-only message even when asked for exact', () => {
    for (const text of ['', '   ', '\n\n', '\t']) {
      expect(velocityKey(text, { countExactWhenTemplateUnusable: true })).toBeNull()
    }
  })
})
