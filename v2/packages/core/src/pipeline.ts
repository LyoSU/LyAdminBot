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
import type { LlmVerdict, PipelinePorts } from './ports.js'
import { extractMessageSignals } from './signals/message.js'
import { extractUserSignals } from './signals/user.js'
import { applyDeterministicRules } from './rules.js'
import { scoreSignals } from './score.js'
import { decideAction, type PolicyDecision } from './policy.js'
import { shouldAbstain } from './text/abstain.js'

const LLM_GREY_LOW = 0.35
const LLM_GREY_HIGH = 0.75
const SESSION_EVAL_MIN_MESSAGES = 5
const VECTOR_DECIDE_SIMILARITY = 0.93
const VELOCITY_PSPAM = 0.9
const CUSTOM_DENY_PSPAM = 0.96

/** How new does a user have to be for ban-eligibility / captcha gating. */
const isNewish = (input: EvaluationInput): boolean =>
  input.user.messagesInChat <= 3 ||
  input.user.messagesGlobal <= 5 ||
  (input.user.localAgeDays !== null && input.user.localAgeDays <= 7)

const isTrusted = (input: EvaluationInput): boolean =>
  input.policy.trustedUserIds.includes(input.user.id) ||
  input.user.reputationStatus === 'trusted'

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

  const finalize = (draft: VerdictDraft, signals: Signal[], decision?: PolicyDecision): Verdict => {
    const policyDecision = decision ?? decideAction({
      pSpam: draft.pSpam,
      preset: input.policy.preset,
      chatKind: input.chat.kind,
      captchaEnabled: input.policy.captchaEnabled,
      votingEnabled: input.policy.votingEnabled,
      userIsNewish: isNewish(input),
      userIsTrusted: isTrusted(input)
    })
    meta['portErrors'] = portErrors
    return {
      pSpam: draft.pSpam,
      action: policyDecision.action,
      needsVote: policyDecision.needsVote,
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
      { action: 'none', needsVote: false }
    )

  // ── 1. gates ────────────────────────────────────────────────────────

  if (!input.policy.enabled) return none('abstain', 'spam_check_disabled')

  const text = input.message.text ?? ''
  const lowerText = text.toLowerCase()
  for (const [index, rule] of input.policy.customRules.entries()) {
    const match = /^(ALLOW|DENY)\s*:\s*(.+)$/i.exec(rule.trim())
    if (!match) continue
    const pattern = (match[2] ?? '').trim().toLowerCase()
    if (!pattern || !lowerText.includes(pattern)) continue
    if ((match[1] ?? '').toUpperCase() === 'ALLOW') {
      return none('custom_rule', 'custom_allow')
    }
    return finalize(
      {
        pSpam: CUSTOM_DENY_PSPAM,
        decidedBy: 'custom_rule',
        ruleId: `custom:${index}`,
        reasonCode: 'custom_deny',
        reasonEvidence: pattern
      },
      []
    )
  }

  // ── 2. signals ──────────────────────────────────────────────────────

  const signals: Signal[] = [
    ...extractMessageSignals(input.message),
    ...extractUserSignals(input.user)
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
      { action: 'observe', needsVote: false }
    )
  }

  // ── 5. knowledge ports ──────────────────────────────────────────────

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
      signals.push({
        name: 'vector_similar_spam',
        evidence: `similarity ${match.similarity.toFixed(2)} (${match.status})`
      })
    }
  }

  if (ports.moderation) {
    const moderation = await safe('moderation', () =>
      ports.moderation!.check(text, input.enrichment.photoBase64))
    if (moderation?.flagged) {
      signals.push({ name: 'moderation_flagged', evidence: moderation.categories.join(', ') })
    }
  }

  // ── 6. score + LLM escalation ───────────────────────────────────────

  const { pSpam: scorePSpam, topContributors } = scoreSignals(signals)
  meta['scorePSpam'] = Number(scorePSpam.toFixed(4))

  const inGreyZone = scorePSpam >= LLM_GREY_LOW && scorePSpam <= LLM_GREY_HIGH
  let llmNeededButUnavailable = false

  if (inGreyZone && ports.llm) {
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
  const verdict = finalize(draft, signals)

  // Fail-safe: when the LLM was needed but unavailable (rate limit, outage),
  // a grey-zone message must never silently pass as clean.
  if (llmNeededButUnavailable && verdict.action === 'none') {
    return { ...verdict, action: 'observe' as VerdictAction, reasonCode: 'llm_unavailable_grey_zone' }
  }
  return verdict
}
