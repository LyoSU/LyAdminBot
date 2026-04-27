const { bot: log } = require('./logger')

const REACTIONS = {
  del: '🗑',
  banan: '🍌',
  report: '👀',
  extraSaved: '✍️',
  trustOk: '👌',
  voteSpam: '🚫',
  voteClean: '✅',
  ok: '👍'
}

const setReaction = async (ctx, chatId, messageId, emoji) => {
  if (!ctx || !ctx.telegram) return false
  if (!chatId || !messageId) return false
  try {
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : []
    })
    return true
  } catch (err) {
    log.debug({ err, chatId, messageId, emoji }, 'setMessageReaction failed (silently dropped)')
    return false
  }
}

const ack = (ctx, emoji) => {
  if (!ctx || !ctx.chat || !ctx.message || !ctx.message.message_id) return Promise.resolve(false)
  return setReaction(ctx, ctx.chat.id, ctx.message.message_id, emoji)
}

const ackOnTarget = (ctx, messageId, emoji) => {
  if (!ctx || !ctx.chat) return Promise.resolve(false)
  return setReaction(ctx, ctx.chat.id, messageId, emoji)
}

const silent = (ctx) => ack(ctx, REACTIONS.report)

module.exports = { setReaction, ack, ackOnTarget, silent, REACTIONS }
