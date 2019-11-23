const path = require('path')
const https = require('https')
const fs = require('fs')

// author: https://github.com/seiya-git
const EmojiSearchDb = require('./module.emoji-searcher')
const extModule = require('./module.extended')

const emojiDb = extModule.loadDb(path.join(__dirname, '/emoji-data/'), 'emojilist_', '.json')
const emojiSearch = new EmojiSearchDb(emojiDb)

const getEmoji = (chart) => {
  return emojiSearch.getEmojis(chart)
}

function loadImageFromUrl (url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = []

      res.on('error', (err) => {
        reject(err)
      })
      res.on('data', (chunk) => {
        chunks.push(chunk)
      })
      res.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
  })
}

function downloadEmoji () {
  Object.keys(emojiDb).map(async (key) => {
    const emoji = emojiDb[key]

    if (emoji.image) {
      const img = await loadImageFromUrl(emoji.image.src)

      const fileName = `${emoji.code}.png`

      fs.writeFile(path.join(__dirname, `/image/${fileName}`), img, (err) => {
        if (err) return console.log(err)
      })
    }
  })
}

module.exports = {
  getEmoji,
  emojiDb
}
