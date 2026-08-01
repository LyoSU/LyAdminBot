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
import { extractLinkedChannelSignals } from './signals/channel.js'
import { applyDeterministicRules } from './rules.js'
import { parseCustomRule, customRuleMatches } from './custom-rules.js'
import { scoreSignals, hasDecisiveSignal, mayRemoveSender, contentEvidence } from './score.js'
import { PERMANENT_BAN_SIGNALS, isTrustSignal } from './signals/registry.js'
import { decideAction, isEnforcementAction, removesSender, type PolicyDecision } from './policy.js'
import { shouldAbstain } from './text/abstain.js'
import { isForeignScript } from './text/script.js'
import { isDistinctive } from './learning.js'

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
/** One account repeating itself across chats: certain enough to act alone. */
const VELOCITY_PSPAM = 0.9
/**
 * The same text from SEVERAL accounts. Still the strongest content evidence the
 * cheap layers produce, but it is also what a viral line looks like — so it
 * lands in the votable band (delete + ask the chat) instead of the silent
 * 24h mute that 0.9 buys. Deliberately below every preset's mute threshold.
 */
const VELOCITY_WAVE_PSPAM = 0.7
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
 *
 * Standing also has to have taken TIME (2026-07-30 review). The counters are
 * incremented on every message in every chat the bot watches, with no rate or
 * quality condition, so 50 messages of "ок" in a group the spammer controls
 * bought a total bypass of the pipeline — before any port, in all 52 chats. A
 * regular is someone who has been around, not someone who typed a lot this
 * afternoon; `localAgeDays` is the cheapest honest proxy we have, and it is
 * already computed for every sender.
 */
const EXEMPT_INCHAT_MIN = 10
const EXEMPT_GLOBAL_MIN = 50
const EXEMPT_MIN_LOCAL_AGE_DAYS = 7

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

const isEstablishedRegular = (input: EvaluationInput): boolean => {
  const volume = input.user.messagesInChat >= EXEMPT_INCHAT_MIN ||
    input.user.messagesGlobal >= EXEMPT_GLOBAL_MIN
  // An unknown local age (no first-seen recorded) is not evidence of tenure.
  const tenured = input.user.localAgeDays !== null &&
    input.user.localAgeDays >= EXEMPT_MIN_LOCAL_AGE_DAYS
  return volume && tenured && !hasHardAccountVerdict(input.user, input.policy)
}

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
  const policyFor = (pSpam: number, signals: Signal[]): PolicyDecision => decideAction({
    pSpam,
    preset: input.policy.preset,
    chatKind: input.chat.kind,
    captchaEnabled: input.policy.captchaEnabled,
    votingEnabled: input.policy.votingEnabled,
    userIsNewish: isNewish(input),
    userIsTrusted: isTrusted(input),
    userHasHardVerdict: hasHardAccountVerdict(input.user, input.policy),
    ephemeralCaptcha: input.policy.ephemeralCaptcha === true,
    // Grounds for a PERMANENT ban rather than a timed one: the account is
    // known-bad by someone else's verdict, not merely scored badly by us.
    // Everything else expires, so a mistake on our side heals without an
    // admin having to notice it.
    hasPermanentBanGrounds: signals.some((s) => PERMANENT_BAN_SIGNALS.has(s.name))
  })

  const finalize = (draft: VerdictDraft, signals: Signal[], decision?: PolicyDecision): Verdict => {
    const policyDecision = decision ?? policyFor(draft.pSpam, signals)
    meta['portErrors'] = portErrors
    if (portMs.length > 0) meta['portMs'] = portMs.join(',')
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
    return {
      ...verdict,
      action: 'delete' as VerdictAction,
      needsVote: input.policy.votingEnabled,
      banDurationSeconds: null,
      requireCaptcha: input.policy.captchaEnabled && isNewish(input),
      reasonCode: 'content_unconfirmed'
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

  // ── 3. deterministic rules ──────────────────────────────────────────

  const deterministic = applyDeterministicRules(signals)
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
    return verdict
  }

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
      ports.session!.append(input.message.chatId, input.user.id, text))
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
      let llmVerdict = await safe('llm_session', () => ports.llm!.classify(sessionInput, 'cheap'))

      // Concatenated one-liners are the weakest input in the pipeline: they have
      // no structure, no single subject, and by construction no line that meant
      // anything on its own. The cheap tier must not carry the pipeline's
      // strongest authority over them — if arithmetic on its answer would remove
      // the sender, the strong model decides instead (2026-07-30: a two-word
      // conversational message banned at 0.98 on a cheap `flood` verdict).
      if (llmVerdict && removesSender(policyFor(llmVerdict.pSpam, signals).action)) {
        const strong = await safe('llm_session_strong', () => ports.llm!.classify(sessionInput, 'strong'))
        if (strong) llmVerdict = strong
      }

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
    return null
  }

  // A message in an unfamiliar script is never "too little to judge": whatever
  // it says it says in full, and unlike a bare "@user" it is trivially readable
  // — by the LLM, if by nothing else here.
  if (foreignScript === null && shouldAbstain(input.message)) {
    // The full pile, always. A bare "@someone" as a first message is precisely
    // the noise this gate exists to stop asking the model about, so the
    // shortcut below must not reach in here.
    const judged = await judgeAccumulated(SESSION_EVAL_MIN_MESSAGES)
    if (judged) return judged

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
          pSpam: velocity.singleAuthor === true ? VELOCITY_PSPAM : VELOCITY_WAVE_PSPAM,
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
      // A nearest-neighbour hit may only DECIDE on a text long enough for the
      // distance to mean something. Short strings cluster: two unrelated
      // greetings routinely sit above 0.93 cosine, and this path enforces at
      // 0.92 pSpam — above the mute threshold, with no vote (2026-07-30).
      if (match.status === 'confirmed' && isDistinctive(text) &&
          match.similarity >= VECTOR_DECIDE_SIMILARITY) {
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
    const contentHit = spamModerationHit(moderation)
    if (contentHit !== null) {
      signals.push({ name: 'moderation_flagged', evidence: contentHit })
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
    // The picture on the channel the profile points at. Same treatment as the
    // avatar and for the same reason: it says what the account is for, not what
    // this message is, so it may nudge and never convict.
    for (const channel of input.enrichment.linkedChannels) {
      if (!channel.avatarBase64) continue
      const result = await safe('moderation_channel', () =>
        ports.moderation!.check('', channel.avatarBase64))
      const hit = nsfwProfileHit(result)
      if (hit !== null) {
        signals.push({ name: 'nsfw_linked_channel', evidence: `«${channel.title}»: ${hit}` })
        break
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

  const inGreyZone = scorePSpam >= LLM_GREY_LOW && scorePSpam <= LLM_GREY_HIGH
  const needsLlm = inGreyZone ||
    (scorePSpam > LLM_GREY_HIGH && (!decisive || unearnedEnforcement)) ||
    // A low score on an alien script is not a finding, it is an absence of
    // findings: signatures, vectors, custom rules and moderation were all
    // reading a language they were not built for. Asking the one stage that
    // can read it is the difference between clearing a message and never
    // having looked at it (2026-07-31).
    foreignScript !== null
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
  if (unearnedRemoval && removesSender(verdict.action)) return capUnearnedRemoval(verdict)

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
      input.user.messagesInChat <= 1 ? 1 : SESSION_EVAL_MIN_MESSAGES)
    if (judged) return judged
  }
  return verdict
}
