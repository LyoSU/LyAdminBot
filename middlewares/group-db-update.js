const Group = require('../models/group')


module.exports = async (ctx) => {
  await Group.dbUpdate(ctx)
}
