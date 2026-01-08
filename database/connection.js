const mongoose = require('mongoose')
const { db: dbLog } = require('../helpers/logger')

const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  maxPoolSize: 10
})

connection.on('error', error => {
  dbLog.error({ err: error }, 'MongoDB connection error')
})

module.exports = connection
