/**
 * Admin custom rules ("ALLOW: ..." / "DENY: ..."). Matching is whole-word,
 * not substring: a short pattern like "cas" must not fire on "because". JS
 * \b is ASCII-only, so boundaries are asserted against Unicode letter/number
 * classes to work for Cyrillic and other scripts.
 */
export interface CustomRule {
  kind: 'allow' | 'deny'
  pattern: string
}

export const parseCustomRule = (raw: string): CustomRule | null => {
  const match = /^(ALLOW|DENY)\s*:\s*(.+)$/i.exec(raw.trim())
  if (!match) return null
  const pattern = (match[2] ?? '').trim()
  if (!pattern) return null
  return { kind: match[1]!.toUpperCase() === 'ALLOW' ? 'allow' : 'deny', pattern }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `pattern` appears in `text` as a whole word/phrase (case-insensitive). */
export const customRuleMatches = (text: string, pattern: string): boolean => {
  try {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(pattern)}(?![\\p{L}\\p{N}])`, 'iu')
    return re.test(text)
  } catch {
    // A pattern that somehow defeats the regex must never throw the pipeline;
    // fall back to the old substring behaviour.
    return text.toLowerCase().includes(pattern.toLowerCase())
  }
}
