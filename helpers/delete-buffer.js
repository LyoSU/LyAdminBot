// In-memory snapshot buffer for /del undo (§7 of the UX design).
//
// Before the bot deletes a target message, we stash its content here so
// an admin can click `[↩️ Відновити]` to re-send it from the bot. TTL is
// 30 seconds — long enough to catch the "oh wait, wrong message"
// scenario, short enough that stale snapshots don't pile up.
//
// Keyed by `<chatId>:<messageId>` because a message id is only unique
// within its chat. `max: 1000` caps memory even if every group in our
// cluster del-s simultaneously.

const { LRUCache } = require('lru-cache')

const TTL_MS = 30 * 1000
const MAX_ENTRIES = 1000

const cache = new LRUCache({ max: MAX_ENTRIES, ttl: TTL_MS, ttlAutopurge: false })

const keyOf = (chatId, messageId) => `${chatId}:${messageId}`

/**
 * Extract the fields we need to reconstruct the message. Skip nothing —
 * the restore path inspects these and picks the right sendXxx API. We
 * intentionally only keep file_ids, not the binary content; Telegram
 * keeps the file alive long enough for any reasonable undo window.
 */
const snapshot = (msg) => {
  if (!msg || typeof msg !== 'object') return null
  const record = {
    messageId: msg.message_id,
    from: msg.from
      ? {
        id: msg.from.id,
        first_name: msg.from.first_name,
        last_name: msg.from.last_name,
        username: msg.from.username
      }
      : null,
    text: msg.text,
    caption: msg.caption,
    entities: msg.entities,
    caption_entities: msg.caption_entities
  }

  if (msg.photo && msg.photo.length > 0) {
    // Pick the largest thumbnail — Telegram stores multiple sizes.
    record.photoFileId = msg.photo[msg.photo.length - 1].file_id
  }
  if (msg.document) record.documentFileId = msg.document.file_id
  if (msg.video) record.videoFileId = msg.video.file_id
  if (msg.animation) record.animationFileId = msg.animation.file_id
  if (msg.sticker) record.stickerFileId = msg.sticker.file_id
  if (msg.voice) record.voiceFileId = msg.voice.file_id
  if (msg.audio) record.audioFileId = msg.audio.file_id
  if (msg.video_note) record.videoNoteFileId = msg.video_note.file_id
  if (msg.media_group_id) record.mediaGroupId = msg.media_group_id

  return record
}

const put = (chatId, messageId, msg) => {
  const rec = snapshot(msg)
  if (!rec) return null
  cache.set(keyOf(chatId, messageId), rec)
  return rec
}

const get = (chatId, messageId) => {
  return cache.get(keyOf(chatId, messageId)) || null
}

const del = (chatId, messageId) => {
  return cache.delete(keyOf(chatId, messageId))
}

const _resetForTests = () => cache.clear()
const _size = () => cache.size

/**
 * True if the recorded snapshot can be fully re-sent via a single
 * sendXxx call. Media groups / albums we cannot recreate from a single
 * file_id — flag so the undo button can be pre-disabled.
 */
const isRestorable = (rec) => {
  if (!rec) return false
  if (rec.mediaGroupId) return false
  const hasContent = rec.text || rec.caption ||
    rec.photoFileId || rec.documentFileId || rec.videoFileId ||
    rec.animationFileId || rec.stickerFileId || rec.voiceFileId ||
    rec.audioFileId || rec.videoNoteFileId
  return Boolean(hasContent)
}

module.exports = {
  TTL_MS,
  MAX_ENTRIES,
  snapshot,
  put,
  get,
  del,
  isRestorable,
  _resetForTests,
  _size
}
