/**
 * Invariants over the signal catalogue.
 *
 * This file used to scrape the source directory with regexes, because the
 * vocabulary had no single declaration: it checked that every `{ name: 'x' }`
 * in production code had a weight, and that every weight had a producer. The
 * first half is now the type system's job — `Signal.name` is `SignalName`, so an
 * unweighted signal cannot be written down. What no type can decide is left, and
 * it is the part that actually encodes policy:
 *
 *  - Does every catalogued signal still have somewhere that raises it? A weight
 *    nothing can produce is dead calibration surface, and it reads as coverage
 *    the pipeline does not have.
 *  - Do the roles agree with the weights, and with each other?
 *  - Are the two guards — enforce at all, remove the person — still reachable in
 *    the ways the incidents behind them require?
 *
 * The scrape survives for the producer check alone, and only that check depends
 * on it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  hasDecisiveSignal, mayRemoveSender, DECISIVE_MIN_WEIGHT, SENDER_REMOVAL_MIN_EVIDENCE
} from './score.js'
import {
  SIGNALS, SIGNAL_NAMES, SIGNAL_GROUPS, SIGNAL_GROUP_CAPS, SIGNAL_WEIGHTS,
  SOFT_SHAPE_SIGNALS, PRIOR_MATCH_SIGNALS, RESEMBLANCE_SIGNALS,
  PROMO_SIGNALS, HIGH_RISK_SIGNALS, PERMANENT_BAN_SIGNALS,
  OVERRIDES_CHAT_TRUST_SIGNALS, isTrustSignal, weightOf, type SignalName
} from './signals/registry.js'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

const sourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** Names a production module can actually push into a signal list. */
const producedSignals = (): Set<string> => {
  const found = new Set<string>()
  for (const path of sourceFiles(SRC_DIR)) {
    // The catalogue itself declares every name; it produces none of them.
    if (path.endsWith(join('signals', 'registry.ts'))) continue
    for (const [, name] of readFileSync(path, 'utf8').matchAll(/name: '([a-z_0-9]+)'/g)) {
      if (name) found.add(name)
    }
  }
  return found
}

describe('signal catalogue', () => {
  it('every catalogued signal has something that raises it', () => {
    const produced = producedSignals()
    const dead = SIGNAL_NAMES.filter((name) => !produced.has(name))

    expect(dead, 'weights nothing can ever raise — dead calibration surface').toEqual([])
  })

  it('no signal weighs zero', () => {
    // A zero-weight signal is a stage we ran, and possibly paid for, whose
    // answer is then discarded — while the guards below still count it. That is
    // the 2026-07-27 failure, and it was worse than not having the signal.
    expect(SIGNAL_NAMES.filter((n) => SIGNAL_WEIGHTS[n] === 0)).toEqual([])
  })

  it('kind and sign of the weight agree', () => {
    for (const name of SIGNAL_NAMES) {
      const { weight, kind } = SIGNALS[name]
      if (kind === 'trust') expect(weight, `${name} exonerates`).toBeLessThan(0)
      else expect(weight, `${name} accuses`).toBeGreaterThan(0)
    }
  })

  it('an unknown name weighs nothing and is treated as accusing', () => {
    // Reachable in production: a verdict rebuilt from a stored decision can name
    // a signal the catalogue has since dropped. It must not score, must not
    // crash, and must not be mistaken for a reason to trust the sender.
    expect(weightOf('signal_from_a_previous_release')).toBe(0)
    expect(isTrustSignal('signal_from_a_previous_release')).toBe(false)
  })

  // ── roles ───────────────────────────────────────────────────────────

  it('promo and high-risk roles belong to message evidence, never to sender shape', () => {
    // Both feed the deterministic promo rules, which assert something was
    // ADVERTISED. A signal describing who sent it can never carry that claim —
    // that conflation is what the soft-shape guard exists to prevent.
    for (const name of [...PROMO_SIGNALS, ...HIGH_RISK_SIGNALS]) {
      expect(SIGNALS[name].kind, `${name} is promo/high-risk`).toBe('evidence')
    }
  })

  it('only the platform can ground a ban that never expires', () => {
    // A community ban database overrides chat trust but must not make a ban
    // permanent: `external_ban_new` is the one rule that enforces with zero
    // content evidence, and the databases' own documented failure mode is the
    // rehabilitated account — an error only time can correct.
    expect([...PERMANENT_BAN_SIGNALS].sort())
      .toEqual(['fake_flag', 'restricted_for_spam', 'scam_flag'])
    expect(PERMANENT_BAN_SIGNALS.has('external_ban')).toBe(false)
    expect(OVERRIDES_CHAT_TRUST_SIGNALS.has('external_ban')).toBe(true)
  })

  it('everything that can override chat trust accuses rather than exonerates', () => {
    expect(OVERRIDES_CHAT_TRUST_SIGNALS.size).toBeGreaterThan(PERMANENT_BAN_SIGNALS.size)
    for (const name of OVERRIDES_CHAT_TRUST_SIGNALS) {
      expect(isTrustSignal(name), `${name} would action a member on a trust signal`).toBe(false)
    }
  })

  it('every group has members and no signal is capped twice', () => {
    const seen = new Set<SignalName>()
    for (const group of SIGNAL_GROUP_CAPS) {
      expect(group.members.size, `group ${group.name} is empty`).toBeGreaterThan(0)
      for (const member of group.members) {
        expect(seen.has(member), `${member} is in two groups`).toBe(false)
        seen.add(member)
      }
    }
    expect(SIGNAL_GROUP_CAPS.map((g) => g.name).sort())
      .toEqual(Object.keys(SIGNAL_GROUPS).sort())
  })

  it('a ceiling clamps a stack, never a lone member', () => {
    // A cap below its own heaviest member would silently discount a single
    // signal — the opposite of what the group mechanism is for.
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const member of group.members) {
        expect(SIGNAL_WEIGHTS[member], `${member} exceeds group ${group.name}`)
          .toBeLessThanOrEqual(group.cap)
      }
    }
  })

  it('groups only ever contain accusing signals', () => {
    // Capping a trust signal could only make the pipeline harsher, which is the
    // wrong direction to fail in.
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const member of group.members) {
        expect(isTrustSignal(member), `${member} is capped trust`).toBe(false)
      }
    }
  })

  // ── the two guards ──────────────────────────────────────────────────

  it('soft-shape signals alone are never decisive', () => {
    const all = [...SOFT_SHAPE_SIGNALS].map((name) => ({ name }))
    expect(hasDecisiveSignal(all)).toBe(false)
  })

  /** Message-evidence signals too light to license enforcement on their own. */
  const NUDGES: SignalName[] = [
    'bot_mention', 'custom_emoji_heavy', 'edited_message', 'external_url',
    'foreign_script', 'guest_bot_delivery', 'long_text', 'restricted_flag',
    'story_share', 'unknown_media'
  ]

  it('the list of sub-threshold nudges is exactly the one we intend', () => {
    // Listed by hand so that adding a light signal is a decision rather than an
    // accident: a new signal under DECISIVE_MIN_WEIGHT silently changes whether
    // a soft-shape stack may enforce, which is how the 2026-07-30 kick happened
    // (`edited_message`, weight 0.2, counted as proof about the message).
    const belowBar = SIGNAL_NAMES
      .filter((n) => SIGNALS[n].kind === 'evidence' && SIGNAL_WEIGHTS[n] < DECISIVE_MIN_WEIGHT)
      .sort()
    expect(belowBar).toEqual([...NUDGES].sort())
  })

  it('every message-evidence signal at or above the bar is decisive on its own', () => {
    // Except a match against an unconfirmed rule of our own writing: heavy
    // enough to clear the bar, but it recalls a verdict rather than observing
    // this message. See `SignalSpec.priorMatch` (2026-08-01).
    const decisive = SIGNAL_NAMES.filter((n) =>
      SIGNALS[n].kind === 'evidence' && !PRIOR_MATCH_SIGNALS.has(n) &&
      SIGNAL_WEIGHTS[n] >= DECISIVE_MIN_WEIGHT)
    expect(decisive.length).toBeGreaterThan(0)
    for (const name of decisive) {
      expect(hasDecisiveSignal([{ name }]), `${name} should be decisive`).toBe(true)
    }
  })

  it('no nudge can enforce, alone or piled on sender shape', () => {
    const shape = [...SOFT_SHAPE_SIGNALS].map((name) => ({ name }))
    for (const name of NUDGES) {
      expect(hasDecisiveSignal([{ name }]), name).toBe(false)
      expect(hasDecisiveSignal([...shape, { name }]), `${name} + shape`).toBe(false)
    }
  })

  it('a resemblance clears the lower bar and can never clear the higher one', () => {
    // The whole point of the flag is that it sits BETWEEN the other two roles:
    // unlike a soft-shape signal it may condemn the message, unlike a priorMatch
    // it keeps that power — and unlike either of them it must never help remove
    // a person, however heavy it grows. The two flags are mutually exclusive:
    // a signal is either not evidence about the message at all, or it is
    // evidence that stops short of the sender.
    expect(RESEMBLANCE_SIGNALS.size).toBeGreaterThan(0)
    for (const name of RESEMBLANCE_SIGNALS) {
      expect(SIGNALS[name].kind, `${name} is a resemblance`).toBe('evidence')
      expect(PRIOR_MATCH_SIGNALS.has(name), `${name} is both flags at once`).toBe(false)
      expect(hasDecisiveSignal([{ name }]), `${name} lost the lower bar`).toBe(true)
      expect(mayRemoveSender([{ name }]), `${name} removed the sender alone`).toBe(false)
    }
    // Nor by piling them up, nor by topping up one real observation.
    const all = [...RESEMBLANCE_SIGNALS].map((name) => ({ name }))
    expect(mayRemoveSender(all)).toBe(false)
    expect(mayRemoveSender([...all, { name: 'phone_number' as SignalName }])).toBe(false)
  })

  it('trust signals never count as decisive evidence', () => {
    for (const name of SIGNAL_NAMES.filter(isTrustSignal)) {
      expect(hasDecisiveSignal([{ name }]), name).toBe(false)
    }
  })

  /**
   * Signals heavy enough to remove the *person* on their own. Four are somebody
   * else's verdict on the account; three are structural evasion that has no
   * innocent reading. Pinned by hand because "this one signal is enough to take
   * the chat away from you" is the heaviest claim in the catalogue, and the
   * 2026-07-30 kick happened by a weight crossing a bar nobody was watching.
   */
  const REMOVES_SENDER_ALONE: SignalName[] = [
    'scam_flag', 'fake_flag', 'unofficial_client_risk', 'edit_injected_promo',
    'many_url_buttons', 'hidden_url', 'invisible_in_word'
  ]

  it('the signals that alone justify removing the sender are exactly the intended ones', () => {
    const alone = SIGNAL_NAMES
      .filter((n) => mayRemoveSender([{ name: n }]))
      .sort()
    expect(alone).toEqual([...REMOVES_SENDER_ALONE].sort())
  })

  it('no sender-shape signal can remove the sender, however heavy', () => {
    // `external_ban` weighs 2.5 — above the bar on paper. It must still fail,
    // because shape is not evidence about the message: on 2026-07-31 the scoring
    // path treated a ban-database listing as proof and deleted an ordinary
    // question three times in ten minutes.
    for (const name of SOFT_SHAPE_SIGNALS) {
      expect(mayRemoveSender([{ name }]), `${name} removed the sender alone`).toBe(false)
    }
    expect(SIGNAL_WEIGHTS['external_ban']).toBeGreaterThan(SENDER_REMOVAL_MIN_EVIDENCE)
  })
})
