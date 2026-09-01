/**
 * Pipeline orchestrator. Stage order is a cost/precision ladder: free gates
 * first, paid knowledge ports next, the LLM last and only for the grey zone.
 *
 *   1. enabled gate, custom chat rules (ALLOW/DENY)
 *   2. signal extraction (message + user + chat-trust injection)
 *   3. deterministic rules — measured-precision combos, no IO
 *   4. abstain gate + session window for low-information newcomers
 *   5. knowledge ports: signatures → velocity → vectors → moderation
 *   6. weighted score; LLM escalation (cheap → strong) for the grey zone
 *   7. policy maps the final pSpam to an action
 *
 * Failure semantics: any port error degrades the stage to "no answer" and
 * is counted in meta.portErrors. A needed-but-unavailable LLM can only make
 * the outcome MORE cautious (observe), never clean.
 */
import type { EvaluationInput, Signal, Verdict, VerdictAction, DecidedBy } from './types.js'
import type { BurstEntry, LlmVerdict, MessageObservations, PipelinePorts } from './ports.js'
import { extractMessageSignals } from './signals/message.js'
import {
  extractUserSignals, tenureDays, hasHardAccountVerdict,
  ESTABLISHED_MIN_MESSAGES, ESTABLISHED_MIN_IN_CHAT, ESTABLISHED_MIN_TENURE_DAYS
} from './signals/user.js'
import { profileHasCase } from './signals/account-verdict.js'
import { extractBioSignals } from './signals/bio.js'
import { extractLinkedChannelSignals } from './signals/channel.js'
import { applyDeterministicRules } from './rules.js'
import { parseCustomRule, customRuleMatches } from './custom-rules.js'
import {
  scoreSignals, hasDecisiveSignal, mayRemoveSender, hasSenderStanding, isInExchange,
  isStrangerHere, contentEvidence
} from './score.js'
import {
  PERMANENT_BAN_SIGNALS, PROFILE_EVIDENCE_SIGNALS, isTrustSignal
} from './signals/registry.js'
import {
  decideAction, isEnforcementAction, removesSender, mayAskCaptcha, isChannelSenderId,
  IMITABLE_REASON_CODES,
  type PolicyDecision, type PolicyInput
} from './policy.js'
import { burstBlob, burstSignals } from './signals/burst.js'
import { shouldAbstain } from './text/abstain.js'
import { truncate } from './text/normalize.js'
import { isForeignScript } from './text/script.js'
import { isDistinctive } from './learning.js'

/**
 * Grey band: below the floor arithmetic decides alone, above the ceiling it may
 * decide alone only on evidence it earned.
 *
 * The floor is exported because it is also the answer to "did the pipeline think
 * this was clean" — `BURST_GREY_FLOOR` mirrors it for the burst window and the
 * app layer's retro-purge, and a test pins the two together.
 */
export const LLM_GREY_LOW = 0.35
const LLM_GREY_HIGH = 0.75
const SESSION_EVAL_MIN_MESSAGES = 5
/**
 * Up to this many messages into a chat, a sender's unreadable message is worth
 * a classification ON ITS OWN rather than waiting for a pile.
 *
 * A pile of five is useless against join-post-once-gone, and the window is
 * thirty minutes of a single process — a lurker dropping one line an hour never
 * fills it. The risk is concentrated in the opening messages and that
 * population is bounded by the join rate, so those are read one at a time.
 * Three is the bar `isNewish` already uses for "no standing here yet".
 */
const SESSION_SOLO_MAX_INCHAT = 3
const VECTOR_DECIDE_SIMILARITY = 0.93
/**
 * Below this, a nearest-neighbour hit is noise and must not raise a signal.
 * The port answers with whatever is closest, so without a floor every message
 * carried `vector_similar_spam` — which (once the signal finally got a weight)
 * would have added score to everything equally.
 */
const VECTOR_SIGNAL_SIMILARITY = 0.85
const CUSTOM_DENY_PSPAM = 0.96

/**
 * Profile-media NSFW gate. The provider's aggregate `flagged` boolean is
 * recall-tuned and spans violence/self-harm/graphic categories, so stylised
 * art — an anime avatar with a weapon or a splash of red — tripped it and,
 * stacked with ordinary newcomer signals, produced permanent bans on first
 * messages (2026-07-27 report).
 *
 * For a profile picture only one question matters: is this pornography? So we
 * read the sexual categories' own confidence and require the provider to be
 * clearly sure, rather than trusting a flag tuned to catch everything.
 */
const NSFW_PROFILE_CATEGORIES = ['sexual', 'sexual/minors']
const NSFW_PROFILE_MIN_SCORE = 0.8

/**
 * Where "suggestive" starts — the tier below explicit.
 *
 * Measured, not chosen: 2026-08-24, the avatar of a production escort-promo
 * account scored `sexual` 0.373 (`flagged: false`), so the 0.8 bar — which asks
 * "is this pornography" — said no about an account that was plainly one. An
 * ordinary photograph, a news picture and a shopfront all score 0.00-0.02 on
 * this category, so the gap between them and 0.35 is wide.
 *
 * What the tier may do is bounded by what it is: honest people put suggestive
 * pictures on their profiles, so this may weigh and it may ask a question. It
 * may never convict — see `suggestive_profile_media`.
 */
const NSFW_SUGGESTIVE_MIN_SCORE = 0.35

/**
 * Sexual-category confidence above the profile threshold, if any.
 *
 * Exported so the join-time avatar screen asks the same question. It was
 * logging on the raw `flagged` boolean, and on 2026-08-01 announced an
 * `nsfw_avatar_join` for a picture whose sexual score was 0.003 — `violence`
 * had fired. Harmless in that it only logs, except that a log an admin cannot
 * believe is worse than no log, and this is a chat network where photographs of
 * a war are ordinary.
 */
export const nsfwProfileHit = (result: { scores: Record<string, number> } | null): string | null => {
  if (!result) return null
  for (const category of NSFW_PROFILE_CATEGORIES) {
    const score = result.scores[category]
    if (typeof score === 'number' && score >= NSFW_PROFILE_MIN_SCORE) {
      return `${category} ${score.toFixed(2)}`
    }
  }
  return null
}

/**
 * Suggestive but not explicit — the evidence line, or null when the score is
 * outside the band.
 *
 * Raised only when nothing crossed the explicit bar, so the two tiers never
 * charge for the same picture twice. Shared with the account screen so both
 * readers of a profile picture answer to one pair of thresholds.
 */
export const suggestiveProfileEvidence = (topSexual: number): string | null =>
  topSexual >= NSFW_SUGGESTIVE_MIN_SCORE && topSexual < NSFW_PROFILE_MIN_SCORE
    ? `profile media, sexual ${topSexual.toFixed(2)}`
    : null

/**
 * The sexual-category confidence, whatever it is. Null when nothing answered.
 *
 * Exported for the same reason `nsfwProfileHit` is: the join/report screen in
 * the app layer asks about the same picture and must not invent a second bar.
 * Until 2026-08-26 it read only the explicit one, so an account the message
 * path had just described as `suggestive_profile_media` came back from a
 * reported-account screen as `clean` thirty-one seconds later, with the screen
 * unable to record even that it had looked at the band.
 */
export const sexualScore = (result: { scores: Record<string, number> } | null): number | null => {
  if (!result) return null
  let top = 0
  for (const category of NSFW_PROFILE_CATEGORIES) {
    const score = result.scores[category]
    if (typeof score === 'number' && score > top) top = score
  }
  return top
}

/**
 * Message-content moderation categories that bear on SPAM.
 *
 * The same recall-tuned `flagged` boolean that produced the avatar bans was
 * still trusted wholesale for message text, and on 2026-07-30 it kicked someone
 * mid-conversation for discussing a rocket strike: `violence` fired, the signal
 * counted as content evidence, and the chat voted the verdict ham within ten
 * minutes.
 *
 * Violence, hate and self-harm in a message are a matter for admins and their
 * chat rules — they are not evidence that a message is an advertisement, which
 * is the only question this pipeline is entitled to answer. What IS spam-shaped
 * is unsolicited sexual content, the adult-promo class.
 */
const SPAM_MODERATION_CATEGORIES = ['sexual', 'sexual/minors']
/**
 * Lower than the profile bar (0.8): here the provider is judging text the
 * sender actually wrote, not a stylised picture, and the signal only ever
 * contributes weight — it cannot convict on its own.
 */
const SPAM_MODERATION_MIN_SCORE = 0.5

/** Spam-relevant moderation categories the provider is reasonably sure about. */
const spamModerationHit = (
  result: { flagged: boolean; categories: string[]; scores: Record<string, number> } | null
): string | null => {
  if (!result) return null
  const hits = SPAM_MODERATION_CATEGORIES
    .filter((c) => (result.scores[c] ?? 0) >= SPAM_MODERATION_MIN_SCORE)
    .map((c) => `${c} ${(result.scores[c] ?? 0).toFixed(2)}`)
  if (hits.length > 0) return hits.join(', ')
  // No scores at all (a provider that exposes only the boolean): fall back to
  // its own category list, still restricted to the spam-relevant ones.
  if (Object.keys(result.scores).length === 0 && result.flagged) {
    const named = result.categories.filter((c) => SPAM_MODERATION_CATEGORIES.includes(c))
    return named.length > 0 ? named.join(', ') : null
  }
  return null
}

/**
 * How new does a user have to be for ban-eligibility / captcha gating.
 *
 * The tenure term reads `tenureDays`, not our own first-seen date. Production
 * shape of the 2026-08-20 report: a member of two years whose row we had just
 * recreated counted as newish on that term alone, which is what strips the ban
 * shield in `decideAction` — so a verdict that should have been a reversible
 * mute became a 30-day ban with no vote. Losing our record of somebody is not
 * an observation about them.
 */
const isNewish = (input: EvaluationInput): boolean => {
  const tenure = tenureDays(input.user)
  // Each term guarded on its own, and for the reason the doc above gives: this
  // predicate strips the ban shield, so a counter we failed to read must not be
  // allowed to answer it. An unknown number is not a small one.
  return (input.user.messagesInChat !== null && input.user.messagesInChat <= 3) ||
    (input.user.messagesGlobal !== null && input.user.messagesGlobal <= 5) ||
    (tenure !== null && tenure <= ESTABLISHED_MIN_TENURE_DAYS)
}

const isTrusted = (input: EvaluationInput): boolean =>
  input.policy.trustedUserIds.includes(input.user.id) ||
  input.user.reputationStatus === 'trusted'

/**
 * Established-regular fast path. Posting enough — either in THIS chat or across
 * the bot's whole network — earns a clean pass without running any heuristic or
 * knowledge port: a regular's link should never be deleted on a signature/
 * vector/velocity match the way a newcomer's would.
 *
 * The OR is deliberate: a member with local standing here OR a long history
 * across our chats both count.
 *
 * Standing also has to have taken TIME (2026-07-30 review). The counters are
 * incremented on every message in every chat the bot watches, with no rate or
 * quality condition, so 50 messages of "ок" in a group the spammer controls
 * bought a total bypass of the pipeline — before any port, in all 52 chats. A
 * regular is someone who has been around, not someone who typed a lot this
 * afternoon; `tenureDays` is the cheapest honest reading we have, and it is
 * already computed for every sender.
 *
 * Every threshold here is `extractUserSignals`' own (2026-08-20). They used to
 * be declared twice, and the copies disagreed on the half that matters: this
 * one accepted local standing, `established_user` did not, and this one stands
 * down for exactly the messages where the difference decides something.
 */
const isEstablishedRegular = (input: EvaluationInput): boolean => {
  // The other direction of the same rule: an unreadable counter buys no bypass
  // either. Abstain means abstain — an outage that waved every sender past the
  // whole pipeline would be the same defect wearing the more expensive coat.
  const volume =
    (input.user.messagesInChat !== null && input.user.messagesInChat >= ESTABLISHED_MIN_IN_CHAT) ||
    (input.user.messagesGlobal !== null && input.user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES)
  // Neither clock saying anything is not evidence of tenure.
  const tenure = tenureDays(input.user)
  const tenured = tenure !== null && tenure >= ESTABLISHED_MIN_TENURE_DAYS
  return volume && tenured &&
    !hasHardAccountVerdict(input.user) &&
    /**
     * One clause this bypass needs that the standing veto does not.
     *
     * `unofficialClientRisk` is deliberately absent from `hasHardAccountVerdict`
     * — it describes the sender's software, not a verdict on the sender — and
     * the right place for a heuristic is the score, where it weighs 3.2 and can
     * be outweighed. But this path returns BEFORE any signal is extracted, so
     * out here "leave it to the score" resolves to leaving it nowhere: a
     * long-standing account flagged by Telegram's own infrastructure would take
     * the fast path and be waved through unread. That inverts the flag's purpose,
     * because the account it warns about most usefully is exactly the settled one
     * that has changed hands.
     *
     * A discount can be argued with; a bypass cannot. So the bypass asks for one
     * thing more, and says so here rather than growing a second private list.
     */
    input.user.unofficialClientRisk !== true
}

interface VerdictDraft {
  pSpam: number
  decidedBy: DecidedBy
  ruleId: string | null
  reasonCode: string
  reasonEvidence: string | null
}

export const evaluateMessage = async (
  received: EvaluationInput,
  ports: PipelinePorts
): Promise<Verdict> => {
  /**
   * A chat that switched the ban databases off does not see their answers —
   * settled here, once, by removing the fact rather than by asking each reader
   * to remember the setting.
   *
   * Three stages read `externalBan`: the `external_ban` signal at weight 2.5,
   * the `external_ban_new` rule, and the veto on standing. Exactly one of them
   * used to consult `externalBanEnabled`, so in a chat with the setting off the
   * listing still added its weight and still denied the sender standing — the
   * switch stopped new lookups and let every cached answer through. A setting
   * that is honoured by two readers out of three is not a setting.
   *
   * Deleting the field is what makes the guarantee structural: there is no
   * longer a way for a stage downstream to disagree, because there is nothing
   * left for it to read.
   */
  const input: EvaluationInput = received.policy.externalBanEnabled
    ? received
    : { ...received, user: { ...received.user, externalBan: null } }

  const meta: Record<string, string | number | boolean> = {}
  let portErrors = 0

  /**
   * Which paid stages actually ran, and how long each took. A single pipeline
   * total answers neither question: an eleven-second verdict could have been
   * the strong model, a stalled vector search or an avatar download, and the
   * log line said only `latencyMs: 11395` (2026-07-31). Nor could you tell
   * from a log line whether the vector and moderation ports had been consulted
   * at all, which is what decides whether their silence means anything.
   */
  const portMs: string[] = []

  /** Run a port call; failures degrade to null and are counted. */
  const safe = async <T>(label: string, call: () => Promise<T | null>): Promise<T | null> => {
    const startedAt = Date.now()
    try {
      return await call()
    } catch {
      portErrors += 1
      meta[`portError_${label}`] = true
      return null
    } finally {
      portMs.push(`${label}=${Date.now() - startedAt}`)
    }
  }

  /**
   * What the policy would do with this probability. Exposed separately from
   * `finalize` because the LLM gate has to know the *prospective* action before
   * deciding whether the message may be judged on arithmetic alone.
   */
  const policyInputFor = (pSpam: number, signals: Signal[]): PolicyInput => ({
    pSpam,
    preset: input.policy.preset,
    chatKind: input.chat.kind,
    captchaEnabled: input.policy.captchaEnabled,
    votingEnabled: input.policy.votingEnabled,
    userIsNewish: isNewish(input),
    userIsTrusted: isTrusted(input),
    userHasHardVerdict: hasHardAccountVerdict(input.user),
    ephemeralCaptcha: input.policy.ephemeralCaptcha === true,
    senderIsParticipant: input.user.isParticipant ?? null,
    // A channel identity cannot answer a captcha: the button carries the
    // sender id and a tap carries the tapper's USER id, so the two can never
    // match. And `mute` on a channel is a BAN by construction, so the
    // unanswerable question closed with an hour-long ban of a posting identity.
    senderIsChannel: isChannelSenderId(input.user.id),
    // Grounds for a PERMANENT ban rather than a timed one: the account is
    // known-bad by someone else's verdict, not merely scored badly by us.
    // Everything else expires, so a mistake on our side heals without an
    // admin having to notice it.
    hasPermanentBanGrounds: signals.some((s) => PERMANENT_BAN_SIGNALS.has(s.name))
  })

  const policyFor = (pSpam: number, signals: Signal[]): PolicyDecision =>
    decideAction(policyInputFor(pSpam, signals))

  const finalize = (draft: VerdictDraft, signals: Signal[], decision?: PolicyDecision): Verdict => {
    const policyDecision = decision ?? policyFor(draft.pSpam, signals)
    meta['portErrors'] = portErrors
    if (portMs.length > 0) meta['portMs'] = portMs.join(',')
    /**
     * How much of the case the MESSAGE carried — recorded here, with the other
     * two facts every verdict owes its reader, and for the same reason.
     *
     * It used to be written at stage 6, next to the score that consumes it, and
     * so it existed only on verdicts that reached stage 6. Production
     * 2026-08-27: 184 of about 400 punitive decisions that day recorded no
     * figure, because a deterministic rule, a signature match, a forward-list
     * hit and the join screen all conclude earlier. The number the log line
     * calls the one that diagnoses a surprising action was absent from nearly
     * half the actions worth being surprised by.
     *
     * Every verdict in this file is built by this function, `none` included, so
     * a stage added later cannot quietly stop answering.
     */
    meta['contentEvidence'] = contentEvidence(signals).total
    return {
      pSpam: draft.pSpam,
      action: policyDecision.action,
      needsVote: policyDecision.needsVote,
      banDurationSeconds: policyDecision.banDurationSeconds,
      decidedBy: draft.decidedBy,
      ruleId: draft.ruleId,
      signals,
      reasonCode: draft.reasonCode,
      reasonEvidence: draft.reasonEvidence,
      meta
    }
  }

  /**
   * Trade a removal the message evidence does not support for the message-only
   * action, and ask the chat instead.
   *
   * Removing a person is not a fail-safe default. The message still goes, the
   * sender is asked to prove they are human — a bot cannot, the person we were
   * wrong about taps once — and the chat gets a vote. Pointless for a
   * long-standing member, so the captcha is gated on the same newness the
   * removal itself required.
   */
  const capUnearnedRemoval = (verdict: Verdict): Verdict => {
    meta['cappedFrom'] = verdict.action
    /**
     * And when the message was an ANSWER to somebody, do not spend the message
     * either. 2026-08-27, an experiment.
     *
     * This ceiling already concedes that the evidence did not reach the bar for
     * taking the person away. On a reply it did not reach the bar for taking
     * the message away either, and deleting is the one act a correction cannot
     * undo. The fortnight to 2026-08-27 splits this bucket almost perfectly:
     * of 73 deletions it produced, the 4 that were replies were reversed 3
     * times — 75%, and 3 of 3 where the reply was also recent — against 2 of
     * the other 69, at 2.9%. Nothing else in the bucket separates: every one of
     * the 73 carries `new_globally`, 65 carry `sleeper_awakened`, and the
     * profile-side signals leave the rate where they found it.
     *
     * n is 4. That is not a policy, it is a first reading, and it is recorded
     * here so the next reading can contradict it. What makes it worth acting on
     * early is that the same shape has now been measured on three separate
     * paths — the window stages twice and this bucket once — and points the
     * same way each time: across every stage, a punishment landing on a reply
     * from an account with no prior findings is reversed at 14.9% against the
     * system's 0.93%.
     *
     * A captcha rather than plain `observe` wherever one can actually be asked.
     * The point of this branch is that the message survives, not that nothing
     * happens: a bot cannot answer the gate, the person we were wrong about
     * taps once and carries on, and the chat still gets its vote. Routed
     * through `mayAskCaptcha` rather than `captchaEnabled` alone, because a
     * prompt nobody can receive is a gate that never closes — the comment-group
     * case that made that helper exist.
     */
    if (isInExchange(verdict.signals)) {
      meta['cappedReplyReason'] = verdict.reasonCode
      const gate = mayAskCaptcha(policyInputFor(verdict.pSpam, verdict.signals))
      return {
        ...verdict,
        action: (gate ? 'captcha' : 'observe') as VerdictAction,
        needsVote: input.policy.votingEnabled,
        banDurationSeconds: null,
        reasonCode: 'content_unconfirmed'
      }
    }
    return {
      ...verdict,
      action: 'delete' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null,
      requireCaptcha: input.policy.captchaEnabled && isNewish(input),
      reasonCode: 'content_unconfirmed'
    }
  }

  /**
   * Hold a verdict to `delete` when its reason names an act ordinary members
   * also perform and the message evidence does not independently earn a
   * removal. See `IMITABLE_REASON_CODES` for why these codes and no others.
   *
   * Three things this deliberately does NOT do:
   *
   *  - it does not touch the reason code. `capUnearnedRemoval` rewrites it to
   *    `content_unconfirmed`, which is right there (the pipeline really did
   *    stop believing its own reason) and wrong here (the reason stands; only
   *    the punishment was too much). It also has a measurement cost that this
   *    audit paid: of six reversals still called spam on replay, three read
   *    `content_unconfirmed` and no longer said which stage produced them.
   *    A ceiling that erases the label makes the next audit blind to itself.
   *  - it does not ask for a captcha. That question separates a human from a
   *    script, and by construction these codes name something humans do — so
   *    the answer is known in advance and filters nobody.
   *  - it does not fire when `mayRemoveSender` holds AND the sender is a
   *    stranger. Corroborating message evidence is what turns a guess about
   *    intent into a finding — about the message. For somebody the chat's own
   *    history vouches for it settles nothing, because the disputed thing was
   *    never whether a link is a link (`hasSenderStanding` carries the
   *    measurement, including what revokes the standing). 2026-08-08 08:58: an
   *    `established_user` was banned on `private_invite_link` +
   *    `promo_in_message_link` = 3.0, over the 2.0 bar, and an admin undid it
   *    31 seconds later.
   */
  /**
   * A clean reading of the sentence does not unfind an account farm.
   *
   * The classifier's number replaces the score outright. That is right where
   * the two disagree about the MESSAGE — the model read it and the arithmetic
   * did not — and wrong for the one finding the model cannot read at any
   * length: that this account's profile photo is also on seventeen others.
   *
   * Measured over the fortnight to 2026-08-30. 96 decisions where the model
   * cleared a message whose whole case was that photo, found on 4 to 25 other
   * accounts; `contentEvidence` was 1.8 in every single one — the photo and
   * nothing else — and the score ran 0.909 to 0.994. 48 accounts, of which 34
   * nothing ever caught. The texts were about twenty Ukrainian phrases of
   * ordinary outrage, rotated between accounts and paced 28 to 33 hours apart:
   * unreadable as spam by anybody judging the sentence, and too slow for the
   * velocity window at six hours to ever see two copies together.
   *
   * A floor and not a verdict. The message stays — the one stage that can read
   * it has read it and said it is fine, and deleting would punish the sentence
   * rather than the operator. What is left is the question a farm cannot
   * answer and a person answers with one tap, plus the chat's own vote.
   * `contentEvidence` 1.8 sits one notch under `SENDER_REMOVAL_MIN_EVIDENCE` by
   * the catalogue's deliberate choice, and nothing here lifts it.
   *
   * Deliberately NOT done by putting the fact in the prompt, which is where
   * this went first. Replayed A/B against the live model on the same 96 texts,
   * 2026-08-30: telling it moved 44 of 95 above the grey band, but the answers
   * stopped being answers — 14 of the 26 texts asked more than once came back
   * with readings differing by 0.4 or more (one ranged 0.05 to 0.90 across five
   * asks), and 20 of the raised verdicts carried a CLEAN reason code with a
   * spam-level number, `legit_conversation` at 0.85 among them. The model
   * cannot weigh a fact it cannot check; it can only be nudged by it, and a
   * nudge that lands on `guest_bot_promo` for a sentence about air raids is a
   * worse outcome than the silence it replaced. Deterministic here, so the card
   * says the true reason and the action is the same one every time.
   */
  const floorNetworkFact = (verdict: Verdict): Verdict => {
    if (isEnforcementAction(verdict.action) || verdict.action === 'captcha') return verdict
    if (!verdict.signals.some((s) => s.name === 'avatar_shared_with_accounts')) return verdict
    meta['flooredNetworkFact'] = true
    const gate = mayAskCaptcha(policyInputFor(verdict.pSpam, verdict.signals))
    return {
      ...verdict,
      action: (gate ? 'captcha' : 'observe') as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null,
      reasonCode: 'shared_profile_photo'
    }
  }

  const capImitableAct = (verdict: Verdict): Verdict => {
    if (!IMITABLE_REASON_CODES.has(verdict.reasonCode)) return verdict
    if (!removesSender(verdict.action)) return verdict
    const earnedIt = mayRemoveSender(verdict.signals)
    if (earnedIt && !hasSenderStanding(verdict.signals)) return verdict
    meta['cappedFrom'] = verdict.action
    meta['cappedImitable'] = verdict.reasonCode
    // Only when the evidence WAS sufficient and standing overrode it. Marks
    // exactly this branch, so the next audit can price it without re-deriving
    // which of two reasons capped the verdict.
    if (earnedIt) meta['cappedStanding'] = true
    return {
      ...verdict,
      action: 'delete' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null
    }
  }

  /**
   * Hold a WINDOW verdict — the session pile or the burst blob — to `observe`
   * plus a chat vote when the signals vouch for the sender.
   *
   * Every other stage passes an evidence bar before it may act; these two, by
   * construction, cannot (see `judgeAccumulated`) — they hand the model's pSpam
   * straight to `policyFor`, so `established_user` (-1.5), `trusted_reputation`
   * (-2.5) and `is_reply` (-1) were computed, logged, and then not consulted.
   *
   * Production 2026-08-17/18: 14 session verdicts on `flood`, 4 acted on, 2 of
   * the 3 subsequently reviewed overturned by the chat 0:3. One carried
   * scorePSpam 0.0003 against the model's 0.94 — four leading zeros of
   * arithmetic saying innocent, outvoted by one call on five concatenated
   * one-liners. Eight more were stopped by the trusted/admin guard in the
   * executor, i.e. after the verdict rather than by it, which is why they show
   * as `skipped` and not as a ceiling.
   *
   * Why `observe` and not the usual `delete` ceiling: on every other path the
   * message evidence is not in dispute and only the punishment was too much. A
   * session verdict has no message evidence at all — the input is by definition
   * lines that meant nothing individually — so there is nothing left to justify
   * removing anything. The chat is asked instead, and answers in seconds; a
   * spam-resolved vote deletes and mutes through `enforceVoteSpam` exactly as
   * before.
   *
   * For a VOUCHED sender, deliberately not limited to `IMITABLE_REASON_CODES`:
   * that ceiling is about acts ordinary members also perform, and this is about
   * a stage with no bar. The reply branch added below is limited to them, and
   * for the opposite reason — see it.
   * The revoker is the shared one — an account carrying `prior_spam_detections`,
   * a Telegram scam/fake flag or an external listing never earns
   * `established_user` in the first place (`extractUserSignals`), so a
   * sold long-time account keeps no standing to spend here.
   */
  const capVouchedWindow = (verdict: Verdict): Verdict => {
    if (!isEnforcementAction(verdict.action)) return verdict
    const vouched = hasSenderStanding(verdict.signals)
    /**
     * The third discount, taken 2026-08-27, and taken narrowly.
     *
     * `is_reply (-1)` is named in the paragraph above as arithmetic this stage
     * discards, and was then left out of the predicate that acts on it — the
     * same half-application `trusted_reputation` got, found the same morning.
     * Production over the fortnight to 2026-08-27: 229 window enforcements, 23
     * of them reversed by an admin, and the reversals are not scattered. They
     * are 6 to 10 chats, 10 to 16 senders, 7 to 10 separate days, and the
     * single largest producer is this stage on `flood` — somebody talking in a
     * conversation, judged as a flood of it. The arithmetic knew: 0.0003,
     * 0.016, 0.018, 0.057 against the model's 0.89 to 0.98 on the same rows.
     *
     * Paired with the imitable list rather than standing alone, because a
     * reply costs one tap. The pairing is the consequence boundary the other
     * ceiling already draws — could an ordinary member plausibly have done
     * this — and it holds the categories where an ordinary member plainly
     * could. A hard finding on the same window still enforces: talking fast is
     * imitable, offering an escort service is not.
     *
     * Rejected on the way: keying this on the DISAGREEMENT between our score
     * and the model's, which those four numbers make tempting. The two are not
     * independent judges — the arithmetic is built from signals a sender can
     * manufacture, and wide disagreement is the defining property of the
     * messages that reach this stage rather than a fault in either. Measured,
     * it is also simply worse: a floor at 0.05 holds 3 of the 23 reversals and
     * 3 innocent bystanders with it.
     *
     * WHAT THIS RULE ITSELF IS WORTH, which is not the same number. Measured
     * alone it holds 10 of the 23 reversals against 12 undisputed removals —
     * but `capWindowFlood` runs before it and takes 18 of those 23 first, so
     * what reaches this branch is only the imitable codes that are not `flood`.
     * Incrementally, on the same fortnight, that is 3 rows: all 3 reversed, no
     * correct removal lost. Perfect on a sample far too small to call it
     * settled — this is an experiment with a clean first reading, and the thing
     * to watch is whether the next fifty keep that shape.
     */
    const answering = isInExchange(verdict.signals) &&
      IMITABLE_REASON_CODES.has(verdict.reasonCode)
    if (!vouched && !answering) return verdict
    meta['cappedFrom'] = verdict.action
    // Which of the two reasons capped it, never both collapsed into one flag:
    // they carry different risks and the next audit has to price them apart.
    if (vouched) meta['cappedVouched'] = true
    else meta['cappedReplyReason'] = verdict.reasonCode
    return {
      ...verdict,
      action: 'observe' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null
    }
  }

  /**
   * A window stage may never enforce on `flood`, whoever sent it.
   *
   * This one is not calibration. `flood` is a description of this stage's
   * INPUT, not a finding about it: the pile exists precisely because a sender
   * produced several short messages that nothing could classify one at a time,
   * so answering "flood" hands the premise back as the conclusion. Every other
   * answer the stage gives is a claim about CONTENT — a fake vacancy, a flirt
   * bait, a gambling pitch — and those are the ones that hold up.
   *
   * The fortnight to 2026-08-27 separates them cleanly. Window enforcement on
   * `flood`: 66 punishments, 18 reversed by an admin — 27.3%. Window
   * enforcement on every other reason: 163 punishments, 5 reversed — 3.1%. It
   * is not the stage, then, and it is not the code either: the same code
   * decided by the ordinary per-message classifier runs at 6.8%, four times
   * better. It is this stage answering with this word.
   *
   * Three narrower rules were measured first and none of them separates the
   * sound verdicts from the reversed ones. Blob size does not: the median is 5
   * messages on both sides, because 5 is what makes the window fire. Requiring
   * the sender to be new to the chat is worse than useless — that cohort
   * reverses at 36% against 26% for everyone else, i.e. inverted. Trust
   * signals narrow it to 20.5%, still an order above the system's 0.92%.
   * Nothing available tells the two apart, and a class of enforcement that
   * cannot be told apart from its own mistakes at better than one in four does
   * not get to make the irreversible choice.
   *
   * The word is deliberately NOT taken out of the vocabulary offered to the
   * model. Forced to choose, it would relabel the same weak evidence as
   * `other_spam` — hiding the failure rather than fixing it, and inside a code
   * that currently reverses at 0 of 48. `flood` stays sayable and stops being
   * actionable, which also leaves the label to measure the change by.
   *
   * `cappedFrom` is only claimed if nothing set it already: `capImitableAct`
   * runs before this and its answer — what the ladder ORIGINALLY reached — is
   * the more informative of the two.
   */
  const capWindowFlood = (verdict: Verdict): Verdict => {
    if (verdict.reasonCode !== 'flood') return verdict
    if (!isEnforcementAction(verdict.action)) return verdict
    if (meta['cappedFrom'] === undefined) meta['cappedFrom'] = verdict.action
    meta['cappedRestated'] = true
    return {
      ...verdict,
      action: 'observe' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null
    }
  }

  const none = (decidedBy: DecidedBy, reasonCode: string, signals: Signal[] = []): Verdict =>
    finalize(
      { pSpam: 0, decidedBy, ruleId: null, reasonCode, reasonEvidence: null },
      signals,
      { action: 'none', needsVote: false, banDurationSeconds: null }
    )

  // ── 1. gates ────────────────────────────────────────────────────────

  if (!input.policy.enabled) return none('abstain', 'spam_check_disabled')

  const text = input.message.text ?? ''
  for (const [index, raw] of input.policy.customRules.entries()) {
    const rule = parseCustomRule(raw)
    if (!rule || !customRuleMatches(text, rule.pattern)) continue
    if (rule.kind === 'allow') {
      return none('custom_rule', 'custom_allow')
    }
    return finalize(
      {
        pSpam: CUSTOM_DENY_PSPAM,
        decidedBy: 'custom_rule',
        ruleId: `custom:${index}`,
        reasonCode: 'custom_deny',
        reasonEvidence: rule.pattern
      },
      []
    )
  }

  // Extracting signals is pure and free — only the ports cost anything — so the
  // message half is read before the exempt below rather than after it.
  const messageSignals = extractMessageSignals(input.message)

  // ── 1b. established-regular fast path ───────────────────────────────
  // Runs AFTER custom rules (an admin DENY/ALLOW always wins) but BEFORE any
  // heuristic or paid port: an established member skips the whole ladder.
  //
  // Except for a message that would license removing anybody. The exempt used
  // to return before signals existed, so nothing in the message could cancel it
  // — and the account-level guard that can needs two prior spam detections,
  // which cannot accumulate while the account is exempt. That closed the loop:
  // a sold or compromised long-time account had a permanent full bypass in
  // every chat we watch.
  //
  // The bar is the one already in use for taking the chat away from somebody,
  // asked of the message alone. It leaves the exempt's purpose intact — a
  // regular's link must not be deleted on a signature or vector MATCH — while
  // declining to wave through structural evasion that has no innocent reading.
  if (isEstablishedRegular(input) && !mayRemoveSender(messageSignals)) {
    meta['established_regular'] = true
    meta['messagesInChat'] = input.user.messagesInChat ?? 'unknown'
    meta['messagesGlobal'] = input.user.messagesGlobal ?? 'unknown'
    return none('deterministic', 'established_regular')
  }

  // ── 2. signals ──────────────────────────────────────────────────────

  const signals: Signal[] = [
    ...messageSignals,
    ...extractUserSignals(input.user),
    ...extractBioSignals(input.enrichment.bio, input.enrichment.businessTexts),
    ...extractLinkedChannelSignals(input.enrichment.linkedChannels)
  ]
  // Chat-level trusted list is equivalent to trusted reputation.
  if (input.policy.trustedUserIds.includes(input.user.id) &&
      !signals.some((s) => s.name === 'trusted_reputation')) {
    signals.push({ name: 'trusted_reputation' })
  }
  // Enrichment: a bot mention resolved among the mentions is promo-relevant.
  if (input.enrichment.resolvedMentions.some((m) => m.kind === 'bot')) {
    signals.push({ name: 'bot_mention' })
  }
  // A linked personal channel (userFull.personal_channel_id) is a promo vector
  // on a new account; harmless on an established one (scoring weight is low).
  if (input.enrichment.personalChannelId !== null) {
    signals.push({ name: 'personal_channel' })
  }
  // Written in a script the chat does not use. Every stage below this line is
  // calibrated on the chat's own language, so against an alien script they are
  // all blind at once and none of their silences means anything.
  const foreignScript = isForeignScript(text, input.chat, input.enrichment.conversationWindow)
  if (foreignScript !== null) {
    signals.push({ name: 'foreign_script', evidence: foreignScript })
  }

  // ── 2b. what the profile itself shows ───────────────────────────────

  /**
   * Explicit imagery on the account's own surfaces — avatar, stories, and the
   * channel the profile points at, picture and blurb alike.
   *
   * Placed HERE, before the abstain gate, and that placement is the fix rather
   * than an optimisation. These signals used to sit with the message-content
   * ports after the gate, and the gate returns `observe` for any message too
   * short to carry meaning — which is the entire message repertoire of the
   * class they exist to catch. Production 2026-08-24, a first message of four
   * words under a channel post: the avatar was downloaded, sent to the
   * moderation API, paid for, and the answer arrived after the pipeline had
   * already decided to say nothing. The account's whole advertisement is its
   * profile; the message is bait to put that profile in front of the chat, and
   * it works precisely because nothing in the message is worth judging.
   *
   * Still `shape`, still incapable of convicting on its own — what changes is
   * that the facts now exist by the time anything reads them.
   *
   * Costs nothing where it did not already run: the app layer fills these
   * fields only for newish senders, and the moderation port caches by content,
   * so one account's avatar is screened once every few hours however much it
   * posts.
   */
  const screenProfileMedia = async (): Promise<void> => {
    if (!ports.moderation) return
    // Judged on the sexual categories' own confidence (NSFW_PROFILE_MIN_SCORE),
    // never on the provider's recall-tuned `flagged` boolean — that one spans
    // violence and self-harm, and it is what once banned first-time posters
    // over stylised art (2026-07-27).
    /**
     * The strongest sexual score any profile surface returned, explicit or not.
     *
     * Recorded in `meta` whether or not it crossed anything, because the bars
     * above are a calibration decision and until now nothing wrote down the
     * number they are compared against — the store keeps signal NAMES only, so
     * "where should this threshold sit" could not be asked of production at all.
     * One field turns the next answer into a query instead of an argument.
     */
    let topSexual = 0
    const noteSexual = (result: { scores: Record<string, number> } | null): void => {
      const score = sexualScore(result)
      if (score !== null && score > topSexual) topSexual = score
    }

    if (input.enrichment.avatarBase64) {
      const avatar = await safe('moderation_avatar', () =>
        ports.moderation!.check('', input.enrichment.avatarBase64))
      noteSexual(avatar)
      const hit = nsfwProfileHit(avatar)
      if (hit !== null) signals.push({ name: 'nsfw_avatar', evidence: hit })
    }

    if (input.enrichment.storyBase64.length > 0) {
      const hits = new Set<string>()
      for (const story of input.enrichment.storyBase64) {
        const result = await safe('moderation_story', () => ports.moderation!.check('', story))
        noteSexual(result)
        const hit = nsfwProfileHit(result)
        if (hit !== null) hits.add(hit)
      }
      if (hits.size > 0) {
        signals.push({ name: 'nsfw_stories', evidence: [...hits].join(', ') })
      }
    }
    /**
     * The channel the PROFILE points at — its picture and its own description.
     *
     * The description is read because `promo_in_linked_channel` cannot see this
     * class at all: it asks `extractBioSignals`, which looks for a URL, a phone
     * number or a cashtag, and an escort channel advertises in words. A blurb
     * that is a list of services raised nothing, so the strongest fact about
     * the account was silently worth zero.
     *
     * The bar is the PROFILE bar (0.8), not the message-content bar (0.5), and
     * that is a measurement rather than an inheritance. 2026-08-24, against
     * `omni-moderation-latest`: the production blurb — an explicit list of
     * services — scores 0.836; "приватний канал для дорослих, умови в лс 18+"
     * 0.206; a sex-education channel 0.065; adult humour 0.053; ordinary shops
     * and news 0.00. Nothing in that spread lands between 0.5 and 0.8, so
     * lowering the bar would buy no recall and only widen the class. Note what
     * the same numbers say about reach: a softly-worded escort blurb is not
     * catchable by text at any bar, and the avatar is what carries that case.
     *
     * Two calls, not one with both inputs: the port reads `results[0]`, so a
     * combined call would silently discard whichever verdict came second.
     *
     * Message-link channels are deliberately excluded. Where a link in THIS
     * message leads is a statement about the message, and mixing it into a
     * profile signal would file message evidence under sender shape — the exact
     * confusion `ChannelPreview.source` exists to prevent. `promo_in_message_link`
     * is that side's signal.
     */
    for (const channel of input.enrichment.linkedChannels) {
      if (channel.source === 'message_link') continue
      const blurb = [channel.title, channel.description ?? ''].join(' ').trim()
      const [byPhoto, byText] = [
        channel.avatarBase64
          ? await safe('moderation_channel', () =>
            ports.moderation!.check('', channel.avatarBase64))
          : null,
        blurb.length > 0
          ? await safe('moderation_channel_text', () => ports.moderation!.check(blurb, null))
          : null
      ]
      noteSexual(byPhoto)
      noteSexual(byText)
      const hit = nsfwProfileHit(byPhoto) ?? nsfwProfileHit(byText)
      if (hit !== null) {
        signals.push({ name: 'nsfw_linked_channel', evidence: `«${truncate(channel.title, 40)}»: ${hit}` })
        break
      }
    }

    if (topSexual > 0) meta['profileSexual'] = Number(topSexual.toFixed(3))
    const suggestive = suggestiveProfileEvidence(topSexual)
    if (suggestive !== null) {
      signals.push({ name: 'suggestive_profile_media', evidence: suggestive })
    }
  }

  /**
   * Is this photograph already on another account?
   *
   * Deliberately independent of what the picture DEPICTS. A perfectly ordinary
   * photograph shared across a batch of accounts says the same thing as an
   * explicit one shared across a batch: the accounts are dressed from one
   * folder. This is the only observation in the pipeline that concerns a
   * different account than the sender, so it is also the only one that can see
   * a farm rather than a member.
   *
   * Its own function, and NOT part of `screenProfileMedia`, since 2026-08-30.
   * It lived inside that one because both read the same picture, and so it
   * inherited that function's first line — `if (!ports.moderation) return`.
   * Nothing here needs the moderation port: the hash is computed by the app
   * layer from the avatar bytes, and the lookup is one indexed read against our
   * own store. So a moderation outage, or a deployment with no moderation key,
   * silently switched off the one detector that can see an account farm — and
   * switched it off invisibly, because a signal that never fires looks exactly
   * like a signal with nothing to report.
   */
  const screenProfileReuse = async (): Promise<void> => {
    if (!ports.profileMedia || typeof input.enrichment.avatarDhash !== 'string') return
    const reuse = await safe('profile_media', () =>
      ports.profileMedia!.seen(input.user.id, input.enrichment.avatarDhash!))
    if (reuse === null || reuse.otherAccounts <= 0) return
    const shared = reuse.sampleUserIds.join(', ')
    signals.push(reuse.otherAccounts >= 2
      ? {
          name: 'avatar_shared_with_accounts',
          evidence: `same profile photo on ${reuse.otherAccounts} other accounts: ${shared}`
        }
      : { name: 'avatar_shared_with_account', evidence: `same profile photo as ${shared}` })
    meta['avatarSharedWith'] = reuse.otherAccounts
  }

  // ── 3. deterministic rules ──────────────────────────────────────────

  /**
   * Whether anything in this message is classifiable on its own — the abstain
   * gate's own question, asked once and read twice.
   *
   * The gate itself is stage 4, but one rule needs the answer here: an account
   * whose profile is the advertisement posts nothing worth judging by design,
   * so "there is nothing to read" is not a reason to stop looking, it is the
   * shape of the thing.
   */
  const lowInformation = shouldAbstain(input.message, {
    stranger: isStrangerHere(signals),
    obfuscated: signals.some((signal) => signal.name === 'greek_homoglyph_word')
  })

  /**
   * Twice, and the order is the whole point: rules that cost nothing first, the
   * ones that need paid evidence only if none of them concluded.
   *
   * Every rule here is a pure function of the signals, and the second pass runs
   * over a superset of the first — so it can only find what the first could not,
   * never contradict it. That matters for the clean rules in particular: a
   * trusted member is waved through by pass one and never pays for a profile
   * screen at all.
   *
   * Without the split, screening ran ahead of every rule and charged three
   * moderation round-trips to verdicts that never needed them — production has
   * 35 008 deterministic verdicts in three days, most of them an external-ban
   * listing that says nothing about a picture.
   */
  let deterministic = applyDeterministicRules(signals, { lowInformation })
  if (!deterministic) {
    await Promise.all([screenProfileReuse(), screenProfileMedia()])
    deterministic = applyDeterministicRules(signals, { lowInformation })
  }
  if (deterministic) {
    if (deterministic.kind === 'clean') {
      return none('deterministic', deterministic.ruleId, signals)
    }
    const verdict = finalize(
      {
        pSpam: deterministic.pSpam,
        decidedBy: 'deterministic',
        ruleId: deterministic.ruleId,
        reasonCode: deterministic.ruleId,
        reasonEvidence: signals.find((s) => !isTrustSignal(s.name))?.evidence ?? null
      },
      signals
    )
    // Being deterministic is a statement about confidence in the RULE, not a
    // licence the scoring path lacks. A rule that points at the message is held
    // to the same evidence bar as arithmetic over the same signals — otherwise
    // the pipeline holds two positions on one set of facts and which applies
    // depends only on which stage spoke first.
    //
    // Production 2026-08-01 15:47: a member answering somebody pasted a private
    // invite and "you can ask here". `private_invite_new` muted them at 0.93 on
    // `private_invite_link` alone — 1.8 against a bar of 2.0 — while a
    // regression test pins the identical signals to `delete` when the score
    // decides. Rules about the ACCOUNT keep their reach; see `aboutAccount`.
    if (!deterministic.aboutAccount &&
        removesSender(verdict.action) && !mayRemoveSender(signals)) {
      return capUnearnedRemoval(verdict)
    }
    /**
     * The chat's own circuit breaker for this rule.
     *
     * A deterministic rule is a statement about the population the bot serves,
     * and one chat can sit outside that population. Production for the
     * fortnight to 2026-08-28: a vacancy chat where `external_ban_new` fired 5
     * times and the admin reversed 4 — every reversal a DIFFERENT user, so the
     * per-user trust an override grants never engaged once, and the next
     * listed vacancy poster met the same ban. `wornRuleIds` is computed from
     * those permanent reversals (see the store): the rule keeps firing, keeps
     * deleting, keeps asking the chat — it has only lost the authority to
     * remove a sender in a chat whose admins keep saying it is wrong here.
     */
    if (removesSender(verdict.action) &&
        verdict.ruleId !== null &&
        (input.policy.wornRuleIds ?? []).includes(verdict.ruleId)) {
      meta['cappedFrom'] = verdict.action
      meta['cappedWornRule'] = true
      return {
        ...verdict,
        action: 'delete' as VerdictAction,
        needsVote: input.policy.votingEnabled,
        banDurationSeconds: null
      }
    }
    return verdict
  }

  // ── 3b. the sender's recent run ─────────────────────────────────────

  /**
   * The sender's preceding messages in this chat — the only input in the pipeline
   * that describes a cadence rather than a message.
   *
   * Read BEFORE the abstain gate, which costs one indexed lookup on a path that
   * used to reach the ports without any. That is deliberate and it is the whole
   * point: the message that finishes a split-up pitch is "write to me privately",
   * which is exactly the shape the abstain gate calls too short to judge. Reading
   * the window after that gate would have left the one stage that can see the
   * pattern blind to the messages the pattern is made of.
   *
   * Still free where it must be. The established-regular exempt returns above
   * this line, so a known regular pays nothing; and the gate below already pays
   * for a session-window round-trip on every message it buffers, so this is one
   * more read on a path that was never port-free.
   */
  const burstWindow = ports.burst
    ? (await safe('burst', () => ports.burst!.read(input.message.chatId, input.user.id))) ?? []
    : []
  signals.push(...burstSignals(burstWindow))

  // ── 4. abstain gate + session window ────────────────────────────────

  /**
   * Add this message to the sender's window and, once enough have piled up,
   * judge the pile. Returns a verdict only when the pile was actually judged.
   *
   * Two situations reach this, and they are the same situation: nobody could
   * say anything about the message. The abstain gate catches the ones too
   * short to carry meaning; the tail of the pipeline catches the ones that
   * carried meaning nothing recognised. Either way the answer is to remember
   * it and read five of them together, which costs one call per five messages
   * rather than one per message.
   */
  const judgeAccumulated = async (minMessages: number): Promise<Verdict | null> => {
    // A message with no text has nothing to accumulate. Without this, photos,
    // stickers and voice notes appended empty strings until five of them filled
    // the window, and the model was then asked to classify "\n\n\n\n" and acted
    // on the answer — verdict roulette on nothing, which is what the abstain
    // gate exists to prevent, reintroduced one level down (2026-08-01).
    if (!ports.session || text.trim().length === 0) return null
    const window = await safe('session', () =>
      ports.session!.append(
        input.message.chatId, input.user.id, input.message.messageId, text))
    if (!window || window.count < minMessages || !ports.llm) return null
    // Defence in depth: a window can still be blank if a port implementation
    // stored something we would not have sent.
    if (window.combinedText.trim().length === 0) return null
    {
      // The accumulated window may read as spam even when each line alone
      // is unclassifiable ("пиши мені" / "в особисті" / "заробіток" …).
      const sessionInput: EvaluationInput = {
        ...input,
        message: { ...input.message, text: window.combinedText }
      }
      const llmVerdict = await safe('llm_session', () => ports.llm!.classify(sessionInput))

      if (llmVerdict) {
        // A judged batch is spent. Without this the window — which saturates at
        // its cap — was re-classified on every subsequent low-information
        // message, i.e. an unbounded series of rolls over substantially the same
        // text, any one of which enforces. The abstain gate exists precisely to
        // stop verdict roulette on unclassifiable messages; re-judging its
        // buffer reintroduced it one level up. Not reset when the LLM never
        // answered: an outage must not discard accumulated evidence.
        await ports.session!.reset(input.message.chatId, input.user.id)
          .catch(() => { /* best-effort: worst case is one extra evaluation */ })

        // The caller logs the triggering message; the verdict is about the blob.
        // Without recording it, a session FP cannot be reviewed at all.
        meta['judgedText'] = window.combinedText
        meta['judgedCount'] = window.count
        if (llmVerdict.model !== undefined) meta['llmModel'] = llmVerdict.model
        if (llmVerdict.promptId !== undefined) meta['llmPrompt'] = llmVerdict.promptId
        /**
         * NOTE — the safeguard that used to sit here is gone with the tier split.
         *
         * Concatenated one-liners are the weakest input in the pipeline: no
         * structure, no single subject, and by construction no line that meant
         * anything on its own. Removing somebody over that required the stronger
         * model to agree (2026-07-30: a two-word conversational message banned at
         * 0.98 on a cheap `flood` verdict). With one classifier there is nobody to
         * ask, and this verdict returns straight to the caller — so unlike every
         * other stage it passes no evidence bar.
         *
         * Deliberately NOT replaced with `capUnearnedRemoval`: that bar wants
         * ~2.0 units of firsthand MESSAGE evidence, which plain-text solicitation
         * never carries (no URL, no phone, no obfuscation), so capping here would
         * end sender removal for text-only scam altogether — a policy change, not
         * a translation of this guard. What the band should be is a calibration
         * decision; see `docs/calibration.md`.
         */
        return capVouchedWindow(capWindowFlood(capImitableAct(finalize(
          {
            pSpam: llmVerdict.pSpam,
            decidedBy: 'session',
            ruleId: null,
            reasonCode: llmVerdict.reasonCode,
            reasonEvidence: llmVerdict.evidence
          },
          signals
        ))))
      }
    }
    return null
  }

  /**
   * Ask the classifier about the sender's whole run of recent messages.
   *
   * The case for the call is not that this message is suspicious — nothing here
   * said it was — but that it is the third in a few minutes and the ones before
   * it kept coming back unsure. Spam split across messages is invisible to every
   * other stage by construction: a pitch with no link, a photo, and "write to me
   * privately" are each unremarkable, and the pipeline judges each of them
   * alone.
   *
   * Deliberately the most cautious stage in the file. A blob is weak input — no
   * single subject, no line that meant anything by itself — so on top of the
   * shared window ceiling it may take the MESSAGE down and never the person,
   * unless the message evidence earns a removal on the bar every other stage
   * answers to. A new stage does not get to be the one that removes people on a
   * cadence; if calibration later says it can be trusted with more, that is a
   * measured change and this is the line to change.
   */
  const judgeBurst = async (entries: readonly BurstEntry[]): Promise<Verdict | null> => {
    if (!ports.burst || !ports.llm) return null
    const blob = burstBlob(entries, text)
    if (!blob) return null
    const llmVerdict = await safe('llm_burst', () => ports.llm!.classify({
      ...input,
      message: { ...input.message, text: blob.text }
    }))
    if (!llmVerdict) return null
    // A judged window is spent — the same rule as the session pile, for the same
    // reason: without it the next message re-rolls substantially the same blob,
    // and any one roll enforces.
    await ports.burst.reset(input.message.chatId, input.user.id)
      .catch(() => { /* best-effort: worst case is one extra evaluation */ })
    // The caller logs the triggering message; the verdict is about the run.
    // Truncated through `truncate`, not `slice`: a cut through a surrogate pair
    // is stored as U+FFFD and the record is then subtly wrong forever.
    meta['judgedText'] = truncate(blob.text, 1000)
    meta['judgedCount'] = blob.count
    if (llmVerdict.model !== undefined) meta['llmModel'] = llmVerdict.model
    if (llmVerdict.promptId !== undefined) meta['llmPrompt'] = llmVerdict.promptId
    const judged = capVouchedWindow(capWindowFlood(capImitableAct(finalize(
      {
        pSpam: llmVerdict.pSpam,
        decidedBy: 'burst',
        ruleId: null,
        reasonCode: llmVerdict.reasonCode,
        reasonEvidence: llmVerdict.evidence
      },
      signals
    ))))
    if (removesSender(judged.action) && !mayRemoveSender(signals)) {
      return capUnearnedRemoval(judged)
    }
    return judged
  }

  /**
   * Whether anything about the ACCOUNT spoke — used twice below, so computed
   * once here: it decides whether repetition is worth counting, and whether a
   * captcha may be asked at all.
   */
  const profileSpoke = signals.some((s) => PROFILE_EVIDENCE_SIGNALS.has(s.name as never))

  /**
   * The same nothing, again, is not nothing.
   *
   * Measured 2026-08-25, and the case that motivated this whole area: an
   * account with a private invite in its bio posted ONE heart emoji into one
   * chat six times over twelve hours. Every one of the six was judged as if it
   * were the first — pSpam 0, `observe` — because every clock this pipeline
   * owns is shorter than the gap between them (burst 10 minutes, session 30)
   * and because the one window that is long enough, velocity at six hours,
   * refuses to key on a text whose normalised template is under five
   * characters. An emoji normalises to the empty string, so the counter never
   * saw a single copy. Meanwhile each repeat earned the account tenure.
   *
   * So: count the exact text, and only for a sender whose profile already said
   * something. That restriction is the whole safety of it — an ordinary member
   * sending "👍" three times is exactly what exact matching would otherwise
   * charge for, and they are not the population being looked at here.
   *
   * What it does is narrow on purpose: it does not decide anything, it removes
   * the excuse. A message that repeats is no longer "too little to judge", so
   * the ladder below runs normally — signatures, vectors, the classifier — and
   * whatever they conclude is reached with the message read, not guessed at.
   */
  // `profileSpoke`, not `profileHasCase`, and the asymmetry is the point: this
  // is a lookup, not a punishment. Deciding to LOOK at somebody costs an
  // indexed read and can only ever add evidence; deciding to ask them to prove
  // they are human costs them the benefit of the doubt. The same split the
  // report path settled on 2026-08-26 — looking needs a lower bar than acting.
  /**
   * What this run watched happen to this message, for the stage that decides.
   * See `MessageObservations` — filled by the velocity stage, read by the LLM.
   */
  const observed: MessageObservations = {}

  const repetition = lowInformation && profileSpoke && ports.velocity
    ? await safe('velocity', () =>
        ports.velocity!.check(input, { countExactWhenTemplateUnusable: true }))
    : null
  const repeatsItself = repetition?.exceeded === true && repetition.singleAuthor === true
  if (repeatsItself) {
    signals.push({
      name: 'velocity_repeats',
      evidence: repetition?.evidence ?? 'the same message repeated by this account'
    })
    if (repetition?.evidence) observed.repetition = repetition.evidence
  }

  // A message in an unfamiliar script is never "too little to judge": whatever
  // it says it says in full, and unlike a bare "@user" it is trivially readable
  // — by the LLM, if by nothing else here.
  if (foreignScript === null && lowInformation && !repeatsItself) {
    // The full pile, always. A bare "@someone" as a first message is precisely
    // the noise this gate exists to stop asking the model about, so the
    // shortcut below must not reach in here.
    const judged = await judgeAccumulated(SESSION_EVAL_MIN_MESSAGES)
    if (judged) return judged

    /**
     * Too little to judge ON ITS OWN is not too little to judge as the third
     * message of a run. "Write to me privately" carries nothing; a pitch, a
     * photo and then "write to me privately" carries the whole thing.
     *
     * Rate-limited by construction rather than by a counter: `burstBlob` will not
     * ask unless one of the preceding messages already scored above the grey
     * floor, and an abstained message scores zero — so a sender whose run is
     * nothing but small talk never reaches the classifier here.
     */
    const burstJudged = await judgeBurst(burstWindow)
    if (burstJudged) return burstJudged

    /**
     * Nobody could judge the MESSAGE. That is not the same as knowing nothing.
     *
     * The gate exists because acting on an unreadable message is verdict
     * roulette — and every word of that argument is about the message. A captcha
     * is not about the message: it does not remove anything, it asks the sender
     * to prove they are human, which a script cannot and a person does with one
     * tap. So for a sender whose PROFILE is loud enough to reach the grey band
     * on arithmetic alone, the honest answer to "we cannot read this" is to ask
     * rather than to shrug.
     *
     * This is the shape of the 2026-08-24 class: one-message accounts posting
     * "вот так вот" under a channel post, whose avatar is suggestive and whose
     * profile links a channel. Explicit media plus a promo channel is caught by
     * the rule above; this is the tier below it, where the evidence is real and
     * nowhere near a verdict.
     *
     * Nothing but a captcha may come out of here. `decideAction` will only
     * return one for a newish sender in a chat that enabled it, and everything
     * else — including anything that would remove a message — falls back to
     * `observe`, because none of it has read the text.
     */
    /**
     * The one call site allowed to withhold "nothing to read" discounts.
     *
     * Safe here and nowhere else, for a structural reason rather than a
     * calibrated one: nothing but a captcha can come out of this branch (see the
     * note above), so a score raised by withholding a discount can only ever buy
     * a question. The 2026-08-25 measurement of applying it globally is in
     * `ScoreOptions` — it produced `delete` and `kick` on "Усьо" and "Привіт :)".
     *
     * What it fixes: an account advertising in its bio used to be handed a -1.5
     * discount for posting an emoji, which cancelled the +1.5 invite link and
     * landed it below the grey band. Four identical "💗" from one such account
     * were observed four times over.
     */
    const shaped = scoreSignals(signals, { suspendProfileAnsweringDiscounts: true })
    const asked = policyFor(shaped.pSpam, signals)
    /**
     * A captcha is this branch's CEILING, not one point on its ladder.
     *
     * `policyFor` answers the general question "what does this score deserve",
     * and above the grey band it stops consulting `mayAskCaptcha` at all — it
     * returns `delete`, `kick`, `mute`. None of those may come out of here,
     * because nothing here read the message. Testing for equality with
     * 'captcha' therefore dropped exactly the strongest cases on the floor:
     * measured over 14 days, 56 rows scored ABOVE the captcha band and were
     * answered with `observe`, among them the case this branch was written for
     * — an account advertising a private invite in its bio, posting one emoji.
     *
     * Heavier evidence has to mean at least as much action, never less. So
     * anything from the grey band upward becomes the same question, asked only
     * where a question is permitted.
     */
    const deserved = asked.action !== 'observe' && asked.action !== 'none'
    /**
     * The profile has to have SAID something. Measured, 2026-08-25.
     *
     * The first captcha this branch ever issued in production went to an
     * account whose entire case was newness: a dormant account, new to us, new
     * to the chat, editing its message. No bio, no avatar, no linked channel —
     * nothing the branch is named after. Three newness signals stack to the
     * grey band on their own, so without this the branch asks "prove you are
     * human" of anyone the bot has simply not met before, which is a join gate
     * wearing a message gate's clothes.
     *
     * `newness` is a correlated group by design — one fact about an account
     * counted three ways — and a group cap keeps it from reaching a verdict.
     * It must not reach a question either.
     *
     * The guard was `profileSpoke` — has the profile raised ANY signal — until
     * 2026-08-26, when a nine-year-old account was asked to prove it was human
     * because it had a link in its bio. `promo_in_bio` weighs 0.3 and 22% of
     * bios carry one; a membership test cannot tell that from a private invite
     * at 1.5. `profileHasCase` is the weighted answer, and it is the SAME one
     * `accountVerdict` gives, so the two cannot come to disagree about whether
     * a profile has said anything.
     */
    if (deserved && profileHasCase(signals) && mayAskCaptcha(policyInputFor(shaped.pSpam, signals))) {
      meta['scorePSpam'] = Number(shaped.pSpam.toFixed(4))
      // Which discount was withheld, so a captcha that turned on this rule can
      // be told apart from one the arithmetic reached on its own.
      if (shaped.suspendedDiscounts.length > 0) {
        meta['suspendedDiscounts'] = shaped.suspendedDiscounts.join(',')
      }
      return finalize(
        {
          pSpam: shaped.pSpam,
          decidedBy: 'score',
          ruleId: null,
          reasonCode: 'low_information_profile',
          reasonEvidence: null
        },
        signals,
        // The literal action, not `asked` — which for a score above the band
        // says `delete`/`kick`. Passing it through was how a branch that
        // promises "nothing but a captcha" could have enforced.
        { action: 'captcha', needsVote: false, banDurationSeconds: null }
      )
    }

    return finalize(
      { pSpam: 0, decidedBy: 'abstain', ruleId: null, reasonCode: 'low_information', reasonEvidence: null },
      signals,
      { action: 'observe', needsVote: false, banDurationSeconds: null }
    )
  }

  // ── 5. knowledge ports ──────────────────────────────────────────────

  // Forward-source reputation first: one indexed read, and a blacklisted
  // origin (built from confirmed votes across chats) is decisive evidence.
  if (ports.forwards && input.message.forward) {
    const reputation = await safe('forwards', () => ports.forwards!.check(input.message.forward!))
    if (reputation === 'blacklisted') {
      const verdict = finalize(
        {
          pSpam: 0.95,
          decidedBy: 'forward',
          ruleId: 'forward_blacklist',
          reasonCode: 'forward_blacklist',
          reasonEvidence: input.message.forward.title
        },
        signals
      )
      /**
       * The one knowledge stage that returned without a ceiling, until
       * 2026-08-30. The vector port below has carried the same guard since
       * 2026-08-02, after a campaign whose seventh variant was answered with a
       * removal on resemblance alone.
       *
       * It matters more here than anywhere else in this file. Every other stage
       * judges something the sender DID; a blacklisted origin is a fact about a
       * channel somebody else runs, and forwarding a scam into a chat to ask
       * "is this real?" is the most ordinary thing a member can do with one.
       * `0.95` lands exactly on the standard ban threshold, so this branch
       * would hand a newish account thirty days for quoting an advert it did
       * not write — with `contentEvidence` at zero and no stage having found
       * anything in the message at all.
       *
       * The message still goes: where the forward came from is ample reason to
       * take it down, which is what `strongest` licenses and `total` does not.
       * 45 sender removals came out of this branch in the fortnight to
       * 2026-08-30; of the 8 whose evidence was recorded, one falls under this
       * ceiling, so the change is close to a no-op today and the hole it closes
       * is the one that has no floor.
       */
      if (!removesSender(verdict.action) || mayRemoveSender(signals)) return verdict
      meta['cappedFrom'] = verdict.action
      // The reason is KEPT, unlike `capUnearnedRemoval`, and the difference is
      // real: there the pipeline stopped believing its own reason, here it still
      // believes the origin is blacklisted and only declines to punish a person
      // for somebody else's channel. `capImitableAct` made the same choice and
      // its note carries the price of the other one — of six reversals still
      // called spam on replay, three read `content_unconfirmed` and no longer
      // said which stage had produced them.
      return {
        ...verdict,
        action: 'delete' as VerdictAction,
        needsVote: input.policy.votingEnabled,
        banDurationSeconds: null
      }
    }
    if (reputation === 'suspicious') {
      const title = input.message.forward.title
      signals.push(title ? { name: 'forward_source_suspicious', evidence: title } : { name: 'forward_source_suspicious' })
    }
  }

  if (ports.signatures) {
    const match = await safe('signatures', () => ports.signatures!.match(text))
    if (match) {
      if (match.status === 'confirmed') {
        return finalize(
          {
            pSpam: match.pSpam,
            decidedBy: 'signature',
            ruleId: match.signatureId,
            reasonCode: 'known_spam_signature',
            reasonEvidence: null
          },
          signals
        )
      }
      signals.push({ name: 'signature_candidate_match', evidence: match.signatureId })
    }
  }

  // `repetition !== null` means the low-information gate already asked this
  // window about this message. Asking twice would BUMP THE COUNTER twice for
  // one arrival — the window counts copies, and a second call is indistinguishable
  // from a second copy — so the earlier answer is reused rather than re-fetched.
  if (ports.velocity && repetition === null) {
    const velocity = await safe('velocity', () => ports.velocity!.check(input))
    if (velocity?.exceeded) {
      // What was observed, recorded as a signal rather than only as a score.
      // Repetition IS firsthand message evidence — we watched the copies arrive
      // — so it belongs in `contentEvidence`, and putting it there is what lets
      // the sender-removal bar below be the same bar every other stage answers
      // to instead of a special case.
      // Spelled out twice rather than computed: a registry test greps the
      // sources for `name: '...'` to prove no catalogued weight is unreachable,
      // and a variable is invisible to it.
      const solo = velocity.singleAuthor === true
      const evidence = velocity.evidence
      // Handed to the classifier as well as weighed here. It decides — its
      // number replaces this score outright — and until 2026-08-26 it decided
      // without ever being told that we had watched the copies arrive.
      if (evidence) observed.repetition = evidence
      if (solo) {
        signals.push(evidence ? { name: 'velocity_repeats', evidence } : { name: 'velocity_repeats' })
      } else {
        signals.push(evidence ? { name: 'velocity_wave', evidence } : { name: 'velocity_wave' })
      }
      /**
       * This stage no longer concludes anything — 2026-08-07, and the audit that
       * retired it is the plainest number in the set: 10 of 52 known false
       * positives came from `velocity`, which is 16% of its 61 verdicts against
       * 0.42% for the deterministic rules. Worst precision in the pipeline for
       * 1.4% of the enforcement.
       *
       * The mechanism, from the reversals themselves: it punished REPETITION,
       * and cross-posting one message to several chats is something ordinary
       * members do — a news link and a university PDF among them, both replayed
       * as `legit_share`. Repetition raises suspicion; it does not identify
       * spam, because the innocent version looks identical from here.
       *
       * Which is the same conclusion the short-circuit was already inching
       * toward before it went (2026-08-02: a settled, already-classified text
       * put to a chat vote seven times because velocity kept answering first).
       * Repetition is a reason to look harder, never a reason to conclude less.
       * So the observation stays — `velocity_repeats` is firsthand content
       * evidence and weighs as such — and the stages that can READ the message
       * decide what it means.
       */
    }
  }

  if (ports.vectors) {
    const match = await safe('vectors', () => ports.vectors!.search(text))
    if (match) {
      // A nearest-neighbour hit may only DECIDE on a text long enough for the
      // distance to mean something. Short strings cluster: two unrelated
      // greetings routinely sit above 0.93 cosine, and this path enforces at
      // 0.92 pSpam — above the mute threshold, with no vote (2026-07-30).
      if (match.similarity >= VECTOR_SIGNAL_SIMILARITY) {
        signals.push({
          name: 'vector_similar_spam',
          evidence: `similarity ${match.similarity.toFixed(2)} (${match.status})`
        })
      }
      if (match.status === 'confirmed' && isDistinctive(text) &&
          match.similarity >= VECTOR_DECIDE_SIMILARITY) {
        const verdict = finalize(
          {
            pSpam: 0.92,
            decidedBy: 'vector',
            ruleId: match.vectorId,
            reasonCode: 'semantic_spam_match',
            reasonEvidence: `similarity ${match.similarity.toFixed(2)}`
          },
          signals
        )
        // `vector_similar_spam` is marked a `resemblance` precisely because a
        // nearest neighbour says the text LOOKS LIKE something rather than that
        // the sender did something — decisive about the message, no part of the
        // case for removing the person. This branch used to mute for a day on
        // that fact alone, so the pipeline held two positions on one piece of
        // evidence and which applied depended only on whether the score cleared
        // 0.93.
        //
        // And when the bar does bite, the hedge is not returned — same reason as
        // velocity above. 2026-08-02, one campaign in one chat inside twelve
        // minutes: six copies removed by the classifier, the signature store and
        // the ban feed, then a seventh variant matched a neighbour and was
        // answered with delete + a question the chat resolved in nine seconds.
        // A stage that recognises a shape must not speak over the stages that
        // read the words.
        if (!removesSender(verdict.action) || mayRemoveSender(signals)) return verdict
      }
    }
  }

  if (ports.moderation) {
    const moderation = await safe('moderation', () =>
      ports.moderation!.check(text, input.enrichment.photoBase64))
    const contentHit = spamModerationHit(moderation)
    if (contentHit !== null) {
      signals.push({ name: 'moderation_flagged', evidence: contentHit })
    }

  }

  // ── 6. score + LLM escalation ───────────────────────────────────────

  const { pSpam: scorePSpam, topContributors, cappedGroups } = scoreSignals(signals)
  meta['scorePSpam'] = Number(scorePSpam.toFixed(4))
  // Calibration telemetry: which correlated groups hit their ceiling. Needed,
  // with `contentEvidence`, to reconstruct a verdict from a log line alone —
  // the 2026-07-30 FP could not be diagnosed from the logs because only the top
  // contributor was recorded. `contentEvidence` itself moved to `finalize` on
  // 2026-08-27, so that the stages concluding before this line record it too.
  if (cappedGroups.length > 0) meta['cappedGroups'] = cappedGroups.join(',')

  // A score resting only on account/profile *shape* (no message-content
  // evidence, no hard verdict) carries no proof the message itself is spam —
  // only that the sender looks suspicious. Such a verdict must never enforce
  // blind: it goes to the LLM (which reads the text) even above the grey
  // ceiling, and if the LLM can't clear it we observe instead of deleting.
  const decisive = hasDecisiveSignal(signals)

  // What arithmetic alone would do, and whether the evidence earns it. The
  // grey ceiling (0.75) happens to sit exactly ON the standard kick threshold,
  // so the band that removes people used to be the one band no content-reading
  // stage ever saw (2026-07-30 FP: a conversational thank-you kicked at 0.77
  // on `signals:sleeper_awakened`, voted ham by the chat in five seconds).
  // Removing the sender is therefore gated on the LLM having actually read the
  // message, unless the message evidence is substantial on its own.
  const scoreDecision = policyFor(scorePSpam, signals)
  const earnedIt = mayRemoveSender(signals)
  const unearnedRemoval = removesSender(scoreDecision.action) && !earnedIt
  /**
   * Any enforcement on thin evidence, not just a removal (2026-07-30 12:34
   * production): a TRUSTED member posting a job ad with a phone number scored
   * 0.80, and because the trust rule caps trusted members at `delete`, the
   * prospective action was not a removal — so the LLM gate stayed shut and the
   * message was deleted on `phone_number` + newness stacking with no stage
   * having read it. Milder than a kick, same defect.
   */
  const unearnedEnforcement = isEnforcementAction(scoreDecision.action) && !earnedIt

  /**
   * The same defect from the other side: evidence enough to remove a sender,
   * arithmetic saying do nothing at all.
   *
   * `unearnedEnforcement` above stops the pipeline ACTING on a sum no stage
   * earned. This stops it STAYING SILENT about a message several stages read and
   * pointed at, because a fact about the account outweighed them. Trust weights
   * are large by design — `established_user` alone is −1.5 — and they are
   * subtracted from the same total the grey floor is measured against, so a
   * member with standing carries a discount that firsthand observation cannot
   * outvote however much of it there is.
   *
   * Measured on the fixture the ceiling tests use, which is drawn from two real
   * reversals: a phone number (1.2) plus repeats we watched arrive (1.5) is 2.7
   * units of firsthand evidence — past `SENDER_REMOVAL_MIN_EVIDENCE` — and
   * scores 0.2689 once standing is applied. Below the floor, so the one stage
   * that can read the message was never asked. The gap had been masked since
   * whenever `sleeper_awakened` started firing on established accounts: that
   * signal's +1.2 lifted exactly this population back over the floor, so
   * removing it (2026-08-24) is what made the hole visible.
   *
   * Escalating is not enforcing. The classifier only produces a reading; every
   * ceiling below it still applies, `capVouchedSession` and `capImitableAct`
   * included, and the same standing that got us here still caps what may follow.
   * The alternative on this branch is not a milder action, it is no look at all.
   */
  const silencedByStanding = scorePSpam < LLM_GREY_LOW && earnedIt
  if (silencedByStanding) meta['escalatedOnEvidence'] = true

  const inGreyZone = scorePSpam >= LLM_GREY_LOW && scorePSpam <= LLM_GREY_HIGH
  const needsLlm = inGreyZone ||
    silencedByStanding ||
    (scorePSpam > LLM_GREY_HIGH && (!decisive || unearnedEnforcement)) ||
    // A low score on an alien script is not a finding, it is an absence of
    // findings: signatures, vectors, custom rules and moderation were all
    // reading a language they were not built for. Asking the one stage that
    // can read it is the difference between clearing a message and never
    // having looked at it (2026-07-31).
    foreignScript !== null
  let llmNeededButUnavailable = false

  if (needsLlm && ports.llm) {
    const llmVerdict: LlmVerdict | null = await safe('llm', () => ports.llm!.classify(input, observed))

    if (llmVerdict) {
      // Recorded whether or not it was a hit: a hit alone proves nothing, and it
      // is the two keys of a MISS that need comparing.
      if (llmVerdict.cacheKey !== undefined) meta['llmKey'] = llmVerdict.cacheKey
      // Which model judged it. The one verdict input that changes without a
      // deploy, and until now the one nothing recorded — see `LlmVerdict.model`.
      if (llmVerdict.model !== undefined) meta['llmModel'] = llmVerdict.model
      if (llmVerdict.promptId !== undefined) meta['llmPrompt'] = llmVerdict.promptId
      /**
       * NOTE — as in the session path, this returns without passing any evidence
       * bar, and the escalation that used to stand in for one is gone.
       *
       * `contentEvidence.strongest` at zero means every other stage read the text
       * and found nothing to point at, so the classifier's word is the entire case
       * for taking the chat away from somebody. That case used to be re-put to a
       * stronger model. Production 2026-08-06/07 is what it costs unguarded: four
       * removals on `contentEvidence: 0`, one of them (12:06:37, scorePSpam 0.0356
       * on an `established_user`) a plain false positive.
       *
       * `capUnearnedRemoval` is the wrong instrument here — see the session path.
       */
      return floorNetworkFact(capImitableAct(finalize(
        {
          pSpam: llmVerdict.pSpam,
          decidedBy: llmVerdict.cached ? 'llm_cached' : 'llm',
          ruleId: null,
          reasonCode: llmVerdict.reasonCode,
          reasonEvidence: llmVerdict.evidence
        },
        signals
      )))
    }
    llmNeededButUnavailable = true
  }

  // ── 7. score-based verdict ──────────────────────────────────────────

  const draft: VerdictDraft = {
    pSpam: scorePSpam,
    decidedBy: 'score',
    ruleId: null,
    reasonCode: topContributors[0] ? `signals:${topContributors[0].name}` : 'no_signals',
    reasonEvidence: null
  }
  const verdict = finalize(draft, signals, scoreDecision)

  // Soft-shape-only guard: the verdict rests purely on account/profile shape,
  // the LLM is the only stage that could justify enforcing on it, and it didn't
  // (unavailable, unconfigured, or — before this branch — it would have cleared
  // the message and returned above). Never delete/mute/ban on shape alone:
  // downgrade to observe. This is the structural fix for the 2026-06-21 FP.
  if (!decisive && isEnforcementAction(verdict.action)) {
    return {
      ...verdict,
      action: 'observe' as VerdictAction,
      needsVote: false,
      banDurationSeconds: null,
      reasonCode: 'soft_shape_only'
    }
  }

  // Content-confirmation cap. Arithmetic wants the sender gone, the message
  // evidence does not earn it, and the LLM — the only stage that reads the
  // text — never answered (unconfigured, rate-limited, or down). Removing a
  // person is not a fail-safe default: downgrade to the message-only action
  // and let the chat weigh in. Reaching this line with `unearnedRemoval` set
  // always means the escalation above found no LLM, since every
  // sender-removing threshold sits inside or above the grey zone.
  if (unearnedRemoval && removesSender(verdict.action)) return capUnearnedRemoval(verdict)

  /**
   * Standing caps a score-decided sender-removal at delete + vote.
   *
   * The two ceilings above this one each cover a slice: `capImitableAct` three
   * reason codes, `capVouchedWindow` two stages. A score verdict on any OTHER
   * reason code had neither, so arithmetic alone could take a vouched member
   * away. Production 2026-08-27 16:46 (found by the 2026-08-28 audit): a
   * municipal-announcements account with 23 consecutive clean rows posted an
   * aid-distribution notice — formatted link, phone number, one loanword — and
   * the stack muted an `established_user` at 0.90. The message evidence was
   * real; the disputed thing was never whether a link is a link, but whether a
   * sum of imitable facts may remove somebody the chat's own history vouches
   * for. Same answer as the other two ceilings: it may delete and ask, not
   * remove. `hasSenderStanding` carries the revoker — an account already caught
   * spamming keeps no standing to spend here — and the LLM path is deliberately
   * not behind this cap: a stage that read the text may still find the thing
   * that standing does not excuse.
   */
  if (removesSender(verdict.action) && hasSenderStanding(signals)) {
    meta['cappedFrom'] = verdict.action
    meta['cappedStanding'] = true
    return {
      ...verdict,
      action: 'delete' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null
    }
  }

  // Fail-safe: when the LLM was needed but unavailable (rate limit, outage),
  // a grey-zone message must never silently pass as clean.
  if (llmNeededButUnavailable && verdict.action === 'none') {
    return { ...verdict, action: 'observe' as VerdictAction, reasonCode: 'llm_unavailable_grey_zone' }
  }

  // Nothing was found, and the sender has not earned the benefit of that doubt.
  //
  // Reaching here with `none` and no message evidence means every stage looked
  // and none of them recognised anything — which is not the same as the message
  // being fine. Whether the LLM gets asked is decided by the score, and the
  // score can only rise on things the other stages recognise, so a text they
  // are all blind to is a text nobody ever reads. It is the argument the
  // foreign-script clause above already makes, in the ordinary case.
  //
  // Production 2026-08-01 15:26, reported by an admin: a five-word solicitation
  // from a newcomer — no link, no phone, no mention, no media — scored 0.27
  // against a grey floor of 0.35, most of the gap being the -0.8 the scorer
  // grants for brevity. Too long for the abstain gate to buffer it (26
  // informative characters against a bar of 20), too quiet for the gate that
  // opens the LLM. Classifiable by our own reckoning, and classified by nobody.
  //
  // The buffer rather than an immediate call: it bounds this to one
  // classification per five messages, and small talk reads as small talk in a
  // blob just as it does alone.
  //
  // There is deliberately no newness test here. Standing is what the question
  // turns on, and this pipeline already has a definition of it — anybody who
  // reaches this line failed `isEstablishedRegular` at the top. Gating on
  // newness instead measured something narrower and let the reply-bait class
  // through: sit in a chat for weeks, wait for somebody to say something is
  // broken, answer with a product name in plain text. No @, no link, nothing to
  // recognise — and the reply itself is worth -1.8 in trust, which is not
  // incidental to the tactic but the whole of it, cancelling the accusing
  // signals almost exactly and landing the score near 0.10.
  //
  // For a sender's FIRST words in a chat the pile is one: waiting for five is
  // waiting forever against join-post-once-gone, and that population is bounded
  // by the join rate.
  if (verdict.action === 'none' && contentEvidence(signals).strongest === 0) {
    const judged = await judgeAccumulated(
      // Not knowing how much somebody has written here is not the same as
      // knowing they have written nothing, and only the second earns the
      // lowered pile. Unknown takes the patient branch.
      input.user.messagesInChat !== null && input.user.messagesInChat <= SESSION_SOLO_MAX_INCHAT
        ? 1
        : SESSION_EVAL_MIN_MESSAGES)
    if (judged) return judged
  }

  /**
   * Last: the run this message belongs to, if it belongs to one.
   *
   * After the session pile rather than before it, because the two ask different
   * questions of overlapping inputs and the pile's is narrower — those messages
   * were unreadable, and reading five of them together is the answer already
   * measured. This one only gets asked when nothing else, including that, has
   * concluded anything, and never about a message the pipeline already acted on.
   */
  if (!isEnforcementAction(verdict.action)) {
    const judged = await judgeBurst(burstWindow)
    if (judged) return judged
  }
  return verdict
}
