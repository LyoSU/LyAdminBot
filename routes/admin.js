const rateLimit = require('telegraf-ratelimit')
const { onlyAdmin } = require('../middlewares')
const {
  handleAdminWelcome,
  handleAdminWelcomeGif,
  handleAdminWelcomeGifReset,
  handleAdminWelcomeText,
  handleAdminWelcomeTextReset,
  handleAdminExtra,
  handleAdminMaxExtra,
  handleAdminCas,
  handleAdminSpamSettings,
  handleSpamCallback,
  handleSendMembers,
  handleSaveSticker,
  handleSendSettingsJson,
  handleAdminReset,
  handleExtra,
  handleBanAllChannel,
  handleTrust,
  handleUntrust,
  handleSpamVoteCallback,
  handleAdminOverride
} = require('../handlers')

/**
 * Rate limiter for hashtag extras
 * One extra per 3 seconds
 */
const extraRateLimit = rateLimit({
  window: 3 * 1000,
  limit: 1
})

/**
 * Register all admin commands
 */
const registerAdminRoutes = (bot) => {
  // Channel ban middleware (runs on all messages)
  bot.use(handleBanAllChannel)

  // Extra commands
  bot.hears(/^!extra\s(?:(#?))([^\s]+)/, onlyAdmin, handleAdminExtra)
  bot.hears(/^!extra-max (\d*)/, onlyAdmin, handleAdminMaxExtra)

  // Welcome settings
  bot.hears('!welcome', onlyAdmin, handleAdminWelcome)
  bot.hears('!gif', onlyAdmin, handleAdminWelcomeGif)
  bot.hears('!gif-reset', onlyAdmin, handleAdminWelcomeGifReset)
  bot.hears('!text', onlyAdmin, handleAdminWelcomeText)
  bot.hears('!text-reset', onlyAdmin, handleAdminWelcomeTextReset)

  // Moderation settings
  bot.hears('!cas', onlyAdmin, handleAdminCas)
  bot.hears(/^!spam(?:\s(.*))?/, onlyAdmin, handleAdminSpamSettings)
  bot.hears(/^!trust(?:\s(.*))?/, onlyAdmin, handleTrust)
  bot.hears(/^!untrust(?:\s(.*))?/, onlyAdmin, handleUntrust)

  // Utilities
  bot.hears('!reset', onlyAdmin, handleAdminReset)
  bot.hears('!users', onlyAdmin, handleSendMembers)
  bot.hears(/^!s(?:\s([^\s]+)|)/, onlyAdmin, handleSaveSticker)
  bot.hears('!json', onlyAdmin, handleSendSettingsJson)

  // Hashtag extras (public, rate limited)
  bot.hashtag(() => true, extraRateLimit, handleExtra)

  // Spam settings callback buttons
  bot.action(/^spam:/, handleSpamCallback)

  // Spam vote callback buttons
  bot.action(/^sv:/, handleSpamVoteCallback)

  // Admin "Not spam" override for high-confidence auto-actions
  bot.action(/^ns:/, handleAdminOverride)
}

module.exports = { registerAdminRoutes }
