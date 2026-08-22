import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { StrictnessPreset, VerdictAction } from './types.js'
import {
  decideAction, isEnforcementAction, countsAsDetection, countsAgainstSender, ENFORCEMENT_ACTIONS,
  PRESET_THRESHOLDS, TIMED_BAN_SECONDS, type PolicyInput
} from './policy.js'

const makeInput = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  pSpam: 0.5,
  preset: 'standard',
  chatKind: 'group',
  captchaEnabled: true,
  votingEnabled: true,
  userIsNewish: true,
  userIsTrusted: false,
  userHasHardVerdict: false,
  ...overrides
})

/**
 * Severity is declared over the full VerdictAction union, so adding an action
 * without ranking it fails to compile instead of silently comparing
 * `undefined` (which the old hand-written object literal did).
 */
const SEVERITY: Record<VerdictAction, number> = {
  none: 0, observe: 1, captcha: 2, delete: 3, kick: 4, mute: 5, ban: 6
}

const PRESETS: StrictnessPreset[] = ['soft', 'standard', 'strict']

/** Arbitrary policy input — everything except pSpam, which callers vary. */
const inputArb = fc.record({
  preset: fc.constantFrom<StrictnessPreset>(...PRESETS),
  chatKind: fc.constantFrom<'group' | 'discussion'>('group', 'discussion'),
  captchaEnabled: fc.boolean(),
  votingEnabled: fc.boolean(),
  userIsNewish: fc.boolean(),
  userIsTrusted: fc.boolean(),
  userHasHardVerdict: fc.boolean(),
  hasPermanentBanGrounds: fc.boolean()
})

const pSpamArb = fc.double({ min: 0, max: 1, noNaN: true })

describe('decideAction — standard preset', () => {
  it('clears low-probability messages', () => {
    expect(decideAction(makeInput({ pSpam: 0.1 })).action).toBe('none')
  })

  it('observes the grey zone without voting noise', () => {
    const d = decideAction(makeInput({ pSpam: 0.45, captchaEnabled: false }))
    expect(d.action).toBe('observe')
    expect(d.needsVote).toBe(false)
  })

  it('gates a suspicious newcomer with captcha when enabled', () => {
    expect(decideAction(makeInput({ pSpam: 0.5 })).action).toBe('captcha')
  })

  it('never captchas a discussion group with a prompt everyone would read', () => {
    expect(decideAction(makeInput({ pSpam: 0.5, chatKind: 'discussion' })).action).not.toBe('captcha')
  })

  it('does captcha a discussion group once the prompt can be whispered', () => {
    // Ephemeral delivery removes the whole objection: the comment thread never
    // sees the challenge, so the commenter is asked instead of just watched.
    const d = decideAction(makeInput({ pSpam: 0.5, chatKind: 'discussion', ephemeralCaptcha: true }))
    expect(d.action).toBe('captcha')
  })

  it('whispering does not conjure a captcha where the chat disabled it', () => {
    const d = decideAction(makeInput({
      pSpam: 0.5, chatKind: 'discussion', ephemeralCaptcha: true, captchaEnabled: false
    }))
    expect(d.action).toBe('observe')
  })

  it('never captchas established users', () => {
    expect(decideAction(makeInput({ pSpam: 0.5, userIsNewish: false })).action).toBe('observe')
  })

  it('deletes with a vote in the delete band', () => {
    const d = decideAction(makeInput({ pSpam: 0.7 }))
    expect(d.action).toBe('delete')
    expect(d.needsVote).toBe(true)
  })

  it('deletes without vote when voting is disabled', () => {
    const d = decideAction(makeInput({ pSpam: 0.7, votingEnabled: false }))
    expect(d.action).toBe('delete')
    expect(d.needsVote).toBe(false)
  })

  it('kicks a newcomer between the delete and mute bands', () => {
    const d = decideAction(makeInput({ pSpam: 0.8 }))
    expect(d.action).toBe('kick')
    expect(d.needsVote).toBe(true)
  })

  it('does not kick an account with local standing — deletes instead', () => {
    expect(decideAction(makeInput({ pSpam: 0.8, userIsNewish: false })).action).toBe('delete')
  })

  it('mutes in the mute band', () => {
    expect(decideAction(makeInput({ pSpam: 0.9 })).action).toBe('mute')
  })

  it('bans only newish users; mutes established ones at the same pSpam', () => {
    expect(decideAction(makeInput({ pSpam: 0.97 })).action).toBe('ban')
    expect(decideAction(makeInput({ pSpam: 0.97, userIsNewish: false })).action).toBe('mute')
  })
})

describe('decideAction — ban duration', () => {
  it('bans on our own score are timed, so a false positive heals itself', () => {
    const d = decideAction(makeInput({ pSpam: 0.97 }))
    expect(d.action).toBe('ban')
    expect(d.banDurationSeconds).toBe(TIMED_BAN_SECONDS)
  })

  it('bans on hard external grounds are permanent', () => {
    const d = decideAction(makeInput({ pSpam: 0.97, hasPermanentBanGrounds: true }))
    expect(d.action).toBe('ban')
    expect(d.banDurationSeconds).toBeNull()
  })

  it('the timed ban outlasts a campaign but expires within months', () => {
    const days = TIMED_BAN_SECONDS / 86_400
    expect(days).toBeGreaterThanOrEqual(7)
    expect(days).toBeLessThanOrEqual(90)
  })

  it('property: only a ban ever carries a duration', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const d = decideAction({ ...rest, pSpam })
      return d.action === 'ban' || d.banDurationSeconds === null
    }))
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
      expect(t.mute).toBeGreaterThan(t.kick)
      expect(t.kick).toBeGreaterThan(t.delete)
      expect(t.delete).toBeGreaterThan(t.grey)
    }
  })

  it('every preset threshold is a probability', () => {
    for (const t of Object.values(PRESET_THRESHOLDS)) {
      for (const value of Object.values(t)) {
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('property: strict is never gentler than standard, standard never gentler than soft', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const at = (preset: StrictnessPreset): number =>
        SEVERITY[decideAction({ ...rest, pSpam, preset }).action]
      return at('strict') >= at('standard') && at('standard') >= at('soft')
    }))
  })

  it('an unknown preset falls back to standard rather than clearing the message', () => {
    const rogue = decideAction(makeInput({ pSpam: 0.97, preset: 'nonsense' as StrictnessPreset }))
    expect(rogue).toEqual(decideAction(makeInput({ pSpam: 0.97, preset: 'standard' })))
  })
})

describe('decideAction — safety invariants', () => {
  it('trusted users are never auto-banned or muted (defensive cap)', () => {
    const d = decideAction(makeInput({ pSpam: 0.99, userIsTrusted: true }))
    expect(d.action).toBe('delete')
    expect(d.needsVote).toBe(true)
  })

  it('property: a trusted user is never punished beyond delete', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const d = decideAction({ ...rest, pSpam, userIsTrusted: true })
      return SEVERITY[d.action] <= SEVERITY['delete']
    }))
  })

  it('property: CLEAN local standing is never kicked or banned', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const d = decideAction({
        ...rest, pSpam, userIsNewish: false, userHasHardVerdict: false
      })
      return d.action !== 'ban' && d.action !== 'kick'
    }))
  })

  it('standing built out of spam does not shield the account from a ban', () => {
    // Production 2026-07-31: a known repeat offender was muted at pSpam 1.00,
    // twice inside half an hour, because `userIsNewish` had decayed to false —
    // the longer an account had been spamming, the milder its treatment. The
    // shield is for standing; a hard verdict is the absence of standing, which
    // is already why it cancels `established_user` and the regular exempt.
    const spammer = makeInput({ pSpam: 0.99, userIsNewish: false, userHasHardVerdict: true })
    expect(decideAction(spammer).action).toBe('ban')
    const clean = makeInput({ pSpam: 0.99, userIsNewish: false })
    expect(decideAction(clean).action).toBe('mute')
  })

  it('a hard verdict does not lower the bar, it only removes the shield', () => {
    // Below the ban threshold the verdict is unchanged: this is the mute/ban
    // choice for a message already judged removable, not a cheaper route to a
    // ban. A trusted user still outranks it.
    expect(decideAction(makeInput({ pSpam: 0.9, userHasHardVerdict: true })).action).toBe('mute')
    expect(
      decideAction(makeInput({ pSpam: 0.99, userHasHardVerdict: true, userIsTrusted: true })).action
    ).toBe('delete')
  })

  it('property: voting is only ever requested for delete or kick', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const d = decideAction({ ...rest, pSpam })
      return !d.needsVote || d.action === 'delete' || d.action === 'kick'
    }))
  })

  it('property: voting disabled means no vote is ever requested', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      return !decideAction({ ...rest, pSpam, votingEnabled: false }).needsVote
    }))
  })

  it('property: confident verdicts do not ask the chat (except the trusted cap)', () => {
    fc.assert(fc.property(pSpamArb, inputArb, (pSpam, rest) => {
      const d = decideAction({ ...rest, pSpam, userIsTrusted: false })
      const t = PRESET_THRESHOLDS[rest.preset]
      return !d.needsVote || pSpam < t.mute
    }))
  })

  it('property: action severity is monotonic in pSpam for any configuration', () => {
    fc.assert(fc.property(pSpamArb, pSpamArb, inputArb, (a, b, rest) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      const sLo = SEVERITY[decideAction({ ...rest, pSpam: lo }).action]
      const sHi = SEVERITY[decideAction({ ...rest, pSpam: hi }).action]
      return sHi >= sLo
    }))
  })

  it.each([
    ['NaN', Number.NaN], ['-Infinity', -Infinity], ['Infinity', Infinity],
    ['below range', -0.1], ['above range', 1.1], ['far above range', 5]
  ])('degenerate pSpam (%s) fails safe to observe, never to enforcement', (_label, pSpam) => {
    const d = decideAction(makeInput({ pSpam }))
    expect(d.action).toBe('observe')
    expect(d.needsVote).toBe(false)
    expect(d.banDurationSeconds).toBeNull()
  })

  it('property: any non-finite or out-of-range pSpam observes', () => {
    fc.assert(fc.property(fc.double(), inputArb, (pSpam, rest) => {
      const d = decideAction({ ...rest, pSpam })
      if (Number.isFinite(pSpam) && pSpam >= 0 && pSpam <= 1) return true
      return d.action === 'observe'
    }))
  })

  it('every action the policy can return is classified as enforcing or not', () => {
    // ENFORCEMENT_ACTIONS is consulted by the soft-shape guard, the executor
    // and the conversation-window bookkeeping. An action missing from it is
    // treated as harmless everywhere — silently, and only in production.
    const reachable = new Set<VerdictAction>()
    for (const preset of PRESETS) {
      for (const p of [0, 0.3, 0.5, 0.65, 0.8, 0.9, 0.99]) {
        for (const newish of [true, false]) {
          for (const trusted of [true, false]) {
            reachable.add(decideAction(makeInput({
              pSpam: p, preset, userIsNewish: newish, userIsTrusted: trusted
            })).action)
          }
        }
      }
    }
    const nonEnforcing: VerdictAction[] = ['none', 'observe', 'captcha']
    for (const action of reachable) {
      const classified = isEnforcementAction(action) || nonEnforcing.includes(action)
      expect(classified, `${action} is unclassified`).toBe(true)
    }
    // The ladder must actually be reachable, or this test proves nothing.
    expect([...reachable].sort()).toEqual(
      ['ban', 'captcha', 'delete', 'kick', 'mute', 'none', 'observe'])
  })

  it('boundaries: a threshold value itself triggers its action', () => {
    for (const preset of PRESETS) {
      const t = PRESET_THRESHOLDS[preset]
      const at = (pSpam: number): VerdictAction =>
        decideAction(makeInput({ pSpam, preset })).action
      expect(at(t.ban), `${preset} ban`).toBe('ban')
      expect(at(t.mute), `${preset} mute`).toBe('mute')
      expect(at(t.kick), `${preset} kick`).toBe('kick')
      expect(at(t.delete), `${preset} delete`).toBe('delete')
      // Just under the delete bar must not delete.
      expect(SEVERITY[at(t.delete - 1e-9)]).toBeLessThan(SEVERITY['delete'])
    }
  })
})

describe('countsAsDetection', () => {
  const verdict = (o: Partial<Parameters<typeof countsAsDetection>[0]> = {}) =>
    ({ action: 'ban' as VerdictAction, needsVote: false, reasonCode: 'job_scam', ...o })

  it('a firm removal is a fact about the account', () => {
    for (const action of ENFORCEMENT_ACTIONS) {
      expect(countsAsDetection(verdict({ action })), action).toBe(true)
    }
  })

  it('watching somebody is not catching them', () => {
    for (const action of ['none', 'observe', 'captcha'] as VerdictAction[]) {
      expect(countsAsDetection(verdict({ action })), action).toBe(false)
    }
  })

  it('a verdict the pipeline hedged on cannot harden into one it did not', () => {
    // `content_unconfirmed` IS the hedge: arithmetic wanted the sender gone and
    // the message evidence did not earn it. Two of those must not add up to the
    // certainty that strips the exempt and the ban shield.
    expect(countsAsDetection(verdict({ reasonCode: 'content_unconfirmed' }))).toBe(false)
  })

  it('a question still out for a vote is not an answer', () => {
    expect(countsAsDetection(verdict({ needsVote: true }))).toBe(false)
  })

  it('is strictly stricter than the message counter it travels with', () => {
    // The message counter debits standing on every enforcement; this one may
    // only ever be a subset, or the stricter bar is decorative.
    fc.assert(fc.property(
      fc.constantFrom<VerdictAction>('none', 'observe', 'captcha', 'delete', 'kick', 'mute', 'ban'),
      fc.boolean(),
      fc.constantFrom('job_scam', 'content_unconfirmed', 'soft_shape_only', 'known_spam_signature'),
      (action, needsVote, reasonCode) => {
        const v = { action, needsVote, reasonCode }
        if (countsAsDetection(v)) expect(isEnforcementAction(action)).toBe(true)
      }
    ))
  })
})

describe('countsAgainstSender', () => {
  it('a verdict nothing stopped is a fact about the sender', () => {
    expect(countsAgainstSender(null)).toBe(true)
  })

  it('a verdict WE declined to apply says nothing about them', () => {
    // The exemptions are our own policy: we looked at who sent it and decided
    // not to act. Recording a detection anyway let an admin accumulate 25 of
    // them (production, two days to 2026-08-22) while every verdict about them
    // was skipped by design — and for a chat-trusted member the same counter
    // quietly strips the standing the trust was granted to protect.
    for (const reason of ['senderIsAdmin', 'senderIsSelf', 'senderIsTrusted']) {
      expect(countsAgainstSender(reason), reason).toBe(false)
    }
  })

  it('takes no view on whether Telegram let us act', () => {
    // Deliberately not a parameter. A refused delete is a fact about our rights
    // in that chat, not about the person — and a chat where enforcement fails
    // is exactly where free standing piles up fastest.
    expect(countsAgainstSender(null)).toBe(true)
  })
})
