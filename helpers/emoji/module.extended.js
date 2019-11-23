module.exports = {
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
