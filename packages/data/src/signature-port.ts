/**
 * SignaturePort over the v1 spamsignatures collection. Matching layers:
 * exactHash (light-normalized) then normalizedHash (heavy template).
 * Confirmed signatures decide; candidates only contribute a signal —
 * exactly the contract the core pipeline expects.
 */
import type { Document } from 'mongodb'
import type { SignatureMatch, SignaturePort } from '@lyadmin/core'
import { truncate } from '@lyadmin/core'
import { isDistinctive } from '@lyadmin/core'
import type { MongoStore } from './mongo.js'
import { computeSignatureHashes, normalizeHeavy } from './hashing.js'

const CONFIRMED_PSPAM = 0.96

/** Distinct chats that must have reported a text before it may decide alone. */
const CORROBORATING_CHATS_MIN = 2

const TTL_DAYS: Record<'candidate' | 'confirmed', number> = { candidate: 30, confirmed: 90 }

const expiryFor = (status: 'candidate' | 'confirmed', now: Date): Date =>
  new Date(now.getTime() + TTL_DAYS[status] * 86_400_000)

/**
 * Placeholders `normalizeHeavy` substitutes for variable parts. A template made
 * mostly of these carries almost no information: "заходь @_ _URL_" matches an
 * innocent "заходь @vasya youtu.be/x" exactly as well as the promo it came
 * from, which is why the length guard has to be applied to what is left AFTER
 * the placeholders are removed, not to the raw text (2026-07-30 review).
 */
const TEMPLATE_PLACEHOLDERS = /_URL_|_NUM_|_CUR_|@_/g

export const templateLiteralLength = (text: string): number =>
  normalizeHeavy(text).replace(TEMPLATE_PLACEHOLDERS, '').replace(/\s+/g, ' ').trim().length

/**
 * Greeting-length guard. The prod corpus is partly poisoned by velocity
 * waves of innocent-looking short texts — in v1 a two-word morning greeting
 * earned people auto-bans. A signature this short must never decide on its own —
 * it stays a candidate-strength signal and the pipeline weighs the rest.
 */
const MIN_DECIDE_LENGTH = 25

interface SignatureDoc extends Document {
  status?: 'candidate' | 'confirmed'
  exactHash?: string
  normalizedHash?: string
  disabledAt?: Date
}

export class MongoSignaturePort implements SignaturePort {
  constructor(private readonly store: MongoStore) {}

  async match(text: string): Promise<SignatureMatch | null> {
    const hashes = computeSignatureHashes(text)
    if (!hashes) return null

    const query: Document[] = [{ exactHash: hashes.exactHash }]
    if (hashes.normalizedHash) query.push({ normalizedHash: hashes.normalizedHash })
    if (hashes.foldedHash) query.push({ foldedHash: hashes.foldedHash })

    const doc = await this.store.spamSignatures.findOne(
      { $or: query, disabledAt: { $exists: false } },
      { projection: { status: 1, exactHash: 1, normalizedHash: 1 }, sort: { status: -1 } } // 'confirmed' > 'candidate'
    ) as SignatureDoc | null
    if (!doc) return null

    // How specific was the match? An exact hash is the text itself. A
    // normalized hash is a TEMPLATE, and a template's information content is
    // what survives after the placeholders — so that is what gets measured.
    const viaExactHash = doc.exactHash === hashes.exactHash
    const viaNormalizedHash = hashes.normalizedHash !== null &&
      doc.normalizedHash === hashes.normalizedHash
    // Reached only after confusables were folded together. The fold is lossy on
    // purpose — that is how it survives a homoglyph rotation — so it may raise a
    // signal and must never decide on its own, whatever the stored status says.
    const viaFoldOnly = !viaExactHash && !viaNormalizedHash
    const specificEnough = viaExactHash
      ? text.trim().length >= MIN_DECIDE_LENGTH
      : templateLiteralLength(text) >= MIN_DECIDE_LENGTH
    const decisive = doc.status === 'confirmed' && specificEnough && !viaFoldOnly
    return {
      status: decisive ? 'confirmed' : 'candidate',
      pSpam: CONFIRMED_PSPAM,
      signatureId: String(doc._id)
    }
  }

  /**
   * Retire whatever signature this text matches, by the text rather than by id.
   *
   * `recordOverride` already disables the signature an admin overruled, but only
   * when it was the DECIDER (`decidedBy === 'signature'`, via its `ruleId`). A
   * candidate that merely contributed `signature_candidate_match` to an LLM
   * verdict never appears as the decider, so it survived the correction and went
   * on matching the next person. Looking it up by text catches both, and needs
   * no id to have been recorded.
   *
   * Demoted, not deleted, for the same reason `recordOverride` demotes: a
   * signature fires in every chat for ninety days, so its history is worth
   * keeping for calibration replay even once it is switched off.
   *
   * Authority is the caller's business — this is reachable only from the admin
   * override path. A chat's own ballot is not authority over the network (see
   * `recordOverride`), and nothing here changes that.
   */
  async retire(text: string): Promise<void> {
    const hashes = computeSignatureHashes(text)
    if (!hashes) return
    // The same three layers `match` searches, in the same order — a signature
    // reachable by the lookup must be reachable by the retirement.
    const query: Document[] = [{ exactHash: hashes.exactHash }]
    if (hashes.normalizedHash) query.push({ normalizedHash: hashes.normalizedHash })
    if (hashes.foldedHash) query.push({ foldedHash: hashes.foldedHash })
    await this.store.spamSignatures.updateOne(
      { $or: query },
      { $set: { status: 'candidate', disabledAt: new Date(), disabledBy: 'admin_override' } }
    ).catch(() => { /* a missing signature is fine */ })
  }

  /**
   * Self-learning ingest: store a spam text (vote, threat feed, auto-verdict).
   *
   * Three things this deliberately does NOT do the obvious way (2026-07-30
   * review found each of them broken):
   *
   *  - `status` and `expiresAt` used to live under `$setOnInsert`, so a
   *    candidate could be re-reported a hundred times and never become
   *    confirmed, while an actively-circulating campaign still expired 30 days
   *    after its FIRST sighting. Both now move on every learn.
   *  - promotion is earned by *independent* corroboration, not by repetition:
   *    the same account re-posting the same text in the same chat is one
   *    observation. `chats` is a set, and it takes two of them.
   *  - a caller may ask for `confirmed`, but only a distinctive text gets it.
   *    A deciding rule matched on a greeting is how v1 auto-banned people.
   */
  async learn(
    text: string,
    source: string,
    status: 'candidate' | 'confirmed' = 'candidate',
    chatId?: number
  ): Promise<void> {
    const hashes = computeSignatureHashes(text)
    if (!hashes) return

    const distinctive = isDistinctive(text)
    const now = new Date()
    const doc = await this.store.spamSignatures.findOneAndUpdate(
      { exactHash: hashes.exactHash },
      {
        $setOnInsert: {
          exactHash: hashes.exactHash,
          normalizedHash: hashes.normalizedHash,
          sampleText: truncate(text, 200),
          source,
          firstSeenAt: now
        },
        // `$set`, not `$setOnInsert`: the field is derived from the same text
        // that produced `exactHash`, so rewriting it is idempotent — and that is
        // what backfills the signatures (v1's included) stored before this layer
        // existed, on their next sighting.
        $set: { lastSeenAt: now, foldedHash: hashes.foldedHash },
        $inc: { confirmations: 1 },
        ...(chatId === undefined ? {} : { $addToSet: { chats: chatId } })
      },
      { upsert: true, returnDocument: 'after', projection: { chats: 1, status: 1 } }
    ) as { chats?: number[]; status?: string } | null

    // Independent corroboration: two different chats reporting the same text is
    // evidence a single (possibly mistaken) reporter cannot provide. Repetition
    // by the same reporter in the same chat is ONE observation, not two.
    const corroborated = (doc?.chats?.length ?? 0) >= CORROBORATING_CHATS_MIN
    const earned = status === 'confirmed' || corroborated || doc?.status === 'confirmed'
    const effective: 'candidate' | 'confirmed' = earned && distinctive ? 'confirmed' : 'candidate'

    // Status and expiry are rewritten on every sighting, never $setOnInsert: a
    // candidate has to be able to graduate, and a live campaign must not expire
    // on the clock of its first appearance.
    await this.store.spamSignatures.updateOne(
      { exactHash: hashes.exactHash },
      { $set: { status: effective, expiresAt: expiryFor(effective, now) } }
    )
  }
}
