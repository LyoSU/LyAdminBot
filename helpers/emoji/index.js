// author: https://github.com/seiya-git
const EmojiSearchDb = require('./module.emoji-searcher')
const extModule = require('./module.extended')

const emojiDb = extModule.loadDb(__dirname + '/emoji-data/', 'emojilist_', '.json')
const emojiSearch = new EmojiSearchDb(emojiDb)

for (const i in emojiDb) {
  if (i.match(/fe0f-200d/)) {
    let r = i.replace(/fe0f-200d/g, '200d')
    if (emojiDb[r] === undefined) {
      emojiDb[r] = { redirect: i }
    }
  }
}

const getEmoji = (chart) => {
  return emojiSearch.getEmojis(chart)
}

module.exports = {
  getEmoji,
  emojiDb
}
