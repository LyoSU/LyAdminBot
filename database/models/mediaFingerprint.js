const mongoose = require('mongoose')

/**
 * MediaFingerprint — persistent cross-chat / cross-user media tracking.
 *
 * Telegram's `file_unique_id` is a stable identifier for the underlying file
 * bytes: the SAME file forwarded by different accounts into different chats
 * keeps the same `file_unique_id`. This makes it a very cheap "same media?"
 * question without needing to download or hash anything ourselves.
 *
 * Spam networks almost always reuse media (promo photos, voice drops,
 * sticker sets, document carriers). A single fingerprint appearing across
 * 3+ chats from 2+ "different" users within a day is a near-certainty
 * coordinated campaign.
 *
 * We store:
 *   - the fingerprint (indexed, unique)
 *   - mediaType (for threshold differentiation — voice/video_note almost
 *     never repeat between humans; stickers repeat all the time)
 *   - capped sets of unique user IDs and chat IDs that posted this file
 *   - first/last seen timestamps
 *   - occurrences counter
 *
 * TTL: 30 days on lastSeenAt — old media are "forgotten" so a one-shot
 * repost years apart doesn't trip the detector, and the collection stays
 * bounded.
 *
 * Design notes:
 *   - uniqueUsers / uniqueChats are CAPPED arrays (20 each). Telegram scams
 *     rarely span >20 users/chats before we've already detected them; the cap
 *     keeps the doc size bounded in the worst case (viral legit content).
 *   - Atomic upsert via $addToSet + $inc so concurrent messages from the
 *     same fingerprint don't race.
 */

const MEDIA_TYPES = [
  'photo', 'video', 'voice', 'video_note', 'animation',
  'sticker', 'document', 'audio'
]

const UNIQUE_CAP = 20

const mediaFingerprintSchema = mongoose.Schema({
  fileUniqueId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  mediaType: {
    type: String,
    enum: MEDIA_TYPES,
    required: true,
    index: true
  },
  occurrences: {
    type: Number,
    default: 0
  },
  uniqueUsers: {
    type: [Number],
    default: []
  },
  uniqueChats: {
    type: [Number],
    default: []
  },
  firstSeenAt: {
    type: Date,
    default: Date.now
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // TTL: auto-delete 30 days after the LAST sighting so long-dormant
  // fingerprints don't stay forever. Important: when lastSeenAt is bumped
  // by recordSighting, expiresAt is also bumped — a still-active fingerprint
  // is never evicted mid-campaign.
  expiresAt: {
    type: Date,
    default: function () {
      return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    },
    index: { expires: 0 }
  },
  // Optional flag set once the fingerprint crossed a spam threshold — lets
  // us short-circuit future sightings without recomputing.
  flaggedAsSpam: { type: Boolean, default: false }
}, {
  timestamps: true
})

mediaFingerprintSchema.index({ mediaType: 1, occurrences: -1 })

/**
 * Record a new sighting of this fingerprint. Atomic — safe under concurrent
 * messages of the same file from many chats.
 *
 * Returns the updated document so callers can read uniqueUsers.length /
 * uniqueChats.length to decide whether velocity crossed a threshold.
 */
mediaFingerprintSchema.statics.recordSighting = async function ({
  fileUniqueId,
  mediaType,
  userId,
  chatId
}) {
  if (!fileUniqueId || !mediaType) return null
  if (!MEDIA_TYPES.includes(mediaType)) return null

  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const now = new Date()

  // Atomic upsert: increment occurrences, add to uniqueUsers/uniqueChats
  // sets, bump lastSeenAt + expiresAt. Caps are enforced post-hoc because
  // MongoDB's $addToSet doesn't support $slice directly alongside it in
  // older driver versions — we read back and, if over cap, prune in one
  // follow-up write (rare path).
  const updateOps = {
    $inc: { occurrences: 1 },
    $set: {
      mediaType,
      lastSeenAt: now,
      expiresAt: newExpiresAt
    },
    $setOnInsert: {
      fileUniqueId,
      firstSeenAt: now
    }
  }
  if (typeof userId === 'number') updateOps.$addToSet = Object.assign({}, updateOps.$addToSet, { uniqueUsers: userId })
  if (typeof chatId === 'number') updateOps.$addToSet = Object.assign({}, updateOps.$addToSet, { uniqueChats: chatId })

  const entry = await this.findOneAndUpdate(
    { fileUniqueId },
    updateOps,
    { upsert: true, new: true }
  )

  // Enforce caps. We only prune if over cap; in the common case this is
  // a no-op. Keep the MOST RECENT entries (tail of the array).
  let needSave = false
  if (Array.isArray(entry.uniqueUsers) && entry.uniqueUsers.length > UNIQUE_CAP) {
    entry.uniqueUsers = entry.uniqueUsers.slice(-UNIQUE_CAP)
    needSave = true
  }
  if (Array.isArray(entry.uniqueChats) && entry.uniqueChats.length > UNIQUE_CAP) {
    entry.uniqueChats = entry.uniqueChats.slice(-UNIQUE_CAP)
    needSave = true
  }
  if (needSave) {
    try {
      await entry.save()
    } catch (_err) {
      // Swallow — not critical if prune lost a race with another writer.
    }
  }
  return entry
}

/**
 * Thresholds for declaring a fingerprint "spam velocity" exceeded.
 * Per-type because natural reuse rates differ wildly:
 *   sticker/animation — humans re-send stickers constantly
 *   voice/video_note  — humans almost never re-send the same bytes
 *   photo/video       — moderate, depends on image content
 */
const VELOCITY_THRESHOLDS = {
  voice: { minChats: 2, minUsers: 2 },
  video_note: { minChats: 2, minUsers: 2 },
  audio: { minChats: 2, minUsers: 2 },
  video: { minChats: 3, minUsers: 2 },
  document: { minChats: 3, minUsers: 2 },
  photo: { minChats: 3, minUsers: 3 },
  animation: { minChats: 5, minUsers: 4 },
  sticker: { minChats: 10, minUsers: 8 }
}

mediaFingerprintSchema.statics.VELOCITY_THRESHOLDS = VELOCITY_THRESHOLDS

/**
 * Classify a fingerprint as spam-velocity or not, given its current sighting
 * counts. Used by callers after recordSighting.
 *
 * Returns { exceeded: boolean, reason: string, chats: number, users: number }
 */
mediaFingerprintSchema.statics.classifyVelocity = function (entry) {
  if (!entry) return { exceeded: false, reason: null, chats: 0, users: 0 }
  const thresholds = VELOCITY_THRESHOLDS[entry.mediaType]
  if (!thresholds) return { exceeded: false, reason: null, chats: 0, users: 0 }
  const chats = Array.isArray(entry.uniqueChats) ? entry.uniqueChats.length : 0
  const users = Array.isArray(entry.uniqueUsers) ? entry.uniqueUsers.length : 0
  if (chats >= thresholds.minChats && users >= thresholds.minUsers) {
    return {
      exceeded: true,
      reason: `Same ${entry.mediaType} sent by ${users} users in ${chats} chats`,
      chats,
      users
    }
  }
  return { exceeded: false, reason: null, chats, users }
}

mediaFingerprintSchema.statics.MEDIA_TYPES = MEDIA_TYPES
mediaFingerprintSchema.statics.UNIQUE_CAP = UNIQUE_CAP

module.exports = mediaFingerprintSchema
