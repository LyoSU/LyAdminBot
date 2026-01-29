const userName = require('./user-name')
const getRandomInt = require('./get-random-int')
const escapeRegex = require('./escape-regex')
const {
  isChannelId,
  isChannelPost,
  isLinkedChannelPost,
  isAnonymousAdmin,
  getSenderId,
  getSenderInfo,
  getSender
} = require('./get-sender')

module.exports = {
  userName,
  getRandomInt,
  escapeRegex,
  isChannelId,
  isChannelPost,
  isLinkedChannelPost,
  isAnonymousAdmin,
  getSenderId,
  getSenderInfo,
  getSender
}
