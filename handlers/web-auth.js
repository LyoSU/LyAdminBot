module.exports = async (ctx) => {
  ctx.reply('web', {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'web',
            login_url: {
              url: 'https://admin.lyo.su/login',
              forward_text: 'web',
              request_write_access: true,
            },
          },
        ],
      ],
    },
  })
}
