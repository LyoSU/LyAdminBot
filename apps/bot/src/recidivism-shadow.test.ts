import { describe, expect, it } from 'vitest'
import { IGNORED_CAPTCHA_ESCALATION_MS, wouldEscalateAfterIgnoredCaptcha } from './recidivism-shadow.js'

describe('wouldEscalateAfterIgnoredCaptcha', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  const act = { action: 'delete', decidedBy: 'llm', messageId: 9 }
  const ago = (ms: number) => new Date(now - ms)

  it('marks a content delete within the week after an ignored captcha here', () => {
    expect(wouldEscalateAfterIgnoredCaptcha(act, ago(60_000), now)).toBe(true)
    expect(wouldEscalateAfterIgnoredCaptcha(act, ago(IGNORED_CAPTCHA_ESCALATION_MS), now)).toBe(true)
    for (const decidedBy of ['signature', 'llm_cached', 'session', 'score', 'burst']) {
      expect(wouldEscalateAfterIgnoredCaptcha({ ...act, decidedBy }, ago(60_000), now)).toBe(true)
    }
  })

  it('leaves no captcha, an old one, a heavier act, a non-message and a non-reading stage', () => {
    expect(wouldEscalateAfterIgnoredCaptcha(act, null, now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha(act, ago(IGNORED_CAPTCHA_ESCALATION_MS + 1), now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha({ ...act, action: 'ban' }, ago(60_000), now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha({ ...act, action: 'none' }, ago(60_000), now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha({ ...act, messageId: 0 }, ago(60_000), now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha({ ...act, decidedBy: 'captcha_ignored' }, ago(60_000), now)).toBe(false)
    expect(wouldEscalateAfterIgnoredCaptcha({ ...act, decidedBy: 'deterministic' }, ago(60_000), now)).toBe(false)
  })
})
