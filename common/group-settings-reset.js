const Group = require('../models/group')

module.exports = async (groupId, callback) => {
  await Group.update(
    { group_id: groupId },
    { $unset: {'settings': 1} }, (err, doc) => {
      if (err) return console.log(err)
      if (callback && typeof callback === 'function') callback()
    }
  )
}
