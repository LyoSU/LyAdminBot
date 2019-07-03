const collections = require('./models')
const connection = require('./connection')


const db = {
  connection,
}

Object.keys(collections).forEach((collectionName) => {
  db[collectionName] = connection.model(collectionName, collections[collectionName])
})

db.Group.updateData = (ctx) => new Promise(async (resolve, reject) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    let group = await db.Group.findOne({ group_id: ctx.chat.id })

    if (!group) {
      group = new db.Group()
      group.group_id = ctx.chat.id
    }

    group.title = ctx.chat.title
    group.username = ctx.chat.username
    group.settings = group.settings || new db.Group().settings

    if (!group.username && !group.invite_link) {
      group.invite_link = await ctx.telegram.exportChatInviteLink(ctx.chat.id).catch(() => {})
    }

    let groupMember = await db.GroupMember.findOne({
      group,
      telegram_id: ctx.from.id,
    })

    if (!groupMember) {
      groupMember = new db.GroupMember()

      groupMember.group = group
      groupMember.telegram_id = ctx.from.id
    }

    if (groupMember.banan.stack > 0) {
      const day = 86400
      const now = new Date()

      const delta = (now - groupMember.banan.time) / 1000

      if (delta > day) {
        groupMember.banan.stack -= 1
        groupMember.banan.time = now
      }
    }

    groupMember.stats.messagesCount += 1
    group.stats.messagesCount += 1

    if (ctx.message && ctx.message.text && ctx.message.text.length > 0) {
      groupMember.stats.textTotal += ctx.message.text.length
      group.stats.textTotal += ctx.message.text.length
    }

    groupMember.updatedAt = new Date()
    group.updatedAt = new Date()

    await groupMember.save()
    await group.save()

    ctx.groupInfo = group
    ctx.groupMemberInfo = groupMember

    resolve({ info: group, member: groupMember })
  }
  else {
    resolve()
  }
})

db.User.updateData = (ctx) => new Promise(async (resolve, reject) => {
  let user = await db.User.findOne({ telegram_id: ctx.from.id }).catch(reject)

  const now = Math.floor(new Date().getTime() / 1000)

  if (!user) {
    user = new db.User()
    user.telegram_id = ctx.from.id
    user.first_act = now
  }
  user.first_name = ctx.from.first_name
  user.last_name = ctx.from.last_name
  user.username = ctx.from.username
  user.updatedAt = new Date()
  await user.save()

  resolve(user)
})

module.exports = {
  db,
}
