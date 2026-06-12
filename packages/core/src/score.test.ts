import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Signal } from './types.js'
import { scoreSignals, SIGNAL_WEIGHTS, BASE_RATE_BIAS } from './score.js'

describe('scoreSignals', () => {
  it('returns the base rate for an empty signal list', () => {
    const { pSpam } = scoreSignals([])
    expect(pSpam).toBeGreaterThan(0.05)
    expect(pSpam).toBeLessThan(0.15)
  })

  it('strong suspicious combinations push pSpam high', () => {
    const signals: Signal[] = [
      { name: 'scam_flag' },
      { name: 'external_ban' },
      { name: 'private_invite_link' },
      { name: 'new_globally' }
    ]
    expect(scoreSignals(signals).pSpam).toBeGreaterThan(0.9)
  })

  it('trust signals push pSpam below the base rate', () => {
    const signals: Signal[] = [
      { name: 'trusted_reputation', negative: true },
      { name: 'established_user', negative: true },
      { name: 'is_reply', negative: true }
    ]
    expect(scoreSignals(signals).pSpam).toBeLessThan(0.02)
  })

  it('sleeper_awakened alone stays below auto-action territory (prod FP class)', () => {
    // Lost-pet posts from old quiet accounts must not be auto-muted:
    // sleeper + external_url + new_in_chat must stay in the votable band.
    const signals: Signal[] = [
      { name: 'sleeper_awakened' },
      { name: 'external_url' },
      { name: 'new_in_chat' }
    ]
    const { pSpam } = scoreSignals(signals)
    expect(pSpam).toBeLessThan(0.85)
  })

  it('unknown signal names contribute zero weight', () => {
    const base = scoreSignals([{ name: 'external_url' }]).pSpam
    const withUnknown = scoreSignals([{ name: 'external_url' }, { name: 'totally_unknown_signal' }]).pSpam
    expect(withUnknown).toBeCloseTo(base, 10)
  })

  it('duplicate signals are counted once', () => {
    const once = scoreSignals([{ name: 'phone_number' }]).pSpam
    const twice = scoreSignals([{ name: 'phone_number' }, { name: 'phone_number' }]).pSpam
    expect(twice).toBeCloseTo(once, 10)
  })

  it('reports top contributors sorted by absolute weight', () => {
    const { topContributors } = scoreSignals([
      { name: 'long_text' },
      { name: 'scam_flag' },
      { name: 'is_reply', negative: true }
    ])
    expect(topContributors[0]?.name).toBe('scam_flag')
  })

  const knownNames = Object.keys(SIGNAL_WEIGHTS)
  const signalArb = fc.array(
    fc.constantFrom(...knownNames).map((name): Signal => ({ name })),
    { maxLength: 15 }
  )

  it('property: pSpam is always within [0, 1]', () => {
    fc.assert(
      fc.property(signalArb, (signals) => {
        const { pSpam } = scoreSignals(signals)
        return pSpam >= 0 && pSpam <= 1 && Number.isFinite(pSpam)
      })
    )
  })

  it('property: adding a positive-weight signal never lowers pSpam', () => {
    const positives = knownNames.filter((n) => (SIGNAL_WEIGHTS[n] ?? 0) > 0)
    fc.assert(
      fc.property(signalArb, fc.constantFrom(...positives), (signals, extra) => {
        const before = scoreSignals(signals).pSpam
        const after = scoreSignals([...signals, { name: extra }]).pSpam
        return after >= before - 1e-12
      })
    )
  })

  it('property: adding a trust signal never raises pSpam', () => {
    const negatives = knownNames.filter((n) => (SIGNAL_WEIGHTS[n] ?? 0) < 0)
    fc.assert(
      fc.property(signalArb, fc.constantFrom(...negatives), (signals, extra) => {
        const before = scoreSignals(signals).pSpam
        const after = scoreSignals([...signals, { name: extra, negative: true }]).pSpam
        return after <= before + 1e-12
      })
    )
  })

  it('exposes a sane base-rate bias for replay calibration', () => {
    expect(BASE_RATE_BIAS).toBeLessThan(0)
  })
})
