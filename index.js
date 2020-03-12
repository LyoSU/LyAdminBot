require('dotenv').config()
require('./bot')

process.on('unhandledRejection', (err) => {
  console.error('Uhandled Rejection:', err)
  process.exit(-1)
})
