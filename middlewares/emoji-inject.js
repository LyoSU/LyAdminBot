const emojiMap = require('../helpers/emoji-map')

module.exports = (ctx, next) => {
  if (ctx.i18n) {
    const originalT = ctx.i18n.t.bind(ctx.i18n)
    ctx.i18n.t = (key, vars = {}) => originalT(key, { e: emojiMap, ...vars })
  }
  return next()
}
