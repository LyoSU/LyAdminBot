module.exports = async (ctx) => {
  if (!ctx.from) return

  let user

  if (!ctx.session.userInfo) {
    const now = Math.floor(new Date().getTime() / 1000)

    // Use findOneAndUpdate with upsert to avoid duplicate key errors
    user = await ctx.db.User.findOneAndUpdate(
      { telegram_id: ctx.from.id },
      {
        $set: {
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
          username: ctx.from.username,
          updatedAt: new Date()
        },
        $setOnInsert: {
          telegram_id: ctx.from.id,
          first_act: now
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    )
  } else {
    user = ctx.session.userInfo
    user.first_name = ctx.from.first_name
    user.last_name = ctx.from.last_name
    user.username = ctx.from.username

    if (!user.updatedAt) user.updatedAt = 0

    const updateInterval = 60 * 1000

    if ((user.updatedAt.getTime() + updateInterval) < Date.now()) {
      user.updatedAt = new Date()
    }
  }

  return user
}
