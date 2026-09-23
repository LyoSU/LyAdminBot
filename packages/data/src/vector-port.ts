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
import { hasTextualContent, isDistinctive, isMachineLearnSource, truncate, CORROBORATING_CHATS_MIN } from '@lyadmin/core'
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
  /** Distinct chats that reported this text; absent on v1 points. */
  chats?: number[]
  /** Chats that switched this point off for themselves (`hasNetworkVoice`). */
  suppressedIn?: number[]
  /** A person (vote, report) has called this text spam; see `isMachineLearnSource`. */
  humanConfirmed?: boolean
}

export class QdrantVectorPort implements VectorPort {
  private readonly qdrant: QdrantClient
  private readonly openai: OpenAI

  constructor(config: QdrantVectorPortConfig) {
    // checkCompatibility:false silences the client/server version mismatch
    // warning — the REST surface we use (upsert/query/scroll) is stable
    // across these minor versions.
    this.qdrant = new QdrantClient(
      config.qdrantApiKey !== undefined
        ? { url: config.qdrantUrl, apiKey: config.qdrantApiKey, checkCompatibility: false }
        : { url: config.qdrantUrl, checkCompatibility: false }
    )
    this.openai = new OpenAI({ apiKey: config.openaiApiKey })
  }

  async search(text: string, chatId?: number): Promise<VectorMatch | null> {
    // Emoji-only / low-info texts produce degenerate embeddings that
    // false-match each other — the v1 collision bug. Hard guard.
    if (!hasTextualContent(text)) return null

    const embedding = await this.embed(text)
    if (!embedding) return null

    // `query` is the universal endpoint; the client dropped `search` in 1.19.
    // Same request, same scored points, one level deeper in the answer.
    const { points } = await this.qdrant.query(SPAM_COLLECTION, {
      query: embedding,
      limit: SEARCH_LIMIT,
      with_payload: true,
      filter: {
        must: [{ key: 'classification', match: { value: 'spam' } }],
        must_not: [{ is_empty: { key: 'classification' } }]
      }
    })

    const nowUnix = Math.floor(Date.now() / 1000)
    for (const point of points) {
      const payload = (point.payload ?? {}) as SpamPayload
      if (payload.disabledAt) continue
      if (chatId !== undefined && Array.isArray(payload.suppressedIn) && payload.suppressedIn.includes(chatId)) continue
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
    status: 'candidate' | 'confirmed' = 'candidate',
    chatId?: number
  ): Promise<'candidate' | 'confirmed' | null> {
    if (!hasTextualContent(text)) return null
    if (!isDistinctive(text)) return null
    const embedding = await this.embed(text)
    if (!embedding) return null
    const now = Date.now()
    const id = pointIdFor(text)

    /**
     * The same corroboration rule the signature layer applies, for the same
     * reason and now from the same constant: one chat reporting a text is one
     * observation however many times it repeats it, and a semantic rule is
     * blunter than a hash, so it must earn the deciding tier rather than be
     * handed it. The read is needed because the point id is derived from the
     * text — every learn upserts the same point, so without it a later
     * candidate would overwrite what a second chat established.
     */
    //
    // A failed read is not "never learned": the upsert below replaces the
    // whole point, so writing blind would erase a retirement or another chat's
    // corroboration. Best-effort means skipping, not guessing.
    const existing = await this.qdrant.retrieve(SPAM_COLLECTION, { ids: [id], with_payload: true })
      .catch(() => null)
    if (existing === null) return null
    const previous = (existing[0]?.payload ?? undefined) as SpamPayload | undefined
    // Retirement is an admin's correction and outlives any later automatic
    // verdict on the same text; the full-point upsert used to drop `disabledAt`
    // and bring the point back `confirmed` (2026-09-23 review). The signature
    // layer keeps the same rule by never unsetting its own `disabledAt`.
    if (previous?.disabledAt) return null
    const chats = new Set<number>(
      Array.isArray(previous?.chats) ? previous.chats.filter((c) => typeof c === 'number') : []
    )
    if (chatId !== undefined) chats.add(chatId)
    // Two chats AND a person among the reporters — the signature port's rule.
    const humanConfirmed = !isMachineLearnSource(source) || previous?.humanConfirmed === true
    const corroborated = chats.size >= CORROBORATING_CHATS_MIN && humanConfirmed
    const effective: 'candidate' | 'confirmed' =
      status === 'confirmed' || corroborated || previous?.status === 'confirmed'
        ? 'confirmed'
        : 'candidate'
    try {
      await this.qdrant.upsert(SPAM_COLLECTION, {
        points: [{
          id,
          vector: embedding,
          payload: {
            classification: 'spam',
            status: effective,
            source,
            chats: [...chats],
            ...(humanConfirmed ? { humanConfirmed: true } : {}),
            // Carried across the full-point upsert, or a chat's own retirement
            // would come back to life the way `disabledAt` did.
            ...(Array.isArray(previous?.suppressedIn) ? { suppressedIn: previous.suppressedIn } : {}),
            ...(effective === 'confirmed'
              ? { hitCount: CONFIRMED_HIT_COUNT, confidence: CONFIRMED_CONFIDENCE }
              : {}),
            createdAt: new Date(now).toISOString(),
            expiresAtUnix: Math.floor(now / 1000) + LEARNED_TTL_DAYS * 86_400
          }
        }]
      })
      return effective
    } catch {
      // Best-effort, mirrors signaturePort.learn — and null says so, rather
      // than letting the caller log a rule that was never written.
      return null
    }
  }

  /**
   * Stop a learned point from ever matching again.
   *
   * `search` has skipped points carrying `disabledAt` since this port was
   * written, and until 2026-08-22 nothing anywhere wrote one — a read with no
   * writer, so a vector generating false positives could not be retired by
   * anybody, admin included. The signature layer had the equivalent from the
   * start (`disabledAt` on the signature document, honoured by `match`), and
   * this is its twin.
   *
   * No lookup: `pointIdFor` derives the id from the text, so retiring addresses
   * exactly the point `learn` would have written. That also means the two must
   * keep agreeing, which is what the test pins.
   *
   * The payload is set rather than the point deleted, so the record of what was
   * once believed survives for calibration replay — the same reason the
   * signature is demoted to `candidate` instead of being removed.
   */
  async retire(text: string, onlyIn?: number): Promise<void> {
    const id = pointIdFor(text)
    try {
      if (onlyIn === undefined) {
        await this.qdrant.setPayload(SPAM_COLLECTION, {
          payload: { disabledAt: new Date().toISOString() },
          points: [id]
        })
        return
      }
      // Scoped to the admin's chat (`hasNetworkVoice`). `setPayload` replaces
      // the key, so the list is read and extended rather than written blind.
      const existing = await this.qdrant.retrieve(SPAM_COLLECTION, { ids: [id], with_payload: true })
      const previous = (existing[0]?.payload ?? undefined) as SpamPayload | undefined
      if (!previous) return
      const suppressedIn = Array.isArray(previous.suppressedIn) ? previous.suppressedIn : []
      if (suppressedIn.includes(onlyIn)) return
      await this.qdrant.setPayload(SPAM_COLLECTION, {
        payload: { suppressedIn: [...suppressedIn, onlyIn] },
        points: [id]
      })
    } catch { /* nothing learned for this text, or Qdrant is down — best-effort */ }
  }

  private async embed(text: string): Promise<number[] | null> {
    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        // `truncate`, not `.slice()`: an orphaned surrogate half makes the whole
        // request unencodable and the API refuses it (2026-08-07). Here that was
        // the worst case of the three — the catch below returns null, so a long
        // message cut mid-emoji simply had no vector, forever, with no log line.
        input: truncate(text, 4000)
      })
      return response.data[0]?.embedding ?? null
    } catch {
      return null
    }
  }
}
