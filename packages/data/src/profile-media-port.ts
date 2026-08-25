/**
 * "Have we seen this profile picture on somebody else?"
 *
 * The one question in this pipeline whose answer is a fact rather than a
 * judgement. A campaign buys accounts in batches and dresses them from one
 * folder of photographs; two accounts wearing one photograph are two accounts
 * run by one operator. No weight, threshold or model is involved in establishing
 * that — only whether the bytes describe the same picture.
 *
 * Why this is worth a store of its own rather than another signal computed from
 * what we already have: everything else the pipeline knows about a sender is
 * local to that sender. This is the only place it can notice that two senders
 * are the same person, and it can only notice it by remembering.
 *
 * ── Lookup, and why it is not a single indexed equality ──
 *
 * A re-upload re-encodes, so the hash of the same picture drifts by a few bits
 * (see `DHASH_MATCH_MAX_DISTANCE`). Mongo cannot index Hamming distance, and a
 * collection scan per message is out of the question. So the 64-bit hash is also
 * stored as four indexed 16-bit bands, and a lookup asks for a match in ANY
 * band, then filters the handful of returned rows by true distance in memory.
 *
 * That is the standard pigeonhole trick, and its limit is worth stating: bits
 * that differ spread across bands, so with four bands a distance of up to three
 * is guaranteed to collide in at least one band, while four or five may be
 * missed. Recall is therefore very good rather than perfect — which is the right
 * trade for a signal whose absence costs nothing and whose presence is decisive.
 */
import type { Document } from 'mongodb'
import { hammingDistance, DHASH_MATCH_MAX_DISTANCE, isDegenerateHash } from '@lyadmin/core'
import type { MongoStore } from './mongo.js'

/**
 * How long a picture is remembered.
 *
 * Long enough to outlast a campaign that seeds accounts over weeks before using
 * them, short enough that the store cannot grow without bound on a 512 MB tier —
 * and short enough that a photograph an ordinary person happens to share (a
 * meme, a film still) does not accuse them forever.
 */
export const PROFILE_MEDIA_TTL_DAYS = 60

/** Bands the hash is split into for the any-band lookup. */
const BANDS = 4

/**
 * Rows a lookup will look at. A popular picture — a football crest, a national
 * flag — can be worn by hundreds of accounts, and neither the query nor the
 * distance filter should pay for all of them. The count we report is "at least
 * this many", which is all the signal needs.
 */
const LOOKUP_LIMIT = 40

export interface ProfileMediaMatch {
  /** Distinct OTHER accounts wearing this picture. Never counts the sender. */
  otherAccounts: number
  /** A few of them, for the evidence line. */
  sampleUserIds: number[]
  /** Closest distance found, 0 meaning a byte-identical re-encode. */
  closestDistance: number
}

const bandsOf = (hash: string): string[] => {
  const width = hash.length / BANDS
  const out: string[] = []
  for (let i = 0; i < BANDS; i++) out.push(hash.slice(i * width, (i + 1) * width))
  return out
}

export class MongoProfileMediaPort {
  constructor(private readonly store: MongoStore) {}

  private get collection(): ReturnType<MongoStore['profileMedia']> {
    return this.store.profileMedia()
  }

  /**
   * Record that this account wears this picture, and report who else does.
   *
   * Write first, then read, deliberately: the write is an upsert keyed on
   * (hash, userId), so recording before looking means the answer never includes
   * the sender's own row and no separate exclusion is needed. It also means a
   * crash between the two costs nothing — the fact is stored, and the next
   * message asks again.
   *
   * A degenerate hash is neither stored nor matched. A blank or single-colour
   * avatar collapses to all-zeros and thousands of unrelated accounts share it;
   * storing one would create a row that matches everybody. This is the same
   * defect the text layer shipped three times in 2026-02 (`normalizeHeavy`
   * collapsing every emoji-only message to the hash of the empty string), and
   * the fix is the same: refuse it on the way in.
   */
  async seen(userId: number, hash: string, now = new Date()): Promise<ProfileMediaMatch | null> {
    if (!/^[0-9a-f]{16}$/.test(hash)) return null
    if (isDegenerateHash(hash)) return null

    const bands = bandsOf(hash)
    const doc: Document = {
      hash, userId, lastSeenAt: now,
      b0: bands[0], b1: bands[1], b2: bands[2], b3: bands[3]
    }
    await this.collection.updateOne(
      { hash, userId },
      { $set: doc, $setOnInsert: { firstSeenAt: now } },
      { upsert: true }
    ).catch(() => { /* best-effort: a lost write costs one observation */ })

    const candidates = await this.collection.find(
      { $or: [{ b0: bands[0] }, { b1: bands[1] }, { b2: bands[2] }, { b3: bands[3] }] },
      { projection: { hash: 1, userId: 1 }, limit: LOOKUP_LIMIT }
    ).toArray().catch(() => [])

    const others = new Set<number>()
    let closest = Number.POSITIVE_INFINITY
    for (const row of candidates) {
      const otherId = Number(row['userId'])
      if (!Number.isSafeInteger(otherId) || otherId === userId) continue
      const d = hammingDistance(hash, String(row['hash']))
      if (d === null || d > DHASH_MATCH_MAX_DISTANCE) continue
      others.add(otherId)
      if (d < closest) closest = d
    }
    if (others.size === 0) return null
    return {
      otherAccounts: others.size,
      sampleUserIds: [...others].slice(0, 3),
      closestDistance: closest
    }
  }
}
