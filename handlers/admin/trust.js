/**
 * !trust and !untrust commands - shortcuts for spam trust management
 */

module.exports.handleTrust = async (ctx) => {
  // Rewrite as !spam trust and call spam settings handler
  const args = ctx.message.text.split(' ')
  const target = args[1] || ''
  ctx.message.text = `!spam trust ${target}`.trim()

  const handleSpamSettings = require('./spam-settings')
  return handleSpamSettings(ctx)
}

module.exports.handleUntrust = async (ctx) => {
  // Rewrite as !spam untrust and call spam settings handler
  const args = ctx.message.text.split(' ')
  const target = args[1] || ''
  ctx.message.text = `!spam untrust ${target}`.trim()

  const handleSpamSettings = require('./spam-settings')
  return handleSpamSettings(ctx)
}
