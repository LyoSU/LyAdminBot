/**
 * VectorPort: semantic nearest-spam search. OpenAI embeddings
 * (text-embedding-3-small, same model as v1 — vectors stay compatible)
 * + the existing Qdrant spam_vectors collection.
 *
 * Status mapping for points written by v1 (which had no status field):
 * confirmed = explicitly marked OR seen often enough to be cross-verified.
 */
import { QdrantClient } from '@qdrant/js-client-rest'
import OpenAI from 'openai'
import type { VectorMatch, VectorPort } from '@lyadmin/core'
import { hasTextualContent, isDistinctive } from '@lyadmin/core'
import { sha256 } from './hashing.js'

/** Deterministic point id from the text, so re-learning the same spam upserts
 * the same point instead of piling up duplicate vectors. */
const pointIdFor = (text: string): string => {
  const h = sha256(text)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const SPAM_COLLECTION = 'spam_vectors'
const EMBEDDING_MODEL = 'text-embedding-3-small'
const SEARCH_LIMIT = 3
const MIN_REPORTABLE_SIMILARITY = 0.8
const CONFIRMED_HIT_COUNT = 3
const CONFIRMED_CONFIDENCE = 90

/** Learned points stop deciding after this; a campaign that is still live
 * gets re-learned and its expiry pushed out. v1 points carry no expiry field
 * and are therefore unaffected. */
const LEARNED_TTL_DAYS = 90

export interface QdrantVectorPortConfig {
  qdrantUrl: string
  qdrantApiKey?: string | undefined
  openaiApiKey: string
}

interface SpamPayload {
  classification?: string
  confidence?: number
  hitCount?: number
  status?: string
  disabledAt?: string
  /** Unix seconds; absent on v1 points, which never expire. */
  expiresAtUnix?: number
}

export class QdrantVectorPort implements VectorPort {
  private readonly qdrant: QdrantClient
  private readonly openai: OpenAI

  constructor(config: QdrantVectorPortConfig) {
    // checkCompatibility:false silences the client/server version mismatch
    // warning — the REST surface we use (upsert/search/scroll) is stable
    // across these minor versions.
    this.qdrant = new QdrantClient(
      config.qdrantApiKey !== undefined
        ? { url: config.qdrantUrl, apiKey: config.qdrantApiKey, checkCompatibility: false }
        : { url: config.qdrantUrl, checkCompatibility: false }
    )
    this.openai = new OpenAI({ apiKey: config.openaiApiKey })
  }

  async search(text: string): Promise<VectorMatch | null> {
    // Emoji-only / low-info texts produce degenerate embeddings that
    // false-match each other — the v1 collision bug. Hard guard.
    if (!hasTextualContent(text)) return null

    const embedding = await this.embed(text)
    if (!embedding) return null

    const results = await this.qdrant.search(SPAM_COLLECTION, {
      vector: embedding,
      limit: SEARCH_LIMIT,
      with_payload: true,
      filter: {
        must: [{ key: 'classification', match: { value: 'spam' } }],
        must_not: [{ is_empty: { key: 'classification' } }]
      }
    })

    const nowUnix = Math.floor(Date.now() / 1000)
    for (const point of results) {
      const payload = (point.payload ?? {}) as SpamPayload
      if (payload.disabledAt) continue
      if (typeof payload.expiresAtUnix === 'number' && payload.expiresAtUnix < nowUnix) continue
      if (point.score < MIN_REPORTABLE_SIMILARITY) continue
      // `confidence >= 90` used to count as confirmation. That field comes from
      // v1's own LLM verdicts — including its false positives, which is what v2
      // exists to stop — so an unvetted v1 point could silently mute people at
      // 0.92 with no vote. Only an explicit status or repeated independent hits
      // confirm now; everything else is a candidate, i.e. a signal the rest of
      // the pipeline weighs (2026-07-30 review).
      const confirmed =
        payload.status === 'confirmed' ||
        (payload.hitCount ?? 0) >= CONFIRMED_HIT_COUNT
      return {
        similarity: point.score,
        status: confirmed ? 'confirmed' : 'candidate',
        vectorId: String(point.id)
      }
    }
    return null
  }

  /**
   * Self-learning ingest: embed a spam text and upsert it, so the vector layer
   * learns alongside signatures instead of staying frozen at its v1 state.
   * Best-effort: a failed embed/upsert never throws into the moderation path.
   *
   * Two guards that were missing (2026-07-30 review). Every learned point used
   * to be written `confirmed` with no expiry — even from `learnFromAutoVerdict`,
   * which writes signatures as mere candidates, and even for a two-word text.
   * A semantic rule is far blunter than a hash: it must earn the same
   * confirmation as a signature, be distinctive enough for cosine distance to
   * mean anything, and age out if the campaign stops.
   */
  async learn(
    text: string,
    source: string,
    status: 'candidate' | 'confirmed' = 'candidate'
  ): Promise<void> {
    if (!hasTextualContent(text)) return
    if (!isDistinctive(text)) return
    const embedding = await this.embed(text)
    if (!embedding) return
    const now = Date.now()
    try {
      await this.qdrant.upsert(SPAM_COLLECTION, {
        points: [{
          id: pointIdFor(text),
          vector: embedding,
          payload: {
            classification: 'spam',
            status,
            source,
            ...(status === 'confirmed'
              ? { hitCount: CONFIRMED_HIT_COUNT, confidence: CONFIRMED_CONFIDENCE }
              : {}),
            createdAt: new Date(now).toISOString(),
            expiresAtUnix: Math.floor(now / 1000) + LEARNED_TTL_DAYS * 86_400
          }
        }]
      })
    } catch { /* best-effort, mirrors signaturePort.learn */ }
  }

  private async embed(text: string): Promise<number[] | null> {
    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 4000)
      })
      return response.data[0]?.embedding ?? null
    } catch {
      return null
    }
  }
}
