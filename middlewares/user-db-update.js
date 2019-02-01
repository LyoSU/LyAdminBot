const User = require('../models/user')


module.exports = async (ctx) => {
  if (ctx.chat.type !== 'channel') {
    await User.dbUpdate(ctx)
  }
}
