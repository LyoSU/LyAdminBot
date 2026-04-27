const { spam: spamLog } = require('./logger')
const { dhashFromFileId, hammingDistance } = require('./image-hash')

/**
 * Media fingerprint helper — extraction + DB-backed velocity lookup.
 *
 * Telegram's `file_unique_id` is a stable identifier for the underlying
 * file bytes across forwards. By persisting every sighting (user, chat,
 * mediaType) we can answer "has this exact file been posted by other
 * users in other chats recently?" — a near-perfect test for coordinated
 * spam campaigns that rely on shared promo media.
 *
 * Unlike the in-memory `velocity` store, this data survives restarts, so
 * a week-long campaign cannot be "laundered" by forcing the bot to crash
 * and lose state.
 *
 * Behaviour:
 *   - `extractFingerprint(message)` → { fileUniqueId, mediaType } | null
 *       Canonical (mediaType, id) pair chosen by specificity (voice wins
 *       over video, video_note over video, etc). Photos always use the
 *       LARGEST size variant so reposts at any resolution dedup correctly.
 *   - `recordAndAssess(db, message, { userId, chatId })`
 *       Writes the sighting and returns the velocity verdict. Safe to
 *       call on every group message — the write is O(1) and indexed.
 *
 * Storage (see models/mediaFingerprint.js):
 *   - One document per unique fileUniqueId
 *   - Capped uniqueUsers[20] / uniqueChats[20] arrays
 *   - 30d TTL on lastSeenAt (sliding window — active campaigns don't expire)
 */

/**
 * Canonical mediaType + id extraction.
 *
 * Order is important: specific > generic (voice before audio; video_note
 * before video; animation before document). Photo uses the LARGEST size
 * variant to ensure reposts at different compression levels collide on
 * the same fingerprint.
 *
 * Returns null for messages that carry no supported media.
 */
const extractFingerprint = (message) => {
  if (!message || typeof message !== 'object') return null

  if (message.voice && message.voice.file_unique_id) {
    return { mediaType: 'voice', fileUniqueId: message.voice.file_unique_id }
  }
  if (message.video_note && message.video_note.file_unique_id) {
    return { mediaType: 'video_note', fileUniqueId: message.video_note.file_unique_id }
  }
  if (message.audio && message.audio.file_unique_id) {
    return { mediaType: 'audio', fileUniqueId: message.audio.file_unique_id }
  }
  if (message.video && message.video.file_unique_id) {
    return { mediaType: 'video', fileUniqueId: message.video.file_unique_id }
  }
  if (message.animation && message.animation.file_unique_id) {
    return { mediaType: 'animation', fileUniqueId: message.animation.file_unique_id }
  }
  if (message.sticker && message.sticker.file_unique_id) {
    return { mediaType: 'sticker', fileUniqueId: message.sticker.file_unique_id }
  }
  if (message.document && message.document.file_unique_id) {
    return { mediaType: 'document', fileUniqueId: message.document.file_unique_id }
  }
  if (message.photo && message.photo.length > 0) {
    // Telegram returns photo sizes in ascending order — last is largest.
    const largest = message.photo[message.photo.length - 1]
    if (largest && largest.file_unique_id) {
      return { mediaType: 'photo', fileUniqueId: largest.file_unique_id }
    }
  }
  return null
}

/**
 * Persist a sighting and return the velocity classification.
 *
 * @param {Object} db        ctx.db (must have MediaFingerprint)
 * @param {Object} message   Telegram message
 * @param {Object} meta      { userId, chatId }
 * @returns {Promise<null | {
 *   fileUniqueId: string,
 *   mediaType: string,
 *   occurrences: number,
 *   uniqueUsers: number,
 *   uniqueChats: number,
 *   velocityExceeded: boolean,
 *   velocityReason: string|null,
 *   firstSeenAt: Date,
 *   isNew: boolean
 * }>}
 */
const recordAndAssess = async (db, message, { userId, chatId, telegram }) => {
  if (!db || !db.MediaFingerprint) return null
  const fp = extractFingerprint(message)
  if (!fp) return null

  try {
    // Detect freshness: we compare firstSeenAt to the response time.
    // Useful for log "is this the first time we've seen this file?"
    const before = Date.now()
    const entry = await db.MediaFingerprint.recordSighting({
      fileUniqueId: fp.fileUniqueId,
      mediaType: fp.mediaType,
      userId,
      chatId
    })
    if (!entry) return null

    const verdict = db.MediaFingerprint.classifyVelocity(entry)

    // For images (photo + animation) also compute a perceptual hash on
    // FIRST sighting — so future reuploads by different accounts dedup
    // against the visual content even when file_unique_id differs.
    // We only hash on first sighting to avoid repeated work: once a
    // fingerprint exists, subsequent sightings share the same pHash.
    let perceptualHash = entry.perceptualHash || null
    let perceptualClusterSize = null
    let perceptualMatched = null
    if (telegram && (fp.mediaType === 'photo' || fp.mediaType === 'animation')) {
      if (!perceptualHash) {
        try {
          const fileIdForHash = fp.mediaType === 'photo'
            ? (message.photo[message.photo.length - 1].file_id)
            : (message.animation && message.animation.file_id)
          const h = await dhashFromFileId(telegram, fileIdForHash)
          if (h) {
            entry.perceptualHash = h
            perceptualHash = h
            await entry.save().catch(() => {})
          }
        } catch (_err) { /* non-fatal */ }
      }
      // Near-duplicate scan: look for other recent fingerprints of same
      // media type whose pHash is within Hamming 10 bits.
      if (perceptualHash) {
        const nearby = await db.MediaFingerprint.find({
          mediaType: fp.mediaType,
          perceptualHash: { $exists: true, $ne: null },
          fileUniqueId: { $ne: fp.fileUniqueId }
        })
          .sort({ lastSeenAt: -1 })
          .limit(500)
          .select('perceptualHash uniqueUsers uniqueChats fileUniqueId')
          .lean()
        for (const other of nearby) {
          if (hammingDistance(perceptualHash, other.perceptualHash) <= 10) {
            const otherUsers = (other.uniqueUsers || []).length
            const otherChats = (other.uniqueChats || []).length
            perceptualClusterSize = otherUsers + (entry.uniqueUsers || []).length
            perceptualMatched = { fileUniqueId: other.fileUniqueId, otherUsers, otherChats }
            break
          }
        }
      }
    }

    return {
      fileUniqueId: fp.fileUniqueId,
      mediaType: fp.mediaType,
      occurrences: entry.occurrences || 0,
      uniqueUsers: (entry.uniqueUsers || []).length,
      uniqueChats: (entry.uniqueChats || []).length,
      velocityExceeded: verdict.exceeded,
      velocityReason: verdict.reason,
      firstSeenAt: entry.firstSeenAt,
      perceptualHash,
      perceptualClusterSize,
      perceptualMatched,
      // Heuristic "isNew": if firstSeenAt is within the same request window
      // we treat this as the first sighting (99% of the time correct).
      isNew: entry.occurrences === 1 ||
        (entry.firstSeenAt && Math.abs(new Date(entry.firstSeenAt).getTime() - before) < 200)
    }
  } catch (err) {
    spamLog.warn({ err, fileUniqueId: fp.fileUniqueId }, 'MediaFingerprint record failed')
    return null
  }
}

module.exports = {
  extractFingerprint,
  recordAndAssess
}
