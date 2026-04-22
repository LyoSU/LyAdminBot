/**
 * Edit-to-inject detector.
 *
 * Attack pattern (observed in prod):
 *   1. Attacker sends a benign message ("Hi everyone!").
 *   2. Message passes spam check, stored in history.
 *   3. After a few seconds/minutes, attacker edits the message to insert
 *      a promo URL / mention / hidden-char payload.
 *
 * Our existing editedMessage → re-check flow catches MOST of this because
 * edited messages go through quick-risk + LLM again. But there's a gap:
 *
 *   The re-check only sees the NEW message content. It has no memory of
 *   what was there before. A soft "edited_message" tag is added but there's
 *   no structural comparison between before/after.
 *
 * This module fills the gap:
 *   - Keeps a per-chat, per-message ephemeral snapshot (TTL 24h).
 *   - When edited_message fires, compute delta:
 *       • did URL count increase?
 *       • did mention count increase?
 *       • did private-invite / shortener / bot-deeplink appear?
 *       • did invisible-char count increase?
 *       • did the text length grow by >2x while gaining URL/mention?
 *   - Any of the above → emit `edit_injected_promo` signal.
 *
 * Signal combines with the existing "edited_message" tag in the deterministic
 * verdict: edit_injected_promo + new-user-ish history = spam with confidence
 * 90 even if the edited text itself would score "medium".
 *
 * Storage: pure in-memory Map<`chatId:messageId`, {text, ts}> with TTL.
 * Crash-safe because worst case is missing ONE window of edit comparisons
 * until the map repopulates naturally on the next message flow.
 */

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_MAX = 20000
// Map<chatId:messageId, { text, ts }>
const snapshots = new Map()

const urlRegex = /(?:https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/)[^\s<>]+/gi
const mentionRegex = /@[A-Za-z0-9_]{3,}/g
const privateInviteRegex = /(?:t|telegram)\.me\/(?:\+[\w-]+|joinchat\/[\w-]+)/i
const shortenerShapeRegex = /\b(?:bit\.ly|tinyurl\.com|t\.co|is\.gd|goo\.gl|cutt\.ly|rebrand\.ly|choko\.link|wa\.me)\b/i
const botDeeplinkRegex = /t\.me\/[\w_]+bot\?start=/i
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g

const countMatches = (text, re) => {
  if (!text || typeof text !== 'string') return 0
  const m = text.match(re)
  return m ? m.length : 0
}

const keyFor = (chatId, messageId) => `${chatId}:${messageId}`

const prune = (now = Date.now()) => {
  for (const [k, v] of snapshots) {
    if (now - v.ts > SNAPSHOT_TTL_MS) snapshots.delete(k)
  }
  while (snapshots.size > SNAPSHOT_MAX) {
    const first = snapshots.keys().next().value
    if (!first) break
    snapshots.delete(first)
  }
}

/**
 * Record the text of a fresh message. Called from the spam-check middleware
 * on every NON-edited message observation so that a later edit has a
 * baseline to diff against.
 */
const snapshotMessage = (chatId, messageId, text) => {
  if (!chatId || !messageId) return
  snapshots.set(keyFor(chatId, messageId), {
    text: (text || '').toString(),
    ts: Date.now()
  })
  // Amortise pruning across writes; keeps Map bounded without a timer.
  if ((snapshots.size & 0x1FF) === 0) prune()
}

/**
 * Compare the new (edited) text to the prior snapshot for this chatId+
 * messageId. Returns a structured delta + a boolean `injected` that the
 * caller can use as a deterministic signal. Gracefully handles the case
 * where no snapshot exists (returns { snapshotMissed: true }).
 */
const analyzeEdit = (chatId, messageId, newText) => {
  const k = keyFor(chatId, messageId)
  const prior = snapshots.get(k)
  if (!prior) {
    return { snapshotMissed: true, injected: false }
  }
  const oldText = prior.text || ''
  const newT = (newText || '').toString()

  const delta = {
    snapshotMissed: false,
    oldLen: oldText.length,
    newLen: newT.length,
    urlAdded: countMatches(newT, urlRegex) - countMatches(oldText, urlRegex),
    mentionAdded: countMatches(newT, mentionRegex) - countMatches(oldText, mentionRegex),
    invisibleAdded: countMatches(newT, INVISIBLE) - countMatches(oldText, INVISIBLE),
    privateInviteAppeared: privateInviteRegex.test(newT) && !privateInviteRegex.test(oldText),
    shortenerAppeared: shortenerShapeRegex.test(newT) && !shortenerShapeRegex.test(oldText),
    botDeeplinkAppeared: botDeeplinkRegex.test(newT) && !botDeeplinkRegex.test(oldText)
  }

  delta.injected = Boolean(
    delta.urlAdded > 0 ||
    delta.mentionAdded > 0 ||
    delta.invisibleAdded > 0 ||
    delta.privateInviteAppeared ||
    delta.shortenerAppeared ||
    delta.botDeeplinkAppeared
  )

  // Update snapshot with the post-edit text so further edits diff from the
  // latest observed state, not the original.
  snapshots.set(k, { text: newT, ts: Date.now() })

  return delta
}

const size = () => snapshots.size
const _resetForTests = () => snapshots.clear()

module.exports = {
  snapshotMessage,
  analyzeEdit,
  size,
  SNAPSHOT_TTL_MS,
  SNAPSHOT_MAX,
  _resetForTests
}
