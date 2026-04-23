const mongoose = require('mongoose')

/**
 * ModLog — audit trail of moderation + settings actions.
 *
 * Backs the `settings.modlog` screen (§5.6 of the UX design).
 *
 * Distinct from ModEvent:
 *   - ModEvent is the transient notification state (7d TTL, compact/expanded
 *     buttons). It gets pruned eagerly — after 7 days nobody can click the
 *     undo button anyway because the host message is long gone.
 *   - ModLog is the queryable history that powers "📋 Останні дії" and the
 *     24h / 7d / all-time filters. Longer 30d TTL. Written decoupled from
 *     ModEvent so future audit/export features can read it without pulling
 *     in the notification schema.
 *
 * We intentionally denormalize actor/target names so the log stays readable
 * even after the User / GroupMember rows roll off.
 */
const EVENT_TYPES = [
  // Admin-triggered moderation (from handlers/banan, kick, delete).
  'manual_ban',
  'manual_mute',
  'manual_kick',
  'manual_del',
  // Auto-actions by the spam pipeline.
  'auto_ban',
  'auto_mute',
  'auto_del',
  // Admin override of an automatic action.
  'override',
  // Community-vote resolution (spam-vote.js).
  'vote_resolved',
  // !trust / !untrust.
  'trust',
  'untrust',
  // Any toggle / sensitivity / locale mutation through the /settings panel.
  'settings_change'
]

const modLogSchema = mongoose.Schema({
  chatId: { type: Number, required: true, index: true },

  eventType: {
    type: String,
    enum: EVENT_TYPES,
    required: true
  },

  // Who triggered. null for bot/system (auto_* + vote_resolved by timeout).
  actorId: { type: Number, default: null },
  actorName: { type: String, default: null },

  // Subject of the action. null for settings_change events (no target).
  targetId: { type: Number, default: null },
  targetName: { type: String, default: null },

  // Short free-text describing the concrete action (e.g. "5m", "antispam.enabled → true").
  action: { type: String, default: '' },

  // Optional explanation (reason code or human blurb). Capped to keep the
  // log compact in the DB; UI truncates further.
  reason: {
    type: String,
    default: null,
    maxLength: 200
  },

  timestamp: {
    type: Date,
    default: () => new Date(),
    // TTL 30d — DB-level auto-cleanup.
    expires: 30 * 24 * 60 * 60
  }
})

// Compound index for the `settings.modlog` screen's "recent N events for this
// chat, sorted newest-first" query.
modLogSchema.index({ chatId: 1, timestamp: -1 })

modLogSchema.statics.EVENT_TYPES = EVENT_TYPES

module.exports = modLogSchema
