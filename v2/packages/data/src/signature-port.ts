/**
 * SignaturePort over the v1 spamsignatures collection. Matching layers:
 * exactHash (light-normalized) then normalizedHash (heavy template).
 * Confirmed signatures decide; candidates only contribute a signal —
 * exactly the contract the core pipeline expects.
 */
import type { Document } from 'mongodb'
import type { SignatureMatch, SignaturePort } from '@lyadmin/core'
import type { MongoStore } from './mongo.js'
import { computeSignatureHashes } from './hashing.js'

const CONFIRMED_PSPAM = 0.96

interface SignatureDoc extends Document {
  status?: 'candidate' | 'confirmed'
  disabledAt?: Date
}

export class MongoSignaturePort implements SignaturePort {
  constructor(private readonly store: MongoStore) {}

  async match(text: string): Promise<SignatureMatch | null> {
    const hashes = computeSignatureHashes(text)
    if (!hashes) return null

    const query: Document[] = [{ exactHash: hashes.exactHash }]
    if (hashes.normalizedHash) query.push({ normalizedHash: hashes.normalizedHash })

    const doc = await this.store.spamSignatures.findOne(
      { $or: query, disabledAt: { $exists: false } },
      { projection: { status: 1 }, sort: { status: -1 } } // 'confirmed' > 'candidate'
    ) as SignatureDoc | null
    if (!doc) return null

    return {
      status: doc.status === 'confirmed' ? 'confirmed' : 'candidate',
      pSpam: CONFIRMED_PSPAM,
      signatureId: String(doc._id)
    }
  }

  /** Self-learning ingest: store a confirmed-spam text (threat feed / cross-group confirmation). */
  async learn(text: string, source: string, status: 'candidate' | 'confirmed' = 'candidate'): Promise<void> {
    const hashes = computeSignatureHashes(text)
    if (!hashes) return
    const ttlDays = status === 'confirmed' ? 90 : 30
    await this.store.spamSignatures.updateOne(
      { exactHash: hashes.exactHash },
      {
        $setOnInsert: {
          exactHash: hashes.exactHash,
          normalizedHash: hashes.normalizedHash,
          sampleText: text.slice(0, 200),
          source,
          status,
          firstSeenAt: new Date(),
          expiresAt: new Date(Date.now() + ttlDays * 86400 * 1000)
        },
        $set: { lastSeenAt: new Date() },
        $inc: { confirmations: 1 }
      },
      { upsert: true }
    )
  }
}
