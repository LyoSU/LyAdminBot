import { describe, expect, it } from 'vitest'
import { tr } from './tr.js'

/**
 * Turkish copy audit (2026-10-15), applied on top of the uk-meaning sync. Each
 * block pins a class of defect, not a single string: a calque or ambiguous
 * term that came back in one key tends to come back in its neighbours.
 */
const allStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (typeof value === 'function') return []
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings)
  return []
}

describe('tr copy audit', () => {
  const texts = allStrings(tr)

  it('never uses the "tarafından" passive calque', () => {
    for (const text of texts) expect(text).not.toMatch(/tarafından/)
  })

  it('names Telegram as the subject, never "Telegram hesabı" (reads as "a Telegram account")', () => {
    const labels = [...Object.values(tr.reasons), ...Object.values(tr.why.signalLabels)]
    for (const text of labels) expect(text).not.toMatch(/Telegram hesabı/)
    expect(tr.why.signalLabels.scam_flag).toBe('Telegram bu hesabı dolandırıcı olarak işaretledi')
  })

  it('keeps one word for a report — "bildirim" is the bot\'s own notice', () => {
    const reportSurfaces = [
      tr.commands.report, tr.report.cantReportAdmin, tr.report.rateLimited,
      tr.reasons.admin_report, tr.reasons.trusted_report,
      tr.helpText.split('\n').find((line) => line.startsWith('/report'))!
    ]
    for (const text of reportSurfaces) {
      expect(text).not.toMatch(/bildir/)
      expect(text).toMatch(/şikâyet/)
    }
  })

  it('uses one verb for removing trust, as the button does', () => {
    expect(tr.trust.untrustButton).toContain('Güveni kaldır')
    for (const text of [tr.commands.untrust, tr.untrust.success('X'), tr.untrust.needReply]) {
      expect(text).toMatch(/kaldır/)
      expect(text).not.toMatch(/geri al/)
    }
  })

  it('says "düğme" and "özel sohbet", never "buton" or "PM"', () => {
    for (const text of texts) expect(text).not.toMatch(/buton|\bPM\b|(^|\s)banla/)
  })

  it('writes the common noun "spam" without an apostrophe', () => {
    for (const text of texts) expect(text).not.toMatch(/spam’|spam'/i)
  })

  it('never glues a suffix to a variable percent — vowel harmony cannot be picked for it', () => {
    for (const line of [tr.botStats.quiet(97.7), tr.botStats.corrections(1)]) {
      expect(line).not.toMatch(/%[\d,]+(<\/b>)?['’]?\p{L}/u)
      expect(line).not.toMatch(/kadar/)
    }
  })

  it('counts people with "kişi", not "tane"', () => {
    expect(tr.cohort.banned(2, 3, 'A')).toContain('3 yeni üyeden 2 kişi')
    expect(tr.welcome.surgeAlert(14, 6)).toContain('6 kişi şüpheli')
    for (const text of [tr.cohort.banned(2, 3, 'A'), tr.welcome.surgeAlert(14, 6)]) expect(text).not.toMatch(/tane/)
  })

  it('profile activity reads "N sohbette", no plural after the number', () => {
    expect(tr.profile.activity(5, 3)).toBe('5 mesaj · 3 sohbette')
    expect(tr.profile.activity(null, 1)).toBe('1 sohbette')
  })

  it('names the cohort keep action without the ambiguous "Bırak"', () => {
    expect(tr.cohort.keepButton).not.toMatch(/^Bırak$/)
    expect(tr.cohort.kept('A')).toContain('kalıyor')
  })

  it('writes GIF as the acronym everywhere it is user-facing', () => {
    for (const text of texts) expect(text).not.toMatch(/\bgif\b|\bGif\b|gif’/)
  })

  it('a burst and a session are both a "dizi"', () => {
    expect(tr.why.decidedBy.session).toContain('dizi')
    expect(tr.why.decidedBy.burst).toContain('dizi')
    expect(tr.why.decidedBy.burst).not.toMatch(/gönderenin dizisinin/)
  })
})
