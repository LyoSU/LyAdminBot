module.exports = async (ctx) => {


  ctx.telegram.sendMessage(ctx.user.id, ctx.groupInfo.users)
}
