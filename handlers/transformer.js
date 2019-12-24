const got = require('got')

const extend = got.extend({
  json: true,
  headers: {
    'Content-type': 'application/json'
  },
  timeout: 5000,
  throwHttpErrors: false
})

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const text = ctx.message.reply_to_message.text

    const mediumResult = await extend.post('https://models.dobro.ai/gpt2/medium/', {
      body: {
        prompt: text,
        length: 60,
        num_samples: 4
      }
    })

    if (mediumResult.body && mediumResult.body.replies && mediumResult.body.replies.length > 0) {
      const result = `<i>${text}</i>${mediumResult.body.replies[0]}`

      ctx.replyWithHTML(result, {
        reply_to_message_id: ctx.message.reply_to_message.message_id
      })
    }
  }
}
