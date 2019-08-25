const Markup = require('telegraf/markup')
const https = require('https')
const fs = require('fs')
const { createCanvas, Image, registerFont } = require('canvas')
const sharp = require('sharp')


const fontsDir = 'assets/fonts/'

fs.readdir(fontsDir, (err, files) => {
  files.forEach((file) => {
    registerFont(`${fontsDir}/${file}`, { family: file })
  })
})

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    img.onload = () => resolve(img)
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    img.onerror = () => reject(new Error('Failed to load image'))

    https.get(url, (res) => {
      const chunks = []

      res.on('error', (err) => {
        reject(err)
      })
      res.on('data', (chunk) => {
        chunks.push(chunk)
      })
      res.on('end', () => {
        img.src = Buffer.concat(chunks)
      })
    })
  })
}

function drawMultilineText(ctx, text, entities, fonstSize, fillStyle, textX, textY, maxWidth, lineHeight) {
  const words = text.split(' ')

  ctx.font = `${fonstSize}px OpenSans`
  ctx.fillStyle = fillStyle

  let chart = 0
  let lineX = textX
  let lineY = textY

  for (let index = 0; index < words.length; index++) {
    let word = `${words[index]} `

    if (lineX + ctx.measureText(word).width > maxWidth) {
      lineX = textX
      lineY += lineHeight
    }

    const matchBoldStart = word.search(/<b>/)

    if (matchBoldStart >= 0) {
      const wordSplit = word.split(/<b>/)

      for (let wsIndex = 0; wsIndex < wordSplit.length; wsIndex++) {
        ctx.font = `bold ${fonstSize}px`
        ctx.fillText(wordSplit[wsIndex], lineX, lineY)
        lineX += ctx.measureText(`${wordSplit[wsIndex]}`).width
      }
    }

    const matchBreak = word.search(/<br>|\n|\r/)

    if (matchBreak >= 0) {
      const wordSplit = word.split(/<br>|\n|\r/)

      for (let wsIndex = 0; wsIndex < wordSplit.length; wsIndex++) {
        ctx.fillText(wordSplit[wsIndex], lineX, lineY)
        if (wsIndex < wordSplit.length - 1) {
          lineX = textX
          lineY += lineHeight
        }
        else {
          lineX += ctx.measureText(`${wordSplit[wsIndex]} `).width
        }
      }
    }
    else {
      if (entities) {
        const letters = word.split(/(?!$)/u)

        for (let lettersIndex = 0; lettersIndex < letters.length; lettersIndex++) {
          const letter = letters[lettersIndex]

          for (let entitieIndex = 0; entitieIndex < entities.length; entitieIndex++) {
            const entity = entities[entitieIndex]

            if (chart + letter.length > entity.offset && chart + letter.length < entity.offset + entity.length + 1) {
              if (entity.type === 'bold') ctx.font = `bold ${ctx.font}`
              if (entity.type === 'italic') ctx.font = `italic ${ctx.font}`
              if (['pre', 'code'].includes(entity.type)) {
                ctx.font = `Monospace ${fonstSize * 0.8}px OpenSans`
                ctx.fillStyle = '#5887a7'
              }
              if (['mention', 'hashtag', 'email', 'phone_number', 'bot_command', 'url', 'text_link'].includes(entity.type)) ctx.fillStyle = '#6ab7ec'
            }
          }

          ctx.fillText(letter, lineX, lineY)
          lineX += ctx.measureText(letter).width

          ctx.font = `${fonstSize}px OpenSans`
          ctx.fillStyle = fillStyle

          chart += 1
          word = word.substr(chart - lettersIndex)
        }
      }

      ctx.fillText(word, lineX, lineY)

      lineX += ctx.measureText(word).width
    }

    chart += word.length
  }

  return {
    height: textX,
    width: lineY,
  }
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof stroke === 'undefined') {
    stroke = true
  }
  if (typeof radius === 'undefined') {
    radius = 5
  }
  if (typeof radius === 'number') {
    radius = { tl: radius, tr: radius, br: radius, bl: radius }
  }
  else {
    const defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 }

    for (const side in defaultRadius) {
      radius[side] = radius[side] || defaultRadius[side]
    }
  }
  ctx.beginPath()
  ctx.moveTo(x + radius.tl, y)
  ctx.lineTo(x + width - radius.tr, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr)
  ctx.lineTo(x + width, y + height - radius.br)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height)
  ctx.lineTo(x + radius.bl, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl)
  ctx.lineTo(x, y + radius.tl)
  ctx.quadraticCurveTo(x, y, x + radius.tl, y)
  ctx.closePath()
  if (fill) {
    ctx.fill()
  }
  if (stroke) {
    ctx.stroke()
  }
}

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const maxHeight = 1024
    const replyMessage = ctx.message.reply_to_message
    let messageFrom = replyMessage.from

    if (replyMessage.forward_from) messageFrom = replyMessage.forward_from
    const nick = `${messageFrom.first_name} ${messageFrom.last_name || ''}`

    const canvas = createCanvas(512, maxHeight)

    const canvasСtx = canvas.getContext('2d')

    const nickColor = [
      '#fdacb0',
      '#c1eec1',
      '#f8d9a3',
      '#acdbf9',
      '#e0d0fa',
      '#ffa3c4',
      '#a3e6ef',
      '#fccca1',
    ]

    const usernameColor = [
      '#fb6169',
      '#85de85',
      '#f3bc5c',
      '#65bdf3',
      '#b48bf2',
      '#ff5694',
      '#62d4e3',
      '#faa357',
    ]

    const nickIndex = messageFrom.id % 7
    const nickMap = [0, 7, 4, 1, 6, 3, 5]

    canvasСtx.font = 'bold 21px OpenSans'
    canvasСtx.fillStyle = nickColor[nickMap[nickIndex]]

    canvasСtx.fillText(nick, 90, 35)

    canvasСtx.font = '28px OpenSans'
    canvasСtx.fillStyle = usernameColor[nickMap[nickIndex]]
    if (messageFrom.username) canvasСtx.fillText(`@${messageFrom.username}`, 90, 70)
    else canvasСtx.fillText(`#${messageFrom.id}`, 90, 70)

    const textSize = drawMultilineText(canvasСtx, replyMessage.text, replyMessage.entities, 26, '#fff', 10, 115, canvas.width - 10, 30)

    let groupWatermark = ctx.group.info.title

    if (ctx.group.info.username) groupWatermark = `@${ctx.group.info.username}`

    canvasСtx.font = '15px OpenSans'
    canvasСtx.fillStyle = '#5f82a3'
    canvasСtx.fillText(groupWatermark, 500 - canvasСtx.measureText(groupWatermark).width, textSize.width + 30)

    const canvasAvatarСtx = canvas.getContext('2d')

    let userPhotoUrl = 'https://vk.com/images/contact_2x.png'

    const userPhoto = await ctx.telegram.getUserProfilePhotos(messageFrom.id, 0, 1)

    if (userPhoto.photos[0]) userPhotoUrl = await ctx.telegram.getFileLink(userPhoto.photos[0][0].file_id)

    const avatar = await loadImageFromUrl(userPhotoUrl)

    if (avatar) {
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(45, 45, 35, 0, Math.PI * 2, true)
      canvasAvatarСtx.clip()
      canvasAvatarСtx.closePath()
      canvasAvatarСtx.restore()
      canvasAvatarСtx.drawImage(avatar, 10, 10, 70, 70)
    }
    else {
      canvasAvatarСtx.fillStyle = '#a4b7c4'
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(60, 60, 40, 0, Math.PI * 2, false)
      canvasAvatarСtx.fill()

      canvasСtx.font = 'bold 55px OpenSans'
      canvasAvatarСtx.fillStyle = '#fff'
      canvasСtx.fillText(messageFrom.first_name.split(/(?!$)/u, 1)[0], 30, 80)
    }

    let stickHeight = textSize.width + 45

    if (stickHeight > maxHeight) stickHeight = maxHeight

    const canvasSticker = createCanvas(512, stickHeight)
    const canvasBackСtx = canvasSticker.getContext('2d')

    canvasBackСtx.fillStyle = '#1e2c3a'
    roundRect(canvasBackСtx, 0, 0, 512, stickHeight, 20, true)

    const canvasStickerСtx = canvasSticker.getContext('2d')

    canvasStickerСtx.drawImage(canvas, 0, 0)

    const imageSharp = sharp(canvasSticker.toBuffer())

    if (stickHeight >= 512) imageSharp.resize({ height: 512 })

    const imageSharpBuffer = await imageSharp.webp({ quality: 100 }).png({ compressionLevel: 9, force: false }).toBuffer()

    await ctx.replyWithDocument({
      source: imageSharpBuffer,
      filename: 'sticker.webp',
    }, {
      reply_to_message_id: replyMessage.message_id,
    })
  }
}
