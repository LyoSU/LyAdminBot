const mongoose = require('mongoose')
const crypto = require('crypto')

// Captcha — single-use challenge bound to a user.
//
// Two kinds, one shape:
//   mid_confidence    — soft-mute trigger from the spam pipeline. The user
//                       must pass within a 5 min window or the soft-mute
//                       escalates to a standard 24h mute. `chatId` is the
//                       group where the suspect message landed; `eventId`
//                       links the row to a ModEvent so the group-side
//                       compact line can be edited on resolution.
//   global_ban_appeal — user opens /start in PM while globally banned and
//                       chooses to appeal. No `chatId` (PM-only).
//
// The challenge itself (correctEmoji + 6 options) is generated once and
// frozen on the row. Reusing the same challenge on /start spam is intended:
// it stops attackers from rerolling decoys to enumerate the answer.

const KINDS = ['mid_confidence', 'global_ban_appeal']

const optionSchema = new mongoose.Schema({
  emoji: { type: String, required: true },
  nameKey: { type: String, required: true }
}, { _id: false })

const captchaSchema = mongoose.Schema({
  challengeId: {
    type: String,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(6).toString('hex')
  },

  userId: { type: Number, required: true, index: true },
  // null for global_ban_appeal (PM-only).
  chatId: { type: Number, default: null },

  kind: {
    type: String,
    enum: KINDS,
    required: true
  },

  correctEmoji: { type: String, required: true },
  correctNameKey: { type: String, required: true },
  options: { type: [optionSchema], required: true },

  attemptsLeft: { type: Number, default: 3 },

  // Mid-confidence captchas are anchored to a ModEvent so the group-side
  // compact line can be edited in place on pass / fail. Null for appeals.
  eventId: { type: String, default: null },

  createdAt: { type: Date, default: () => new Date() },

  // TTL index — Mongo cleans up the row when expiresAt passes. Set per-kind
  // by the helper that creates the row (5 min for mid_confidence, 10 min
  // for global_ban_appeal).
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
})

// Most-recent active row for a (userId, kind) pair. Used for dedup so
// re-tapping the deep-link doesn't reroll the decoys.
captchaSchema.statics.findActive = function ({ userId, kind }) {
  if (!userId || !kind) return Promise.resolve(null)
  return this.findOne({
    userId,
    kind,
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 })
}

// Single-use consumption — the row is destroyed on success so a passed
// captcha cannot be replayed. Returns the deleted doc (or null).
captchaSchema.statics.consume = function (challengeId) {
  if (!challengeId) return Promise.resolve(null)
  return this.findOneAndDelete({ challengeId })
}

captchaSchema.statics.KINDS = KINDS

module.exports = captchaSchema
