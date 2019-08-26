const https = require('https')
const Stream = require('stream').Transform
const sharp = require('sharp')


const downloadFileByUrl = (fileUrl) => new Promise(async (resolve, reject) => {
  const data = new Stream()

  https.get(fileUrl, (response) => {
    response.on('data', (chunk) => {
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(data)
    })
  }).on('error', reject)
})

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message) {
    const replyMessage = ctx.message.reply_to_message

    const stickerLinkPrefix = 'https://t.me/addstickers/'
    let stickerFile

    if (replyMessage.sticker) {
      if (replyMessage.sticker.is_animated === true) {
        ctx.replyWithHTML(ctx.i18n.t('sticker.save.error.animated'), {
          reply_to_message_id: ctx.message.message_id,
        })
      }
      else {
        stickerFile = replyMessage.sticker
      }
    }
    else if (replyMessage.document) {
      if (['image/jpeg', 'image/png'].indexOf(replyMessage.document.mime_type) >= 0) {
        stickerFile = replyMessage.document
      }
    }
    else if (replyMessage.photo) {
      // eslint-disable-next-line prefer-destructuring
      stickerFile = replyMessage.photo.slice(-1)[0]
      if (replyMessage.caption) stickerFile.emoji = replyMessage.caption
    }

    if (stickerFile) {
      if (!ctx.match[1] && ctx.group.info.stickerSet.name && ctx.group.info.stickerSet.name === stickerFile.set_name) {
        const deleteStickerFromSet = ctx.telegram.deleteStickerFromSet(stickerFile.file_id).catch((error) => {
          ctx.replyWithHTML(ctx.i18n.t('sticker.delete.error.telegram', {
            error,
          }))
        })

        if (deleteStickerFromSet === true) {
          ctx.replyWithHTML(ctx.i18n.t('sticker.delete.suc', {
            link: `${stickerLinkPrefix}${ctx.group.info.stickerSet.name}`,
          }), {
            reply_to_message_id: ctx.message.message_id,
          })
        }
      }
      else {
        const fileUrl = await ctx.telegram.getFileLink(stickerFile)
        const data = await downloadFileByUrl(fileUrl)
        const imageSharp = sharp(data.read())
        const imageMetadata = await imageSharp.metadata()

        if (imageMetadata.height >= imageMetadata.width) imageSharp.resize({ height: 512 })
        else imageSharp.resize({ width: 512 })

        const stickerPNG = await imageSharp.webp({ quality: 100 }).png({ compressionLevel: 9, force: false }).toBuffer()

        let stickerAdd = false
        let emojis = ''

        if (ctx.match[1]) emojis += ctx.match[1]
        if (stickerFile.emoji) emojis += stickerFile.emoji
        emojis += '🌟'

        if (!ctx.group.info.stickerSet.name) {
          const packName = `g${Math.random().toString(36).substring(5)}_${Math.abs(ctx.group.info.group_id)}_by_${ctx.options.username}`
          const packTitle = `${ctx.group.info.title.substring(0, 30)} pack by @${ctx.options.username}`

          const chatAdministrators = await ctx.getChatAdministrators()

          stickerAdd = await ctx.telegram.createNewStickerSet(chatAdministrators[0].user.id, packName, packTitle, {
            png_sticker: { source: stickerPNG },
            emojis,
          }).catch((error) => {
            ctx.replyWithHTML(ctx.i18n.t('sticker.save.error.telegram', {
              error,
            }))
          })

          if (stickerAdd) {
            ctx.group.info.stickerSet.name = packName
            ctx.group.info.stickerSet.create = true
          }
        }
        else {
          stickerAdd = await ctx.telegram.addStickerToSet(ctx.from.id, ctx.group.info.stickerSet.name, {
            png_sticker: { source: stickerPNG },
            emojis,
          }).catch((error) => {
            if (error.description === 'Bad Request: STICKERSET_INVALID') ctx.group.info.stickerSet = null

            ctx.replyWithHTML(ctx.i18n.t('sticker.save.error.telegram', {
              error,
            }))
          })
        }

        if (stickerAdd) {
          ctx.replyWithHTML(ctx.i18n.t('sticker.save.suc', {
            link: `${stickerLinkPrefix}${ctx.group.info.stickerSet.name}`,
          }), {
            reply_to_message_id: ctx.message.message_id,
          })
        }

        // ctx.telegram.setChatStickerSet(ctx.chat.id, ctx.group.info.stickerSet.name)
      }
    }
  }
}
