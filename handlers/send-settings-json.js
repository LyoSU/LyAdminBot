module.exports = async (ctx) => {
  const json = JSON.stringify(ctx.groupInfo.settings, null, 2)

  const file = Buffer.from(json)

  ctx.replyWithDocument({
    source: file,
    filename: `group.settings.${ctx.chat.id}.json`,
  }, {
    reply_to_message_id: ctx.message.message_id,
  })
}
