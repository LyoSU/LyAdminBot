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
 * ── Lookup: an exact hash match, and why that is enough ──
 *
 * A re-upload re-encodes, so in principle the hash of the same picture can drift
 * a few bits and the lookup should tolerate that. In practice, measured on real
 * avatars 2026-08-25, it does not have to:
 *
 *  - Both re-use clusters found among 17 accounts this bot had banned were
 *    BYTE-IDENTICAL files — same SHA-256, not merely the same picture.
 *  - dHash is itself robust to the transformations that matter. The same
 *    photograph at 640px and at 320px hashes identically, and so does the same
 *    photograph at quality 35 and 84. The hash only drifted at 160px, which is
 *    smaller than any avatar Telegram serves.
 *
 * So the fuzzy lookup would have bought nothing on the observed data while
 * costing real space: tolerating drift means indexing four 16-bit bands per row,
 * which is four index entries per document — more index than document, on a
 * deployment that was at 401 MB of a 512 MB tier when this was written.
 *
 * An exact match needs no band index at all: the unique `{hash, userId}` index
 * that keeps one row per account per picture has `hash` as its prefix, so it
 * already serves the query. Two functional indexes, zero extra.
 *
 * The cost of being wrong about this is one missed signal, never a false one —
 * and it is recoverable: if production shows near-miss re-encodes, bands can be
 * added later without touching anything else here.
 */
import type { Document } from 'mongodb'
import { isDegenerateHash } from '@lyadmin/core'
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
}

/**
 * Senders whose current picture is already recorded, so the hot path is a read
 * and not a write.
 *
 * In memory and per process, deliberately: losing it costs one redundant upsert,
 * and the alternative — asking Mongo whether we need to write to Mongo — is the
 * write it was meant to avoid. Cleared wholesale rather than per entry, because
 * this is a cost cache and not a correctness one.
 */
const RECENT_WRITE_MAX = 5000

export class MongoProfileMediaPort {
  private readonly recentlyWritten = new Set<string>()

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

    const key = `${userId}:${hash}`
    if (!this.recentlyWritten.has(key)) {
      const doc: Document = { hash, userId, lastSeenAt: now }
      await this.collection.updateOne(
        { hash, userId },
        { $set: doc, $setOnInsert: { firstSeenAt: now } },
        { upsert: true }
      ).catch(() => { /* best-effort: a lost write costs one observation */ })
      if (this.recentlyWritten.size >= RECENT_WRITE_MAX) this.recentlyWritten.clear()
      this.recentlyWritten.add(key)
    }

    // Served by the `{hash, userId}` index on its `hash` prefix.
    const rows = await this.collection.find(
      { hash },
      { projection: { userId: 1 }, limit: LOOKUP_LIMIT }
    ).toArray().catch(() => [])

    const others = new Set<number>()
    for (const row of rows) {
      const otherId = Number(row['userId'])
      // The sender's own row is in here by construction — the write above put it
      // there. Counting it would make every first sighting match itself.
      if (!Number.isSafeInteger(otherId) || otherId === userId) continue
      others.add(otherId)
    }
    if (others.size === 0) return null
    return { otherAccounts: others.size, sampleUserIds: [...others].slice(0, 3) }
  }
}
