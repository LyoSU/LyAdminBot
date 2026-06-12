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
import { hasTextualContent } from '@lyadmin/core'

const SPAM_COLLECTION = 'spam_vectors'
const EMBEDDING_MODEL = 'text-embedding-3-small'
const SEARCH_LIMIT = 3
const MIN_REPORTABLE_SIMILARITY = 0.8
const CONFIRMED_HIT_COUNT = 3
const CONFIRMED_CONFIDENCE = 90

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
}

export class QdrantVectorPort implements VectorPort {
  private readonly qdrant: QdrantClient
  private readonly openai: OpenAI

  constructor(config: QdrantVectorPortConfig) {
    this.qdrant = new QdrantClient(
      config.qdrantApiKey !== undefined
        ? { url: config.qdrantUrl, apiKey: config.qdrantApiKey }
        : { url: config.qdrantUrl }
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

    for (const point of results) {
      const payload = (point.payload ?? {}) as SpamPayload
      if (payload.disabledAt) continue
      if (point.score < MIN_REPORTABLE_SIMILARITY) continue
      const confirmed =
        payload.status === 'confirmed' ||
        (payload.hitCount ?? 0) >= CONFIRMED_HIT_COUNT ||
        (payload.confidence ?? 0) >= CONFIRMED_CONFIDENCE
      return {
        similarity: point.score,
        status: confirmed ? 'confirmed' : 'candidate',
        vectorId: String(point.id)
      }
    }
    return null
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
