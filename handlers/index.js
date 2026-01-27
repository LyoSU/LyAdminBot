const handleStart = require('./start')
const handleHelp = require('./help')
const handleKick = require('./kick')
const handlePing = require('./ping')
const handleSetLanguage = require('./language-set')
const handleBanan = require('./banan')
const handleQuote = require('./quote')
const handleDelete = require('./delete')
const handleTop = require('./top')
const handleTopBanan = require('./top-banan')
const handleMyStats = require('./my-stats')
const handleExtraList = require('./extra-list')
const handleWebAuth = require('./web-auth')
const handleMessage = require('./message')
const handleWelcome = require('./welcome')
const handleAdminWelcome = require('./admin/welcome')
const handleAdminWelcomeGif = require('./admin/welcome-gif')
const handleAdminWelcomeGifReset = require('./admin/welcome-gif-reset')
const handleAdminWelcomeText = require('./admin/welcome-text')
const handleAdminWelcomeTextReset = require('./admin/welcome-text-reset')
const handleAdminExtra = require('./admin/extra')
const handleAdminMaxExtra = require('./admin/extra-max')
const handleAdminCas = require('./admin/cas')
const handleAdminSpamSettings = require('./admin/spam-settings')
const { handleSpamCallback } = require('./admin/spam-settings')
const handleSendMembers = require('./admin/send-members')
const handleSaveSticker = require('./admin/sticker-save')
const handleSendSettingsJson = require('./admin/send-settings-json')
const handleAdminJsonReset = require('./admin/json-reset')
const handleAdminReset = require('./admin/reset')
const handleExtra = require('./extra')
const handleBanAllChannel = require('./admin/all-chanell-ban')
const { handleReport, isBotMentionReport } = require('./report')
const { handleTrust, handleUntrust } = require('./admin/trust')
const { handleSpamVoteCallback, processExpiredVotes } = require('./spam-vote')

module.exports = {
  handleStart,
  handleHelp,
  handleKick,
  handlePing,
  handleSetLanguage,
  handleBanan,
  handleQuote,
  handleDelete,
  handleTop,
  handleTopBanan,
  handleMyStats,
  handleExtraList,
  handleWebAuth,
  handleMessage,
  handleWelcome,
  handleAdminWelcome,
  handleAdminWelcomeGif,
  handleAdminWelcomeGifReset,
  handleAdminWelcomeText,
  handleAdminWelcomeTextReset,
  handleAdminExtra,
  handleAdminMaxExtra,
  handleAdminCas,
  handleAdminSpamSettings,
  handleSendMembers,
  handleSaveSticker,
  handleSendSettingsJson,
  handleAdminJsonReset,
  handleAdminReset,
  handleExtra,
  handleBanAllChannel,
  handleReport,
  isBotMentionReport,
  handleTrust,
  handleUntrust,
  handleSpamCallback,
  handleSpamVoteCallback,
  processExpiredVotes
}
