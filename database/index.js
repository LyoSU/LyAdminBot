const mongoose = require('mongoose')
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
    let group = await db.Group.findOne({ group_id: ctx.chat.id }).catch(reject)

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

    let groupMemberId

    const groupMember = await db.Group.findOne({
      group_id: ctx.chat.id,
      'members.telegram_id': ctx.from.id,
    }, { 'members.$': 1 }).catch(console.log)

    if (groupMember) {
      groupMemberId = groupMember.members[0].id
    }
    else {
      groupMemberId = mongoose.Types.ObjectId()

      await group.members.push({
        _id: groupMemberId,
        telegram_id: ctx.from.id,
      })
    }

    const member = group.members.id(groupMemberId)

    if (member.banan.stack > 0) {
      console.log(member.banan.stack)
      const day = 86400
      const now = new Date()

      const delta = (now - member.banan.time) / 1000

      if (delta > day) {
        member.banan.stack -= 1
        member.banan.time = now
      }
    }

    member.stats.messagesCount += 1
    group.stats.messagesCount += 1

    if (ctx.message && ctx.message.text && ctx.message.text.length > 0) {
      member.stats.textTotal += ctx.message.text.length
      group.stats.textTotal += ctx.message.text.length
    }

    member.updatedAt = new Date()

    await group.save()

    ctx.groupInfo = group
    ctx.groupMemberInfo = member

    resolve(group)
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
  user.save()

  resolve(user)
})

module.exports = {
  db,
}
