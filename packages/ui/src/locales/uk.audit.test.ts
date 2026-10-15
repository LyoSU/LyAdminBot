import { describe, expect, it } from 'vitest'
import { uk } from './uk.js'

describe('uk copy audit (2026-10-15)', () => {
  it('counts the accounts a missing right left in place without a verb to agree', () => {
    const line = (accounts: number): string =>
      uk.notification.missingRights({ deleteBlocked: false, senderBlocked: true, accounts })
    expect(line(1)).toContain('За добу не вдалося прибрати 1 акаунт.')
    expect(line(3)).toContain('За добу не вдалося прибрати 3 акаунти.')
    expect(line(21)).toContain('За добу не вдалося прибрати 21 акаунт.')
    expect(line(11)).toContain('11 акаунтів.')
    expect(line(0)).not.toContain('За добу')
  })

  it('keeps every missing-rights notice on one line and names the missing right', () => {
    for (const gap of [
      { deleteBlocked: false, senderBlocked: true, accounts: 5 },
      { deleteBlocked: true, senderBlocked: false, accounts: 0 },
      { deleteBlocked: true, senderBlocked: true, accounts: 5 }
    ]) {
      const text = uk.notification.missingRights(gap)
      expect(text).not.toContain('\n')
      expect(text).toMatch(/бракує прав/)
    }
  })

  it('prints the explicit-photo score as a percent, like the confidence line', () => {
    expect(uk.why.profileMediaEvidence('0.87')).toBe('відверте фото в профілі · оцінка 87%')
    expect(uk.why.profileMediaEvidence('1.00')).toContain('100%')
  })

  it('names the join screen and the ignored captcha in the admin footer', () => {
    expect(uk.why.decidedBy['join_screen']).toBeTruthy()
    expect(uk.why.decidedBy['captcha_ignored']).toBeTruthy()
  })

  it('does not call people suspicious in the public surge alert', () => {
    const text = uk.welcome.surgeAlert(14, 6)
    expect(text).toBe('⚠️ Наплив новачків: 14 учасників, з них 6 — з підозрілим профілем')
    expect(text).not.toContain('підозрілих')
  })

  it('says a refused report was a reply to a join of several people', () => {
    expect(uk.report.oneAtATime).toContain('вхід кількох людей')
  })

  it('shows a button name in quotes, not in brackets', () => {
    expect(uk.helpText).not.toContain('[✅ Не спам]')
    expect(uk.helpText).toContain('«✅ Не спам»')
  })
})
