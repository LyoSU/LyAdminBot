module.exports = {
  log: (type, ...args) => {
    const util = require('util')
    const s = util.format(...args)
    if (type === 'ERROR') {
      console.error('[%o]: %s', new Date(), s) // eslint-disable-line no-console
    } else {
      console.log('[%o]: %s', new Date(), s) // eslint-disable-line no-console
    }
  },
  emojiDb: {
    host: 'http://emojipedia.org/',
    prefix: 'emoji-',
    ver: {
      base: [1, 2, 3, 4, 5, 11, 12, 12.1],
      comp: [1, 2, 5, 11]
    }
  },
  lang: {
    hello: "Hello! I'm unofficial Emojipedia.org bot.",
    notfound_text: 'Emoji not found. Please send me emoji or sticker!',
    notfound_db: 'Emoji "{emoji}" not found in database!',
    too_many: 'Too many emoji!'
  },
  uniqueArr: (arr) => {
    return [...new Set(arr)]
  },
  loadDb: (dbDir, filePrefx, fileSuffx) => {
    const fs = require('fs')
    let dbFiles = fs.readdirSync(dbDir)
    // remove non db files
    dbFiles = dbFiles.filter((dbFile) => {
      if (!dbFile.endsWith('.json') || !dbFile.startsWith(filePrefx)) {
        return false
      }
      return true
    })
    // make emoji db nums
    dbFiles = dbFiles.map((dbFile) => {
      return dbFile
        .replace(new RegExp('^' + filePrefx), '')
        .replace(new RegExp(fileSuffx + '$'), '')
    })
    // sort dbs
    dbFiles.sort((a, b) => {
      a = !a.match(/fix/) ? parseFloat(a) : Infinity
      b = !b.match(/fix/) ? parseFloat(b) : Infinity
      return a - b
    })
    // load dbs
    let emojiDb = {}
    for (const dbFile of dbFiles) {
      let dbData = require(dbDir + filePrefx + dbFile + fileSuffx)
      emojiDb = Object.assign({}, emojiDb, dbData)
    }
    // return db
    return emojiDb
  }
}
