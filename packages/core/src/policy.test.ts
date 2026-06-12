import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { decideAction, PRESET_THRESHOLDS, type PolicyInput } from './policy.js'

const makeInput = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  pSpam: 0.5,
  preset: 'standard',
  chatKind: 'group',
  captchaEnabled: true,
  votingEnabled: true,
  userIsNewish: true,
  userIsTrusted: false,
  ...overrides
})

describe('decideAction — standard preset', () => {
  it('clears low-probability messages', () => {
    expect(decideAction(makeInput({ pSpam: 0.1 }))).toEqual({ action: 'none', needsVote: false })
  })

  it('observes the grey zone without voting noise', () => {
    const d = decideAction(makeInput({ pSpam: 0.45, captchaEnabled: false }))
    expect(d.action).toBe('observe')
    expect(d.needsVote).toBe(false)
  })

  it('gates a suspicious newcomer with captcha when enabled', () => {
    expect(decideAction(makeInput({ pSpam: 0.5 })).action).toBe('captcha')
  })

  it('never captchas in discussion groups (channel comments)', () => {
    const d = decideAction(makeInput({ pSpam: 0.5, chatKind: 'discussion' }))
    expect(d.action).not.toBe('captcha')
  })

  it('never captchas established users', () => {
    const d = decideAction(makeInput({ pSpam: 0.5, userIsNewish: false }))
    expect(d.action).toBe('observe')
  })

  it('deletes with a vote in the delete band', () => {
    expect(decideAction(makeInput({ pSpam: 0.7 }))).toEqual({ action: 'delete', needsVote: true })
  })

  it('deletes without vote when voting is disabled', () => {
    expect(decideAction(makeInput({ pSpam: 0.7, votingEnabled: false }))).toEqual({ action: 'delete', needsVote: false })
  })

  it('mutes in the mute band', () => {
    expect(decideAction(makeInput({ pSpam: 0.88 })).action).toBe('mute')
  })

  it('bans only newish users; mutes established ones at the same pSpam', () => {
    expect(decideAction(makeInput({ pSpam: 0.97 })).action).toBe('ban')
    expect(decideAction(makeInput({ pSpam: 0.97, userIsNewish: false })).action).toBe('mute')
  })
})

describe('decideAction — presets', () => {
  it('soft preset acts later than standard', () => {
    expect(decideAction(makeInput({ pSpam: 0.7, preset: 'soft' })).action).not.toBe('delete')
    expect(decideAction(makeInput({ pSpam: 0.7, preset: 'standard' })).action).toBe('delete')
  })

  it('strict preset acts earlier than standard', () => {
    expect(decideAction(makeInput({ pSpam: 0.57, preset: 'strict' })).action).toBe('delete')
    expect(decideAction(makeInput({ pSpam: 0.57, preset: 'standard' })).action).not.toBe('delete')
  })

  it('thresholds are strictly ordered for every preset', () => {
    for (const t of Object.values(PRESET_THRESHOLDS)) {
      expect(t.ban).toBeGreaterThan(t.mute)
      expect(t.mute).toBeGreaterThan(t.delete)
      expect(t.delete).toBeGreaterThan(t.grey)
    }
  })
})

describe('decideAction — safety invariants', () => {
  it('trusted users are never auto-banned or muted (defensive cap)', () => {
    const d = decideAction(makeInput({ pSpam: 0.99, userIsTrusted: true }))
    expect(d.action).toBe('delete')
    expect(d.needsVote).toBe(true)
  })

  it('property: action severity is monotonic in pSpam', () => {
    const severity = { none: 0, observe: 1, captcha: 2, delete: 3, mute: 4, ban: 5 }
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          const dLo = decideAction(makeInput({ pSpam: lo }))
          const dHi = decideAction(makeInput({ pSpam: hi }))
          return severity[dHi.action] >= severity[dLo.action]
        }
      )
    )
  })

  it('property: never throws on degenerate pSpam', () => {
    for (const p of [0, 1, -0.1, 1.1, Number.NaN]) {
      expect(() => decideAction(makeInput({ pSpam: p }))).not.toThrow()
    }
  })

  it('NaN pSpam fails safe to observe', () => {
    expect(decideAction(makeInput({ pSpam: Number.NaN })).action).toBe('observe')
  })
})
