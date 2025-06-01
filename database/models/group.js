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
        default: true
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
    quote: {
      backgroundColor: {
        type: String,
        default: '#130f1c'
      }
    },
    cas: {
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
      customRules: [{
        type: String
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
    }
  },
  stickerSet: {
    name: String,
    create: {
      type: Boolean,
      default: false
    }
  }
}, {
  timestamps: true
})

module.exports = groupSchema
