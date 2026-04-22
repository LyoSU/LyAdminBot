const stats = require('./stats')
const onlyGroup = require('./only-group')
const onlyAdmin = require('./only-admin')
const banDatabase = require('./ban-database')
const spamCheck = require('./spam-check')
const errorHandler = require('./error-handler')
const contextLoader = require('./context-loader')
const globalBanCheck = require('./global-ban')
const dataPersistence = require('./data-persistence')
const emojiInject = require('./emoji-inject')
const albumBuffer = require('./album-buffer')
const { pendingInputMiddleware: pendingInput } = require('./pending-input')

module.exports = {
  stats,
  onlyGroup,
  onlyAdmin,
  banDatabase,
  spamCheck,
  errorHandler,
  contextLoader,
  globalBanCheck,
  dataPersistence,
  emojiInject,
  albumBuffer,
  pendingInput
}
