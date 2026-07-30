/**
 * Pipeline ports — the only doors through which IO enters the core.
 * Adapters/data implement these; tests and the replay tool fake them.
 *
 * Contract for every port: returning null means "stage unavailable /
 * no answer" and the pipeline continues gracefully. Ports should not
 * throw; if they do, the pipeline treats it as null and counts the error.
 */
import type { EvaluationInput } from './types.js'

export interface SignatureMatch {
  /** confirmed = human/override-verified; candidate = self-learned. */
  status: 'confirmed' | 'candidate'
  pSpam: number
  signatureId: string
}

export interface SignaturePort {
  match(text: string): Promise<SignatureMatch | null>
}

export interface VelocityResult {
  exceeded: boolean
  /**
   * Every copy came from ONE account. That is a blast, and nothing legitimate
   * looks like it. Several accounts carrying the same text may equally be a
   * multi-account campaign or a line that went viral, so the pipeline treats
   * that case as strong evidence in need of a human, not as a certainty.
   * Absent means "unknown" and is read conservatively (as a wave).
   */
  singleAuthor?: boolean
  evidence?: string
}

export interface VelocityPort {
  /** Sliding-window duplicate / flood detection across chats. */
  check(input: EvaluationInput): Promise<VelocityResult | null>
}

export interface VectorMatch {
  similarity: number
  status: 'confirmed' | 'candidate'
  vectorId: string
}

export interface VectorPort {
  /** Semantic nearest-spam search (embeddings). */
  search(text: string): Promise<VectorMatch | null>
}

export interface ModerationResult {
  /** Provider's own aggregate flag — recall-tuned, so a weak indicator. */
  flagged: boolean
  categories: string[]
  /**
   * Per-category confidence, 0..1. The aggregate `flagged` boolean fires on
   * ANY category above the provider's own (deliberately low) threshold, which
   * made profile-media screening fire on stylised art holding a weapon. Callers
   * that need precision must read the score of the categories they care about
   * instead of trusting `flagged`. Empty when the provider exposes no scores.
   */
  scores: Record<string, number>
}

export interface ModerationPort {
  check(text: string, photoBase64: string | null): Promise<ModerationResult | null>
}

export type LlmTier = 'cheap' | 'strong'

export interface LlmVerdict {
  pSpam: number
  /** Stable reason code (NOT free-form model text). */
  reasonCode: string
  evidence: string | null
  cached: boolean
}

export interface LlmPort {
  classify(input: EvaluationInput, tier: LlmTier): Promise<LlmVerdict | null>
}

export interface SessionWindow {
  /** All buffered texts of this user in this chat, newline-joined. */
  combinedText: string
  count: number
}

export interface SessionPort {
  /** Append an abstained message and return the accumulated window. */
  append(chatId: number, userId: number, text: string): Promise<SessionWindow>
  /**
   * Discard the window. Required, not optional: a port without it silently
   * turns the session path into repeated re-judgements of the same accumulated
   * text, which is the failure this interface change exists to prevent.
   */
  reset(chatId: number, userId: number): Promise<void>
}

/** Long-term reputation of a forward origin (v1 forwardblacklists). */
export type ForwardReputation = 'clean' | 'suspicious' | 'blacklisted'

export type ForwardOrigin = NonNullable<EvaluationInput['message']['forward']>

export interface ForwardPort {
  check(forward: ForwardOrigin): Promise<ForwardReputation | null>
}

export interface PipelinePorts {
  signatures?: SignaturePort
  velocity?: VelocityPort
  vectors?: VectorPort
  moderation?: ModerationPort
  llm?: LlmPort
  session?: SessionPort
  forwards?: ForwardPort
}
