/**
 * Signal scoring: weighted logistic combination → calibrated pSpam (0..1).
 *
 * The weights, the correlation ceilings and the evidence/shape/trust split all
 * live in `signals/registry.ts` — declared once, on the signal. This module owns
 * only the arithmetic and the two guards built on top of it: what counts as
 * evidence at all, and how much evidence it takes to act on a person rather
 * than on a message.
 */
import type { Signal } from './types.js'
import {
  NOTHING_TO_READ_SIGNALS, PRIOR_MATCH_SIGNALS, PROFILE_EVIDENCE_SIGNALS, RESEMBLANCE_SIGNALS,
  SIGNAL_GROUP_CAPS, SOFT_SHAPE_SIGNALS, weightOf
} from './signals/registry.js'

/** z-offset so that a signal-less message scores ≈ 0.10 (ham prior). */
export const BASE_RATE_BIAS = -2.2

/**
 * Minimum weight for a single signal to count as evidence at all — one full
 * unit of log-odds.
 *
 * Provenance (2026-07-30 FP): the predicate below used to accept *any*
 * non-soft-shape signal, whatever its weight. So `edited_message` (0.2),
 * `unknown_media` (0.3) or `bot_mention` (0.5) — nudges, added precisely
 * because they are too weak to mean anything alone — silently switched off the
 * soft-shape guard, and a stack of sender-shape signals could then enforce
 * without any stage reading the message. A signal worth a fifth of a unit is
 * not grounds to delete someone's message; it is grounds to look closer.
 */
export const DECISIVE_MIN_WEIGHT = 1.0

/**
 * Minimum TOTAL message evidence before an action may remove the *sender*
 * (kick/mute/ban) rather than just the message.
 *
 * Deleting a message costs the chat one line; removing the person costs them
 * the chat. The 2026-07-30 kick rested on 1.2 units of "this account looks
 * odd" plus a crumb — no stage had established that anything was actually
 * advertised. Two units means roughly two independent facts about the message
 * itself (a phone number *and* a link), or one heavy one (three URL buttons).
 */
export const SENDER_REMOVAL_MIN_EVIDENCE = 2.0

/**
 * The two numbers answer two different questions, and a signal may count toward
 * one without counting toward the other.
 */
export interface ContentEvidence {
  /**
   * Heaviest single message-evidence signal — what licenses acting on the
   * MESSAGE. A resemblance counts here: looking like known spam is ample reason
   * to take a message down.
   */
  strongest: number
  /**
   * Summed FIRSTHAND message evidence — what licenses acting on the SENDER.
   * Resemblances are left out (see `SignalSpec.resemblance`): the bar wants
   * independent facts about the message, and a similarity is one claim of ours
   * about the text, not a second observation of it.
   */
  total: number
}

/**
 * How much of the score comes from WHAT was written rather than WHO wrote it.
 *
 * Exactly the `evidence` half of the catalogue counts: facts about the message,
 * plus the account flags Telegram itself raised. Sender *shape* does not, and
 * neither do trust signals — a ceiling on the evidence needed to punish must
 * never be reachable by *negative* weight. Which signals fall on which side is
 * the `kind` field in `signals/registry.ts`, and it is one field per signal
 * rather than a second list to keep in sync.
 *
 * Nor do matches against unconfirmed rules we wrote ourselves (`priorMatch`).
 * Those restate an earlier verdict instead of observing this message, and
 * letting a guess corroborate itself is how the pipeline came to enforce on a
 * text nothing had read that time — see the flag's own note.
 *
 * Resemblances (`resemblance`) are counted for `strongest` and withheld from
 * `total`: they are grounds to act on the message but not part of the case for
 * removing the person. The two fields exist precisely so that one signal can
 * license the lesser action and not the greater one.
 */
export const contentEvidence = (signals: Signal[]): ContentEvidence => {
  let strongest = 0
  let total = 0
  // The correlation ceilings apply here too, and for a stronger reason than in
  // the score. `SENDER_REMOVAL_MIN_EVIDENCE` is *defined* as roughly two
  // independent facts about the message; `SIGNAL_GROUP_CAPS` is where the
  // catalogue declares which signals are not independent. Summing group members
  // freely was a bar that stated a premise and then declined to read the one
  // declaration that could contradict it — the same divergence, in the same
  // shape, as the two writers of one hashed store found on 2026-08-02.
  const groupTotals = new Map<string, number>()
  for (const name of new Set(signals.map((s) => s.name))) {
    if (SOFT_SHAPE_SIGNALS.has(name) || PRIOR_MATCH_SIGNALS.has(name)) continue
    const weight = weightOf(name)
    // Sub-threshold nudges are excluded from the TOTAL as well, not just from
    // `strongest` (2026-07-30 production FP): a political comment was kicked on
    // moderation_flagged 1.5 + long_text 0.4 + edited_message 0.2 = 2.1, and the
    // chat voted it ham. Counting crumbs toward the bar for removing a person
    // is the same stacking fallacy the bar exists to stop — being long and
    // having been edited is not evidence of anything.
    if (weight < DECISIVE_MIN_WEIGHT) continue
    if (weight > strongest) strongest = weight
    // A resemblance stops here: decisive about the message, no part of the case
    // for removing the person. Production 2026-08-01 — an appeal for help
    // carrying a phone number was banned for thirty days on 1.2 + 1.0, a sum
    // that met the bar exactly and so kept the text away from the only stage
    // that could have read it.
    if (RESEMBLANCE_SIGNALS.has(name)) continue
    const group = SIGNAL_GROUP_CAPS.find((g) => g.members.has(name))
    if (group) groupTotals.set(group.name, (groupTotals.get(group.name) ?? 0) + weight)
    else total += weight
  }
  for (const group of SIGNAL_GROUP_CAPS) {
    const grouped = groupTotals.get(group.name)
    if (grouped !== undefined) total += Math.min(grouped, group.cap)
  }
  return { strongest, total }
}

/**
 * Whether the signals carry evidence that justifies enforcing *without reading
 * the message text*. A score driven purely by soft-shape signals — or by
 * sub-threshold nudges — is NOT decisive.
 */
export const hasDecisiveSignal = (signals: Signal[]): boolean =>
  contentEvidence(signals).strongest >= DECISIVE_MIN_WEIGHT

/**
 * Whether the evidence is substantial enough to act on the *sender*. The
 * pipeline uses this as a ceiling on score-derived verdicts: arithmetic over
 * signals may always delete, but it may only kick/mute/ban when the message
 * itself is what earned the score.
 */
export const mayRemoveSender = (signals: Signal[]): boolean =>
  contentEvidence(signals).total >= SENDER_REMOVAL_MIN_EVIDENCE

/**
 * Whether the chat's own history vouches for the sender — and what revokes that.
 *
 * `mayRemoveSender` answers a question about the MESSAGE, and answers it well:
 * two independent facts about the text are two facts however wrote it. But on a
 * reason code that names an act ordinary members also perform (see
 * `IMITABLE_REASON_CODES`), the evidence is not in dispute — a link IS a link —
 * and what remains in dispute is the person. Message evidence cannot settle
 * that, so on those codes it must not be the last word.
 *
 * Measured against every stored verdict, 2026-07-25 → 2026-08-08: of 141 sender
 * removals on an imitable code, 25 carried `established_user`, and this shield
 * changes the outcome of 4 of them — the rest sat below the evidence bar and the
 * ceiling already held them. One of the 4 is the confirmed false positive above;
 * the other 3 were uncontested mutes that become a delete plus a chat vote.
 *
 * The revoker, honestly: it has never yet changed an outcome. All 20 standing
 * carriers that also carried `prior_spam_detections` were below 2.0 anyway, so
 * the original ceiling got there first. It stays for what that 20-of-25 says
 * about the population — when a long-standing account IS punished on one of
 * these codes, four times in five the chat has already caught it spamming twice.
 * A shield over that population cannot be unconditional, and the first heavy
 * link from a repeat offender is the case it exists for. Standing is earned by
 * volume and spent by being caught: the same reasoning `extractUserSignals`
 * applies for a *hard* verdict (Telegram's scam/fake flags, an external ban),
 * extended to the softer verdict this chat produced about itself.
 */
export const hasSenderStanding = (signals: Signal[]): boolean => {
  const names = new Set(signals.map((s) => s.name))
  return names.has('established_user') && !names.has('prior_spam_detections')
}

export interface ScoreResult {
  pSpam: number
  /** Distinct signals with non-zero weight, sorted by |weight| desc. */
  topContributors: { name: string; weight: number }[]
  /** Groups whose ceiling actually bit, for calibration telemetry. */
  cappedGroups: string[]
  /**
   * Trust discounts withheld because the case rested on the profile rather than
   * on the message — see `hasProfileCharge`. Recorded so a verdict that turned
   * on this rule can be told apart from one that never had a discount to lose.
   */
  suspendedDiscounts: string[]
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

/**
 * Whether the profile carries a charge that a silent message cannot answer.
 *
 * The bar is `DECISIVE_MIN_WEIGHT`, deliberately reusing the pipeline's existing
 * definition of "evidence at all" rather than inventing a second one. That
 * choice decides the two production cases apart, which is the point:
 *
 *  - A bio holding a private invite (1.5) or an explicit avatar (1.0) clears it.
 *    Nothing about posting an emoji speaks to either, so the discount is void.
 *  - A merely suggestive avatar (0.8) or the bare fact of owning a channel (0.5)
 *    does not. Those are grounds to look closer, and the sender keeps the
 *    benefit of the doubt a short message buys — landing in the captcha band
 *    instead of the removal band, which is where "ask, do not act" belongs.
 */
const hasProfileCharge = (distinct: Set<string>): boolean => {
  for (const name of distinct) {
    if (!PROFILE_EVIDENCE_SIGNALS.has(name as never)) continue
    if (weightOf(name) >= DECISIVE_MIN_WEIGHT) return true
  }
  return false
}

export interface ScoreOptions {
  /**
   * Withhold "there was nothing to read" discounts when the case rests on the
   * profile — see `hasProfileCharge`.
   *
   * Opt-in per call site, and deliberately NOT the default. Measured against 14
   * days of production verdicts, applying it globally moved 16 of 43 affected
   * rows to `delete` or worse, and the texts were "Усьо", "?", "Привіт :)" and
   * "Фига, спасибки" — ordinary members whose profile happened to carry one
   * heavy signal. Removing the discount raises the score without adding any
   * evidence about the message, so on its own it converts silence into a
   * verdict. The only caller that may ask for it is therefore one that cannot
   * return an enforcing action at all (the low-information captcha branch),
   * where the answer to "we cannot read this" is a question, not a punishment.
   */
  suspendProfileAnsweringDiscounts?: boolean
}

export const scoreSignals = (signals: Signal[], options: ScoreOptions = {}): ScoreResult => {
  // Dedup: a fact is a fact — repeating it must not double its weight.
  const distinct = new Set(signals.map((s) => s.name))

  /**
   * A discount for "there was nothing to read" is suspended when the case
   * against the sender does not rest on what they wrote.
   *
   * This is not extra severity bolted on; it removes leniency that was being
   * applied to the wrong account. `emoji_only` states a fact about the message.
   * Set against `private_invite_in_bio`, it was answering a charge nobody made
   * — and answering it decisively, since -1.5 outweighs the +1.5 it cancelled.
   *
   * Suspended, not reversed: the signal keeps its weight everywhere else, and a
   * silent message from a sender whose profile says nothing is still treated
   * exactly as gently as before. Measured on 14 days of production verdicts,
   * this changes the recorded action for a small, specific population — see the
   * impact table in the 2026-08-25 commit.
   */
  const profileCharged = options.suspendProfileAnsweringDiscounts === true &&
    hasProfileCharge(distinct)

  const contributors: { name: string; weight: number }[] = []
  const groupTotals = new Map<string, number>()
  /** Discounts withheld because the charge was about the profile, for telemetry. */
  const suspended: string[] = []
  let z = BASE_RATE_BIAS

  for (const name of distinct) {
    const weight = weightOf(name)
    if (weight === 0) continue
    if (profileCharged && NOTHING_TO_READ_SIGNALS.has(name as never)) {
      suspended.push(name)
      continue
    }
    contributors.push({ name, weight })

    // Trust signals are never capped: a ceiling on them could only ever make
    // the pipeline harsher, which is the wrong direction to fail in.
    const group = weight > 0
      ? SIGNAL_GROUP_CAPS.find((g) => g.members.has(name))
      : undefined
    if (group) {
      groupTotals.set(group.name, (groupTotals.get(group.name) ?? 0) + weight)
    } else {
      z += weight
    }
  }

  const cappedGroups: string[] = []
  for (const group of SIGNAL_GROUP_CAPS) {
    const total = groupTotals.get(group.name)
    if (total === undefined) continue
    z += Math.min(total, group.cap)
    if (total > group.cap) cappedGroups.push(group.name)
  }

  contributors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))

  return { pSpam: sigmoid(z), topContributors: contributors, cappedGroups, suspendedDiscounts: suspended }
}
