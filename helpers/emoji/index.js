const path = require('path')

// author: https://github.com/seiya-git
const EmojiSearchDb = require('./module.emoji-searcher')
const extModule = require('./module.extended')

const emojiDb = extModule.loadDb(path.join(__dirname, '/emoji-data/'), 'emojilist_', '.json')
const emojiSearch = new EmojiSearchDb(emojiDb)

const getEmoji = (chart) => {
  return emojiSearch.getEmojis(chart)
}

module.exports = {
  getEmoji,
  emojiDb
}
