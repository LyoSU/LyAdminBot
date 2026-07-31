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
import { SIGNAL_GROUP_CAPS, SOFT_SHAPE_SIGNALS, weightOf } from './signals/registry.js'

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

export interface ContentEvidence {
  /** Heaviest single message-evidence signal. */
  strongest: number
  /** Summed weight of all message-evidence signals (deduplicated). */
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
 */
export const contentEvidence = (signals: Signal[]): ContentEvidence => {
  let strongest = 0
  let total = 0
  for (const name of new Set(signals.map((s) => s.name))) {
    if (SOFT_SHAPE_SIGNALS.has(name)) continue
    const weight = weightOf(name)
    // Sub-threshold nudges are excluded from the TOTAL as well, not just from
    // `strongest` (2026-07-30 production FP): a political comment was kicked on
    // moderation_flagged 1.5 + long_text 0.4 + edited_message 0.2 = 2.1, and the
    // chat voted it ham. Counting crumbs toward the bar for removing a person
    // is the same stacking fallacy the bar exists to stop — being long and
    // having been edited is not evidence of anything.
    if (weight < DECISIVE_MIN_WEIGHT) continue
    total += weight
    if (weight > strongest) strongest = weight
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

export interface ScoreResult {
  pSpam: number
  /** Distinct signals with non-zero weight, sorted by |weight| desc. */
  topContributors: { name: string; weight: number }[]
  /** Groups whose ceiling actually bit, for calibration telemetry. */
  cappedGroups: string[]
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

export const scoreSignals = (signals: Signal[]): ScoreResult => {
  // Dedup: a fact is a fact — repeating it must not double its weight.
  const distinct = new Set(signals.map((s) => s.name))

  const contributors: { name: string; weight: number }[] = []
  const groupTotals = new Map<string, number>()
  let z = BASE_RATE_BIAS

  for (const name of distinct) {
    const weight = weightOf(name)
    if (weight === 0) continue
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

  return { pSpam: sigmoid(z), topContributors: contributors, cappedGroups }
}
