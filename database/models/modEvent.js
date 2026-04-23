const mongoose = require('mongoose')
const crypto = require('crypto')

/**
 * ModEvent — lightweight moderation-event record.
 *
 * Backs the unified compact/expanded notification flow (§9 of the UX design).
 * Stores just enough to re-render the compact / expanded views when admins
 * click callback buttons, so buttons can pass a 12-hex eventId without
 * stuffing the whole context into callback_data.
 *
 * Distinct from SpamVote: SpamVote is for community-voted decisions.
 * ModEvent covers the unvoted auto-actions (high-confidence bans, mutes,
 * no-permission warnings, global-ban enforcement, admin overrides).
 *
 * TTL: 7 days. Events older than that cannot be interacted with via
 * buttons anyway because the notification message is long gone.
 */
const ACTION_TYPES = [
  'auto_ban',
  'auto_mute',
  'auto_delete',
  'suspicious',
  'no_permissions',
  'global_ban',
  'voting',
  'override'
]

const modEventSchema = mongoose.Schema({
  // 12-char hex — keeps callback_data short:
  //   m:v1:mod.event:why:abcdef012345  →  29 bytes (well under 64).
  eventId: {
    type: String,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(6).toString('hex')
  },

  chatId: { type: Number, required: true, index: true },

  // Who triggered the action. `null` / `0` = the bot itself (auto-action).
  // For `override` it's the admin who clicked [↩️ Розблокувати].
  actorId: { type: Number, default: null },
  actorName: String,

  // The user / channel the action was taken against.
  targetId: { type: Number, index: true },
  targetName: String,
  targetUsername: String,
  // For channel posts we capture title; for ID-only fallback use targetId.
  targetTitle: String,
  isChannel: { type: Boolean, default: false },

  actionType: {
    type: String,
    enum: ACTION_TYPES,
    required: true
  },

  // Short reason code (e.g. 'forward_blacklist', 'confirmed_signature').
  // Looked up in `mod_event.reason.*` locale table at render time.
  reason: String,

  // 0–100 AI confidence for display in the expanded view. Optional.
  confidence: Number,

  // First ≤200 chars of the offending message for the expanded preview.
  messagePreview: { type: String, maxLength: 200 },

  // Optional one-line warning (e.g. "Couldn't delete — no permissions").
  // Only shown in the expanded view; never in the compact line.
  warning: String,

  actionTaken: { type: Number, default: () => Date.now() },

  // Where the notification was posted. Needed so override / undo flows
  // can edit or delete the right message.
  notificationChatId: Number,
  notificationMessageId: Number,

  createdAt: {
    type: Date,
    default: () => new Date(),
    // TTL 7d — DB-level auto-cleanup, independent of the 90s UI auto-delete.
    expires: 7 * 24 * 60 * 60
  }
})

modEventSchema.statics.ACTION_TYPES = ACTION_TYPES

module.exports = modEventSchema
