/**
 * Album (media-group) aggregator middleware.
 *
 * Problem this solves:
 *   When a user sends an album (2+ photos/videos in one send), Telegram
 *   delivers each piece as a SEPARATE update sharing the same
 *   `media_group_id`. Only the FIRST message in the album carries the
 *   caption — siblings have no text.
 *
 *   Without aggregation our spam-check:
 *     - runs N times (once per photo), burning N× LLM tokens
 *     - scores siblings #2..N with empty text → likely marks them clean
 *     - on delete only removes the ONE message we judged spam
 *
 *   Result: spam caption disappears but 4 promotional photos stay visible.
 *
 * What this middleware does:
 *   1. Buffers all messages sharing (chatId, media_group_id) for
 *      ALBUM_DEBOUNCE_MS (resetting the timer on each new sibling).
 *   2. When the timer fires, downstream middleware runs EXACTLY ONCE
 *      for the album with:
 *        - ctx.message          = the caption-carrier (or message_id-
 *                                 smallest if no caption anywhere)
 *        - ctx.mediaGroup       = [message, ...] sorted by message_id
 *        - ctx.mediaGroupIds    = [message_id, ...]
 *      Siblings that already entered the chain hit an early-return — no
 *      duplicate spam-check, no duplicate persistence.
 *
 *   Non-album messages pass through untouched.
 *
 *   Handles all media types (photo, video, animation, document, audio,
 *   voice, video_note) because Telegram permits mixed albums.
 *
 * Storage: `lru-cache` bucket keyed by `chatId:media_group_id`, TTL
 * 30s — albums always arrive within 1–2s so any entry older than that
 * is a leftover.
 */

const { LRUCache } = require('lru-cache')

const ALBUM_DEBOUNCE_MS = 700
const BUCKET_TTL_MS = 30 * 1000
const MAX_BUCKETS = 2000

const buckets = new LRUCache({ max: MAX_BUCKETS, ttl: BUCKET_TTL_MS, ttlAutopurge: false })

const keyFor = (chatId, mediaGroupId) => `${chatId}:${mediaGroupId}`

const pickCaptionCarrier = (messages) => {
  const byMsgId = messages.slice().sort((a, b) => a.message_id - b.message_id)
  return byMsgId.find(m => m && (m.caption || m.text)) || byMsgId[0]
}

const albumBuffer = (ctx, next) => {
  const message = ctx.message || ctx.editedMessage
  const mgid = message && message.media_group_id
  if (!mgid) return next()

  const k = keyFor(ctx.chat.id, mgid)
  let bucket = buckets.get(k)

  if (!bucket) {
    // First message of this album — we'll be the one to eventually call
    // next(). Subsequent siblings short-circuit by resolving their
    // promise via `bucket.resolveEarly(false)`.
    bucket = {
      messages: [],
      resolveEarly: () => {},
      finalCtx: ctx
    }
    buckets.set(k, bucket)
  } else {
    // A newer message arrived — reset the timer on the owning ctx by
    // telling it to stop waiting (we'll re-arm in the new ctx below).
    bucket.resolveEarly(false)
  }

  bucket.messages.push(message)

  return new Promise((resolve) => {
    bucket.resolveEarly = resolve
    setTimeout(() => resolve(true), ALBUM_DEBOUNCE_MS)
  }).then(async (shouldProcess) => {
    if (!shouldProcess) return // later sibling took over — this one is done
    buckets.delete(k)

    const carrier = pickCaptionCarrier(bucket.messages)
    // Telegraf v3 defines ctx.message as a read-only getter onto
    // ctx.update.message, so we have to mutate the underlying update
    // in order for downstream middleware to see the caption-carrier.
    ctx.update.message = carrier
    ctx.mediaGroup = bucket.messages.slice().sort((a, b) => a.message_id - b.message_id)
    ctx.mediaGroupIds = ctx.mediaGroup.map(m => m.message_id)

    return next()
  })
}

const _resetForTests = () => buckets.clear()

module.exports = albumBuffer
module.exports.albumBuffer = albumBuffer
module.exports.ALBUM_DEBOUNCE_MS = ALBUM_DEBOUNCE_MS
module.exports._resetForTests = _resetForTests
