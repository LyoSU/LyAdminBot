import { describe, expect, it } from 'vitest'
import { parseCustomRule, customRuleMatches } from './custom-rules.js'

describe('parseCustomRule', () => {
  it('parses ALLOW / DENY (case-insensitive, trimmed)', () => {
    expect(parseCustomRule('DENY: казино')).toEqual({ kind: 'deny', pattern: 'казино' })
    expect(parseCustomRule('  allow :  hello world ')).toEqual({ kind: 'allow', pattern: 'hello world' })
  })

  it('rejects malformed or empty rules', () => {
    expect(parseCustomRule('just text')).toBeNull()
    expect(parseCustomRule('DENY:')).toBeNull()
    expect(parseCustomRule('DENY:   ')).toBeNull()
  })
})

describe('customRuleMatches (word-boundary, not substring)', () => {
  it('matches the pattern as a whole word', () => {
    expect(customRuleMatches('join cas now', 'cas')).toBe(true)
    expect(customRuleMatches('CAS list', 'cas')).toBe(true)       // case-insensitive
    expect(customRuleMatches('spam! buy', 'spam')).toBe(true)      // punctuation boundary
  })

  it('does NOT match a pattern embedded inside another word', () => {
    expect(customRuleMatches('because of this', 'cas')).toBe(false)
    expect(customRuleMatches('спамер пише', 'спам')).toBe(false)   // Cyrillic boundary
  })

  it('matches Cyrillic whole words', () => {
    expect(customRuleMatches('це спам.', 'спам')).toBe(true)
  })

  it('matches multi-word phrases', () => {
    expect(customRuleMatches('please buy now!', 'buy now')).toBe(true)
    expect(customRuleMatches('buynow', 'buy now')).toBe(false)
  })

  it('treats regex metacharacters in the pattern literally', () => {
    expect(customRuleMatches('visit a.b.c today', 'a.b.c')).toBe(true)
    expect(customRuleMatches('visit axbxc today', 'a.b.c')).toBe(false)
  })
})
