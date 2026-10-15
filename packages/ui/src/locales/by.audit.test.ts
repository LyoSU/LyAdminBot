import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { by } from './by.js'

/**
 * Belarusian copy audit, 2026-10-15. The locale is written in the official
 * 2008 orthography; these asserts pin the defects that audit found, and the
 * source scans keep the whole class out rather than the single example.
 */

/** Every string literal in by.ts, with comments dropped. */
const literals = (): string[] => {
  const source = readFileSync(fileURLToPath(new URL('./by.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  return [...source.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '')
}

describe('by locale: copy audit', () => {
  it('declines the missing-rights copy the Belarusian way', () => {
    const banOnly = by.notification.missingRights({ deleteBlocked: false, senderBlocked: true, accounts: 0 })
    expect(banOnly).toContain('саміх спамераў')
    const both = by.notification.missingRights({ deleteBlocked: true, senderBlocked: true, accounts: 0 })
    expect(both).toContain('не маю правоў')
    expect(both).not.toMatch(/праў\b/)
  })

  it('declines "чат" with the Belarusian genitive', () => {
    expect(by.why.signalLabels.foreign_script).toContain('для чата')
  })

  it('reads /mystats like the uk meaning: all chats, bananas received', () => {
    expect(by.stats.global(12)).toBe('Паведамленняў ва ўсіх чатах: 12')
    expect(by.stats.bananCaught(3)).toBe('Бананаў атрымана: 3 🍌')
  })

  it('carries no letters outside the Belarusian alphabet', () => {
    const foreign = literals().filter((s) => /[иИщЩъЪїЇєЄґҐ]/.test(s))
    expect(foreign).toEqual([])
  })

  it('writes ў after a vowel and never after a consonant', () => {
    const literal = literals()
    // A word-initial "у" right after a vowel-final word is "ў" (нескладовае).
    expect(literal.filter((s) => /[аеёіоуыэюя] у[^\s.,:;!?]/i.test(s) || /[аеёіоуыэюя] у\s/i.test(s))).toEqual([])
    expect(literal.filter((s) => /[бвгджзйклмнпрстфхцчшь] ў/i.test(s))).toEqual([])
  })
})
