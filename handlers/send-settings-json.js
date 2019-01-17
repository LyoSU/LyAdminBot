module.exports = async (ctx) => {
  const json = JSON.stringify(ctx.groupInfo.settings, null, 2)

  ctx.telegram.sendMessage(
    ctx.from.id,
    `<pre>${json}</pre>`,
    {
      parse_mode: 'HTML',
    }
  )
}
