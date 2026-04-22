const mongoose = require('mongoose')

const groupSchema = mongoose.Schema({
  group_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  title: String,
  username: String,
  invite_link: String,
  settings: {
    welcome: {
      enable: {
        type: Boolean,
        default: false
      },
      timer: {
        type: Number,
        default: 180
      },
      gifs: [{
        type: String
      }],
      texts: [{
        type: String
      }]
    },
    banan: {
      default: {
        type: Number,
        default: 300
      }
    },
    maxExtra: {
      type: Number,
      default: 3
    },
    extras: [{
      name: String,
      type: { type: String },
      message: Object
    }],
    removeLng: Array,
    locale: String,
    banDatabase: {
      type: Boolean,
      default: true
    },
    banChannel: {
      type: Boolean,
      default: false
    },
    openaiSpamCheck: {
      enabled: {
        type: Boolean,
        default: true
      },
      globalBan: {
        type: Boolean,
        default: true
      },
      confidenceThreshold: {
        type: Number,
        default: 70,
        min: 50,
        max: 95
      },
      customRules: [{
        type: String
      }],
      trustedUsers: [{
        type: Number
      }]
    }
  },
  stats: {
    messagesCount: {
      type: Number,
      default: 0
    },
    textTotal: {
      type: Number,
      default: 0
    },
    // Top-N rolling language distribution for the chat. Populated from
    // sampled user messages (see helpers/group-update.js). Used by the
    // language-mismatch deterministic rule: a new user writing in a
    // language that doesn't match the chat's dominant language, combined
    // with a promo signal, is a coordinated-campaign fingerprint.
    detectedLanguages: {
      type: [{
        code: { type: String },
        count: { type: Number, default: 0 }
      }],
      default: []
    }
  },
  stickerSet: {
    name: String,
    create: {
      type: Boolean,
      default: false
    }
  },
  linked_chat_id: {
    type: Number,
    default: null
  }
}, {
  timestamps: true
})

module.exports = groupSchema
