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
  flagged: boolean
  categories: string[]
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
}

export interface PipelinePorts {
  signatures?: SignaturePort
  velocity?: VelocityPort
  vectors?: VectorPort
  moderation?: ModerationPort
  llm?: LlmPort
  session?: SessionPort
}
