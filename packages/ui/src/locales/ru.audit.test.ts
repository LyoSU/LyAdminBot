import { describe, expect, it } from 'vitest'
import { ru } from './ru.js'

/**
 * Russian copy audit (2026-10-15). Each case pins a class of defect, not the
 * one example the audit found it on.
 */
describe('ru copy audit', () => {
  it('names a kick as removing the member, never as jargon a reader could take for a deleted message', () => {
    expect(ru.actions.kick).not.toMatch(/кик/i)
    expect(ru.actions.kick).toContain('из чата')
    expect(ru.actions.kick).not.toBe(ru.actions.delete)
  })

  it('describes an unknown person without a gendered verb in the banana and arrival lines', () => {
    // A display name says nothing about gender: past-tense or participle forms
    // that agree with the person ("лишился", "забанен") guess it.
    expect(ru.banan.lifted('X')).not.toMatch(/лишил(ся|ась)|остал(ся|ась)/)
    expect(ru.reasons.admin_arrival_ban).not.toMatch(/(^|\s)забанен(\s|$)/u)
  })

  it('spells the minute unit out, so a compact span cannot read as metres or months', () => {
    expect(ru.profile.units.m).toBe(ru.banan.units.m)
    expect(ru.profile.units.m).not.toBe('м')
    expect(ru.profile.units.mo).not.toBe(ru.profile.units.m)
  })

  it('keeps the animate accusative after a number when banning silent newcomers', () => {
    // "забанить 2 новичков" is the correct Russian for animate nouns (двух
    // новичков); "2 новичка" would be the inanimate form.
    expect(ru.arrivals.confirmAll(1)).toContain('новичка, который')
    for (const n of [2, 3, 4, 5, 11, 21, 22, 25, 101, 112]) {
      const text = ru.arrivals.confirmAll(n)
      expect(text).toContain(n % 10 === 1 && n % 100 !== 11 ? 'новичка, который' : 'новичков, которые')
    }
  })

  it('says the temporary restrictions lift themselves in plain words', () => {
    expect(ru.ownRestrictions.footer).not.toContain('на срок')
    expect(ru.ownRestrictions.footer).toContain('Временные ограничения')
  })

  it('keeps every group notice to one line', () => {
    for (const action of Object.values(ru.actions)) {
      expect(ru.notification.compact(action, 'X')).not.toContain('\n')
    }
  })
})
