const LanguageDetect = require('languagedetect')

/**
 * Generic message handler
 * - Detects and removes messages in banned languages
 */
module.exports = async (ctx) => {
  // Skip private chats
  if (ctx.chat.type === 'private') return

  // Language detection and removal
  if (ctx.message && ctx.message.text) {
    const lngDetector = new LanguageDetect()
    const detect = lngDetector.detect(ctx.message.text)

    if (detect.length > 0 && detect[0][1] > 0.3) {
      if (ctx.group.info.settings.removeLng.indexOf(detect[0][0]) >= 0) {
        await ctx.deleteMessage().catch(() => {
          // Silently fail if no delete permission
        })
      }
    }
  }
}
