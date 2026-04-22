const mongoose = require('mongoose')

const nameHistoryEntrySchema = new mongoose.Schema({
  value: { type: String },
  seenAt: { type: Date, default: Date.now }
}, { _id: false })

const usernameHistoryEntrySchema = new mongoose.Schema({
  value: { type: String },
  seenAt: { type: Date, default: Date.now }
}, { _id: false })

const bioHistoryEntrySchema = new mongoose.Schema({
  value: { type: String },
  seenAt: { type: Date, default: Date.now }
}, { _id: false })

const externalBanProviderSchema = new mongoose.Schema({
  banned: { type: Boolean, default: false },
  offenses: { type: Number, default: 0 },
  spamFactor: { type: Number, default: 0 },
  scammer: { type: Boolean, default: false },
  when: { type: Date },
  reasons: [{ type: String }],
  checkedAt: { type: Date }
}, { _id: false })

// Aggregated per-user behavioural stats. Kept small on purpose — anything
// larger than ~300 bytes/user would be wasteful at 1M users.
//   avgLength / lengthM2 use Welford's online algorithm — we only persist
//     the running mean and M2 (sum of squared deviations), enough to recover
//     variance = M2 / n later. Two floats, no history required.
//   hourHistogram is a 24-bucket count of message hours (UTC). Persisted so
//     dormancy/burst detection survives bot restarts (velocity store loses
//     history on crash).
//   entityCounts tracks Telegram entity types the user has ever produced.
//     Promo-heavy users accumulate url/mention/cashtag/bot_command.
//   mediaCounts tracks the distribution of content types the user sends.
//     Stolen accounts often shift from short-text to link-only.
//   contactCount is a dedicated counter for message.contact — this pattern
//     (sharing a phone-card) is used almost exclusively by spam campaigns.
const messageStatsSchema = new mongoose.Schema({
  replyCount: { type: Number, default: 0 },
  editCount: { type: Number, default: 0 },
  avgLength: { type: Number, default: 0 },
  lengthM2: { type: Number, default: 0 },
  hourHistogram: { type: [Number], default: () => new Array(24).fill(0) },
  entityCounts: {
    url: { type: Number, default: 0 },
    text_link: { type: Number, default: 0 },
    mention: { type: Number, default: 0 },
    text_mention: { type: Number, default: 0 },
    hashtag: { type: Number, default: 0 },
    cashtag: { type: Number, default: 0 },
    bot_command: { type: Number, default: 0 },
    phone_number: { type: Number, default: 0 },
    email: { type: Number, default: 0 },
    spoiler: { type: Number, default: 0 },
    custom_emoji: { type: Number, default: 0 }
  },
  mediaCounts: {
    text: { type: Number, default: 0 },
    photo: { type: Number, default: 0 },
    video: { type: Number, default: 0 },
    voice: { type: Number, default: 0 },
    video_note: { type: Number, default: 0 },
    sticker: { type: Number, default: 0 },
    animation: { type: Number, default: 0 },
    document: { type: Number, default: 0 },
    audio: { type: Number, default: 0 },
    contact: { type: Number, default: 0 },
    location: { type: Number, default: 0 },
    poll: { type: Number, default: 0 }
  },
  contactCount: { type: Number, default: 0 },
  formattingDiversitySum: { type: Number, default: 0 }
}, { _id: false })

// Top N detected language codes with their counts. Capped, newest-first by
// access. Paired with from.language_code (UI language) to detect mismatch:
// Telegram client language vs actual writing language diverge on many scam
// campaigns (e.g. language_code=vi on an account posting Ukrainian-only text).
const languageEntrySchema = new mongoose.Schema({
  code: { type: String },
  count: { type: Number, default: 0 }
}, { _id: false })

// Custom-emoji cluster tracker — persistent top-N IDs the user uses most.
// Cross-user matching happens in memory, but persisting helps "resolve" a
// returning user to a known cluster after bot restart.
const customEmojiEntrySchema = new mongoose.Schema({
  id: { type: String },
  count: { type: Number, default: 0 }
}, { _id: false })

const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  first_name: String,
  last_name: String,
  username: String,
  locale: String,
  isGlobalBanned: {
    type: Boolean,
    default: false
  },
  globalBanReason: String,
  globalBanDate: Date,

  // History of name/username changes — strong signal for fresh-identity spam
  // Entries sorted newest-first, capped at 10 each
  nameHistory: {
    type: [nameHistoryEntrySchema],
    default: []
  },
  usernameHistory: {
    type: [usernameHistoryEntrySchema],
    default: []
  },

  // External ban providers (lols.bot, CAS) — cached snapshot
  externalBan: {
    lols: externalBanProviderSchema,
    cas: externalBanProviderSchema
  },

  // Telegram UI language (from.language_code) — tracked for mismatch detection
  languageCode: { type: String },
  // Top detected languages from actual message content (capped top-5)
  detectedLanguages: { type: [languageEntrySchema], default: [] },

  // Bio tracking: current snapshot + short history for churn detection.
  // getChat returns bio but the result was previously thrown away.
  bio: {
    text: { type: String },
    updatedAt: { type: Date },
    history: { type: [bioHistoryEntrySchema], default: [] }
  },

  // Business intro (Telegram Business API) — rarely set by spammers, but
  // when it is, the intro text itself is promo. Persist the last observed.
  businessIntro: {
    text: { type: String },
    updatedAt: { type: Date }
  },

  // Last observed linked personal channel ID (from getChat).
  personalChatId: { type: Number },

  // Last observed custom emoji status ID.
  emojiStatusCustomId: { type: String },

  // Custom emoji IDs the user tends to use (top-N by usage count).
  // Cross-user overlap on rare emoji IDs is a coordinated-network signal.
  customEmojiIds: { type: [customEmojiEntrySchema], default: [] },

  // Last observed is_premium — used together with approximate account age
  // to detect "premium-on-fresh-account" paradox.
  isPremium: { type: Boolean, default: false },

  // Global statistics (aggregated across all groups)
  globalStats: {
    totalMessages: { type: Number, default: 0 },
    groupsActive: { type: Number, default: 0 },
    groupsList: [{ type: Number }],
    firstSeen: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    // Negative signals
    spamDetections: { type: Number, default: 0 },
    deletedMessages: { type: Number, default: 0 },
    // Positive signals
    cleanMessages: { type: Number, default: 0 },
    manualUnbans: { type: Number, default: 0 },
    // Uniqueness tracking — rolling sample of last ~50 normalized message hashes
    // Used to compute uniquenessRatio = distinct / total (strong anti-blast signal)
    uniquenessSamples: [{ type: String }],
    uniqueMessageHashes: { type: Number, default: 0 },
    trackedMessages: { type: Number, default: 0 },
    uniquenessRatio: { type: Number, default: 1 },
    // Behavioural / message composition stats (Welford mean+M2, histograms)
    messageStats: { type: messageStatsSchema, default: () => ({}) }
  },

  // Computed reputation
  reputation: {
    score: { type: Number, default: 50 },
    status: {
      type: String,
      enum: ['trusted', 'neutral', 'suspicious', 'restricted'],
      default: 'neutral'
    },
    lastCalculated: { type: Date, default: Date.now }
  }
}, {
  timestamps: true
})

userSchema.index({ isGlobalBanned: 1 }, { sparse: true })
userSchema.index({ 'reputation.status': 1 }, { sparse: true })
userSchema.index({ 'externalBan.lols.banned': 1 }, { sparse: true })

module.exports = userSchema
