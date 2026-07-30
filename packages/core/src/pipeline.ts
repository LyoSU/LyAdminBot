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
import type { EvaluationInput, Signal, Verdict, VerdictAction, DecidedBy, UserSnapshot, ChatPolicy } from './types.js'
import type { LlmVerdict, PipelinePorts } from './ports.js'
import { extractMessageSignals } from './signals/message.js'
import { extractUserSignals } from './signals/user.js'
import { extractBioSignals } from './signals/bio.js'
import { applyDeterministicRules } from './rules.js'
import { parseCustomRule, customRuleMatches } from './custom-rules.js'
import { scoreSignals, hasDecisiveSignal, mayRemoveSender, contentEvidence } from './score.js'
import { decideAction, isEnforcementAction, removesSender, type PolicyDecision } from './policy.js'
import { shouldAbstain } from './text/abstain.js'

const LLM_GREY_LOW = 0.35
const LLM_GREY_HIGH = 0.75
const SESSION_EVAL_MIN_MESSAGES = 5
const VECTOR_DECIDE_SIMILARITY = 0.93
/**
 * Below this, a nearest-neighbour hit is noise and must not raise a signal.
 * The port answers with whatever is closest, so without a floor every message
 * carried `vector_similar_spam` — which (once the signal finally got a weight)
 * would have added score to everything equally.
 */
const VECTOR_SIGNAL_SIMILARITY = 0.85
const VELOCITY_PSPAM = 0.9
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

/** Sexual-category confidence above the profile threshold, if any. */
const nsfwProfileHit = (result: { scores: Record<string, number> } | null): string | null => {
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
 * Grounds for a PERMANENT ban rather than a timed one: the account is
 * known-bad by someone else's verdict (Telegram's own flags, an external ban
 * database), not merely scored badly by us. Everything else expires, so a
 * mistake on our side heals without an admin having to notice it.
 */
const PERMANENT_BAN_SIGNALS = new Set([
  'scam_flag', 'fake_flag', 'external_ban', 'restricted_for_spam'
])

/** How new does a user have to be for ban-eligibility / captcha gating. */
const isNewish = (input: EvaluationInput): boolean =>
  input.user.messagesInChat <= 3 ||
  input.user.messagesGlobal <= 5 ||
  (input.user.localAgeDays !== null && input.user.localAgeDays <= 7)

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
 * across our chats both count. Thresholds are conservative — the global bar
 * matches ESTABLISHED_MIN_MESSAGES (50) from signal extraction.
 */
const EXEMPT_INCHAT_MIN = 10
const EXEMPT_GLOBAL_MIN = 50

/**
 * Hard account verdicts that cancel the exempt: facts that mark the account as
 * already-known-bad or compromised, all readable from the UserSnapshot with no
 * port call. "Established regular" must not shield a CAS-banned account or one
 * with prior confirmed spam — that would be the exact hole the threat model
 * (a sold/compromised long-time account) warns about.
 *
 * `spamDetections` needs TWO hits, not one (2026-07-27). A single past
 * detection may itself have been a false positive, and stripping the exempt
 * on it made every FP permanently compound into the next evaluation. Two
 * independent detections are a pattern; one is an accusation.
 */
const HARD_VERDICT_MIN_DETECTIONS = 2

const hasHardAccountVerdict = (u: UserSnapshot, policy: ChatPolicy): boolean =>
  u.flags.scam ||
  u.flags.fake ||
  (policy.externalBanEnabled && u.externalBan?.banned === true) ||
  u.spamDetections >= HARD_VERDICT_MIN_DETECTIONS ||
  u.reputationStatus === 'restricted' ||
  u.reputationStatus === 'suspicious' ||
  u.unofficialClientRisk === true ||
  u.restrictionReasons.some((r) => /spam|scam/i.test(r))

const isEstablishedRegular = (input: EvaluationInput): boolean =>
  (input.user.messagesInChat >= EXEMPT_INCHAT_MIN ||
    input.user.messagesGlobal >= EXEMPT_GLOBAL_MIN) &&
  !hasHardAccountVerdict(input.user, input.policy)

interface VerdictDraft {
  pSpam: number
  decidedBy: DecidedBy
  ruleId: string | null
  reasonCode: string
  reasonEvidence: string | null
}

export const evaluateMessage = async (
  input: EvaluationInput,
  ports: PipelinePorts
): Promise<Verdict> => {
  const meta: Record<string, string | number | boolean> = {}
  let portErrors = 0

  /** Run a port call; failures degrade to null and are counted. */
  const safe = async <T>(label: string, call: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await call()
    } catch {
      portErrors += 1
      meta[`portError_${label}`] = true
      return null
    }
  }

  /**
   * What the policy would do with this probability. Exposed separately from
   * `finalize` because the LLM gate has to know the *prospective* action before
   * deciding whether the message may be judged on arithmetic alone.
   */
  const policyFor = (pSpam: number, signals: Signal[]): PolicyDecision => decideAction({
    pSpam,
    preset: input.policy.preset,
    chatKind: input.chat.kind,
    captchaEnabled: input.policy.captchaEnabled,
    votingEnabled: input.policy.votingEnabled,
    userIsNewish: isNewish(input),
    userIsTrusted: isTrusted(input),
    ephemeralCaptcha: input.policy.ephemeralCaptcha === true,
    hasPermanentBanGrounds: signals.some((s) => PERMANENT_BAN_SIGNALS.has(s.name))
  })

  const finalize = (draft: VerdictDraft, signals: Signal[], decision?: PolicyDecision): Verdict => {
    const policyDecision = decision ?? policyFor(draft.pSpam, signals)
    meta['portErrors'] = portErrors
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

  // ── 1b. established-regular fast path ───────────────────────────────
  // Runs AFTER custom rules (an admin DENY/ALLOW always wins) but BEFORE any
  // heuristic or paid port: an established member skips the whole ladder.
  if (isEstablishedRegular(input)) {
    meta['established_regular'] = true
    meta['messagesInChat'] = input.user.messagesInChat
    meta['messagesGlobal'] = input.user.messagesGlobal
    return none('deterministic', 'established_regular')
  }

  // ── 2. signals ──────────────────────────────────────────────────────

  const signals: Signal[] = [
    ...extractMessageSignals(input.message),
    ...extractUserSignals(input.user),
    ...extractBioSignals(input.enrichment.bio)
  ]
  // Chat-level trusted list is equivalent to trusted reputation.
  if (input.policy.trustedUserIds.includes(input.user.id) &&
      !signals.some((s) => s.name === 'trusted_reputation')) {
    signals.push({ name: 'trusted_reputation', negative: true })
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

  // ── 3. deterministic rules ──────────────────────────────────────────

  const deterministic = applyDeterministicRules(signals)
  if (deterministic) {
    if (deterministic.kind === 'clean') {
      return none('deterministic', deterministic.ruleId, signals)
    }
    return finalize(
      {
        pSpam: deterministic.pSpam,
        decidedBy: 'deterministic',
        ruleId: deterministic.ruleId,
        reasonCode: deterministic.ruleId,
        reasonEvidence: signals.find((s) => !s.negative)?.evidence ?? null
      },
      signals
    )
  }

  // ── 4. abstain gate + session window ────────────────────────────────

  if (shouldAbstain(input.message)) {
    const window = ports.session
      ? await safe('session', () => ports.session!.append(input.message.chatId, input.user.id, text))
      : null

    if (window && window.count >= SESSION_EVAL_MIN_MESSAGES && ports.llm) {
      // The accumulated window may read as spam even when each line alone
      // is unclassifiable ("пиши мені" / "в особисті" / "заробіток" …).
      const sessionInput: EvaluationInput = {
        ...input,
        message: { ...input.message, text: window.combinedText }
      }
      const llmVerdict = await safe('llm_session', () => ports.llm!.classify(sessionInput, 'cheap'))
      if (llmVerdict) {
        return finalize(
          {
            pSpam: llmVerdict.pSpam,
            decidedBy: 'session',
            ruleId: null,
            reasonCode: llmVerdict.reasonCode,
            reasonEvidence: llmVerdict.evidence
          },
          signals
        )
      }
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
      return finalize(
        {
          pSpam: 0.95,
          decidedBy: 'forward',
          ruleId: 'forward_blacklist',
          reasonCode: 'forward_blacklist',
          reasonEvidence: input.message.forward.title
        },
        signals
      )
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

  if (ports.velocity) {
    const velocity = await safe('velocity', () => ports.velocity!.check(input))
    if (velocity?.exceeded) {
      return finalize(
        {
          pSpam: VELOCITY_PSPAM,
          decidedBy: 'velocity',
          ruleId: 'velocity_exceeded',
          reasonCode: 'velocity_exceeded',
          reasonEvidence: velocity.evidence ?? null
        },
        signals
      )
    }
  }

  if (ports.vectors) {
    const match = await safe('vectors', () => ports.vectors!.search(text))
    if (match) {
      if (match.status === 'confirmed' && match.similarity >= VECTOR_DECIDE_SIMILARITY) {
        return finalize(
          {
            pSpam: 0.92,
            decidedBy: 'vector',
            ruleId: match.vectorId,
            reasonCode: 'semantic_spam_match',
            reasonEvidence: `similarity ${match.similarity.toFixed(2)}`
          },
          signals
        )
      }
      if (match.similarity >= VECTOR_SIGNAL_SIMILARITY) {
        signals.push({
          name: 'vector_similar_spam',
          evidence: `similarity ${match.similarity.toFixed(2)} (${match.status})`
        })
      }
    }
  }

  if (ports.moderation) {
    const moderation = await safe('moderation', () =>
      ports.moderation!.check(text, input.enrichment.photoBase64))
    if (moderation?.flagged) {
      signals.push({ name: 'moderation_flagged', evidence: moderation.categories.join(', ') })
    }

    // Profile-media NSFW. Avatar/stories are only downloaded for newish
    // senders, so these signals are new-account signals by construction —
    // a porn avatar on a fresh account is the classic escort/promo bot.
    // Unlike message content, profile media is judged on the sexual
    // categories' own confidence (see NSFW_PROFILE_MIN_SCORE): an avatar is
    // not evidence about the message, so it may only nudge, never convict.
    if (input.enrichment.avatarBase64) {
      const avatar = await safe('moderation_avatar', () =>
        ports.moderation!.check('', input.enrichment.avatarBase64))
      const hit = nsfwProfileHit(avatar)
      if (hit !== null) signals.push({ name: 'nsfw_avatar', evidence: hit })
    }
    if (input.enrichment.storyBase64.length > 0) {
      const hits = new Set<string>()
      for (const story of input.enrichment.storyBase64) {
        const result = await safe('moderation_story', () => ports.moderation!.check('', story))
        const hit = nsfwProfileHit(result)
        if (hit !== null) hits.add(hit)
      }
      if (hits.size > 0) {
        signals.push({ name: 'nsfw_stories', evidence: [...hits].join(', ') })
      }
    }
  }

  // ── 6. score + LLM escalation ───────────────────────────────────────

  const { pSpam: scorePSpam, topContributors, cappedGroups } = scoreSignals(signals)
  meta['scorePSpam'] = Number(scorePSpam.toFixed(4))
  // Calibration telemetry: how much of the score was earned by the message
  // itself, and which correlated groups hit their ceiling. Both are needed to
  // reconstruct a verdict from a log line alone — the 2026-07-30 FP could not
  // be diagnosed from the logs because only the top contributor was recorded.
  meta['contentEvidence'] = contentEvidence(signals).total
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
  const unearnedRemoval = removesSender(scoreDecision.action) && !mayRemoveSender(signals)

  const inGreyZone = scorePSpam >= LLM_GREY_LOW && scorePSpam <= LLM_GREY_HIGH
  const needsLlm = inGreyZone ||
    (scorePSpam > LLM_GREY_HIGH && (!decisive || unearnedRemoval))
  let llmNeededButUnavailable = false

  if (needsLlm && ports.llm) {
    let llmVerdict: LlmVerdict | null =
      await safe('llm_cheap', () => ports.llm!.classify(input, 'cheap'))
    meta['llmTier'] = 'cheap'

    if (llmVerdict && llmVerdict.pSpam >= LLM_GREY_LOW && llmVerdict.pSpam <= LLM_GREY_HIGH) {
      const strong = await safe('llm_strong', () => ports.llm!.classify(input, 'strong'))
      if (strong) {
        llmVerdict = strong
        meta['llmTier'] = 'strong'
      }
    }

    if (llmVerdict) {
      return finalize(
        {
          pSpam: llmVerdict.pSpam,
          decidedBy: llmVerdict.cached ? 'llm_cached' : 'llm',
          ruleId: null,
          reasonCode: llmVerdict.reasonCode,
          reasonEvidence: llmVerdict.evidence
        },
        signals
      )
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
  if (unearnedRemoval && removesSender(verdict.action)) {
    meta['cappedFrom'] = verdict.action
    return {
      ...verdict,
      action: 'delete' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null,
      // What replaces the removal: the message goes, and the sender is asked to
      // prove they are human. A spam bot cannot; the person we were wrong about
      // taps once. Pointless for a long-standing member, so it is gated on the
      // same newness the removal itself required.
      requireCaptcha: input.policy.captchaEnabled && isNewish(input),
      reasonCode: 'content_unconfirmed'
    }
  }

  // Fail-safe: when the LLM was needed but unavailable (rate limit, outage),
  // a grey-zone message must never silently pass as clean.
  if (llmNeededButUnavailable && verdict.action === 'none') {
    return { ...verdict, action: 'observe' as VerdictAction, reasonCode: 'llm_unavailable_grey_zone' }
  }
  return verdict
}
