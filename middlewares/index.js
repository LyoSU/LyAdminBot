const stats = require('./stats')
const onlyGroup = require('./only-group')
const onlyAdmin = require('./only-admin')
const casBan = require('./cas-ban')
const spamCheck = require('./spam-check')
const errorHandler = require('./error-handler')
const contextLoader = require('./context-loader')
const globalBanCheck = require('./global-ban')
const dataPersistence = require('./data-persistence')
const emojiInject = require('./emoji-inject')

module.exports = {
  stats,
  onlyGroup,
  onlyAdmin,
  casBan,
  spamCheck,
  errorHandler,
  contextLoader,
  globalBanCheck,
  dataPersistence,
  emojiInject
}
