const Group = require('../models/group')

module.exports = async (ctx) => {
	if (ctx.message.reply_to_message.animation) {
		const gifId = ctx.message.reply_to_message.animation.file_id

		const doc = await Group.findOne({
			'group_id': ctx.chat.id,
			'settings.gifs': { $in: [gifId] }
		})
		if (doc) {
			await Group.update(
				{ group_id: ctx.chat.id },
			  { $pull: { 'settings.gifs': gifId } }
			)
			return ctx.replyWithHTML(ctx.i18n.t('cmd.gif.pull'))
		} else {
			await Group.update(
				{ group_id: ctx.chat.id },
				{ $push: { 'settings.gifs': gifId } }
			)
			return ctx.replyWithHTML(ctx.i18n.t('cmd.gif.push'))
		}
	}
}
