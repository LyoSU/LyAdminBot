/**
 * ForwardPort over the v1 forwardblacklists collection — long-term
 * reputation of forward origins, built from confirmed spam across chats.
 *
 * Byte-compatible with v1 (helpers/velocity.js getForwardHash +
 * database/models/forwardBlacklist.js thresholds), so the reputation both
 * bots accumulated keeps working after cutover.
 */
import { createHash } from 'node:crypto'
import type { Document } from 'mongodb'
import type { ForwardOrigin, ForwardPort, ForwardReputation } from '@lyadmin/core'
import type { MongoStore } from './mongo.js'

/** v1 thresholds: hidden sources are the most suspicious. */
const THRESHOLDS: Record<string, { suspicious: number; blacklisted: number }> = {
  hidden: { suspicious: 3, blacklisted: 6 },
  channel: { suspicious: 5, blacklisted: 10 },
  chat: { suspicious: 5, blacklisted: 10 },
  user: { suspicious: 8, blacklisted: 15 }
}

const EXPIRY_DAYS: Record<ForwardReputation, number> = {
  blacklisted: 180,
  suspicious: 90,
  clean: 30
}

export interface ForwardHashInfo {
  type: 'user' | 'hidden' | 'chat' | 'channel'
  hash: string
  identifier: string
}

/** v1 getForwardHash: sha256("type:identifier") truncated to 16 hex chars. */
export const computeForwardHash = (forward: ForwardOrigin): ForwardHashInfo | null => {
  const type = forward.kind === 'hidden_user' ? 'hidden' : forward.kind
  const identifier = type === 'hidden'
    ? (forward.title?.trim() || 'unknown_hidden')
    : (forward.sourceId != null ? String(forward.sourceId) : '')
  if (!identifier) return null
  const hash = createHash('sha256').update(`${type}:${identifier}`).digest('hex').substring(0, 16)
  return { type, hash, identifier }
}

/** v1 status math: clean reports counteract spam reports at 2:1. */
export const forwardStatusFor = (
  type: string,
  spamReports: number,
  cleanReports: number
): ForwardReputation => {
  const thresholds = THRESHOLDS[type] ?? THRESHOLDS['user']!
  const effectiveSpam = Math.max(0, spamReports - Math.floor(cleanReports / 2))
  if (effectiveSpam >= thresholds.blacklisted) return 'blacklisted'
  if (effectiveSpam >= thresholds.suspicious) return 'suspicious'
  return 'clean'
}

export class MongoForwardPort implements ForwardPort {
  constructor(private readonly store: MongoStore) {}

  private get collection() {
    return this.store.forwardBlacklist
  }

  async check(forward: ForwardOrigin): Promise<ForwardReputation | null> {
    const info = computeForwardHash(forward)
    if (!info) return null
    const doc = await this.collection.findOne(
      { forwardHash: info.hash },
      { projection: { status: 1, spamReports: 1, cleanReports: 1, forwardType: 1 } }
    ) as Document | null
    if (!doc) return null
    // Recompute instead of trusting the stored status — older v1 records
    // may predate clean-report adjustments.
    return forwardStatusFor(
      String(doc['forwardType'] ?? info.type),
      Number(doc['spamReports'] ?? 0),
      Number(doc['cleanReports'] ?? 0)
    )
  }

  /** Confirmed spam carried this forward: count it and refresh status/TTL. */
  async reportSpam(forward: ForwardOrigin, chatId: number, sampleText: string | null): Promise<void> {
    const info = computeForwardHash(forward)
    if (!info) return
    const doc = await this.collection.findOneAndUpdate(
      { forwardHash: info.hash },
      {
        $inc: { spamReports: 1 },
        $set: { lastSeenAt: new Date(), forwardType: info.type },
        $addToSet: { uniqueGroups: chatId },
        $setOnInsert: {
          forwardHash: info.hash,
          sourceIdentifier: info.identifier.slice(0, 64),
          firstSeenAt: new Date(),
          ...(sampleText ? { sampleText: sampleText.slice(0, 200) } : {})
        }
      } as never,
      { upsert: true, returnDocument: 'after' }
    ) as Document | null
    if (doc) await this.refreshStatus(info.hash, info.type, doc)
  }

  /** Admin override on a forwarded message: the source gets a clean point. */
  async reportClean(forward: ForwardOrigin): Promise<void> {
    const info = computeForwardHash(forward)
    if (!info) return
    const doc = await this.collection.findOneAndUpdate(
      { forwardHash: info.hash },
      { $inc: { cleanReports: 1 } },
      { returnDocument: 'after' }
    ) as Document | null
    if (doc) await this.refreshStatus(info.hash, info.type, doc)
  }

  private async refreshStatus(hash: string, fallbackType: string, doc: Document): Promise<void> {
    const status = forwardStatusFor(
      String(doc['forwardType'] ?? fallbackType),
      Number(doc['spamReports'] ?? 0),
      Number(doc['cleanReports'] ?? 0)
    )
    if (doc['status'] === status) return
    await this.collection.updateOne(
      { forwardHash: hash },
      { $set: { status, expiresAt: new Date(Date.now() + EXPIRY_DAYS[status] * 86400 * 1000) } }
    )
  }
}
