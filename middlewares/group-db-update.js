const Group = require('../models/group')


module.exports = async (ctx) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    await Group.dbUpdate(ctx)
  }
}
