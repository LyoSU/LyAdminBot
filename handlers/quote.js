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

function loadImageFromPatch(patch) {
  return new Promise((resolve, reject) => {
    const img = new Image()

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    img.onload = () => resolve(img)
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    img.onerror = () => reject(new Error('Failed to load image'))

    img.src = fs.readFileSync(patch)
  })
}

function drawMultilineText(ctx, text, entities, fonstSize, fillStyle, textX, textY, maxWidth, lineHeight) {
  const charts = text.split(/(?!$)/u)

  let lineX = textX
  let lineY = textY

  const words = text.split(' ')
  let chartNum = 0
  let wordNum = 0
  let drawLine = ''

  const defaultFont = `${fonstSize}px OpenSans`
  const defaultFillStyle = fillStyle

  let preFont = null
  let preFillStyle = null

  let nextFont = defaultFont
  let nextFillStyle = defaultFillStyle

  for (let chartIndex = 0; chartIndex < charts.length; chartIndex++) {
    let chart = charts[chartIndex]

    chartNum += charts[chartIndex].length
    drawLine += chart

    if (entities) {
      let styled = false

      for (let entitieIndex = 0; entitieIndex < entities.length; entitieIndex++) {
        const entity = entities[entitieIndex]

        if (chartNum + chart.length > entity.offset && chartNum + chart.length < entity.offset + entity.length + 1) {
          styled = true

          if (entity.type === 'bold') nextFont = `bold ${fonstSize}px OpenSans`
          if (entity.type === 'italic') nextFont = `italic ${fonstSize}px OpenSans`
          if (['pre', 'code'].includes(entity.type)) {
            nextFont = `${fonstSize * 0.8}px OpenSans`
            nextFillStyle = '#5887a7'
          }
          if (['mention', 'text_mention', 'hashtag', 'email', 'phone_number', 'bot_command', 'url', 'text_link'].includes(entity.type)) nextFillStyle = '#6ab7ec'
        }

        if (styled === false) {
          nextFont = defaultFont
          nextFillStyle = defaultFillStyle
        }
      }
    }

    let drawText = ''
    let nextLineX = lineX
    let nextLineY = lineY

    if (preFont !== nextFont || preFillStyle !== nextFillStyle) {
      drawText = drawLine
      nextLineX += ctx.measureText(drawText).width
    }

    if (chart === ' ') {
      wordNum++
      if (lineX + ctx.measureText(drawLine + words[wordNum]).width > maxWidth) {
        drawText = drawLine
        nextLineX = textX
        nextLineY += lineHeight
        chart = ''
      }
    }

    if (chart.match(/<br>|\n|\r/)) {
      drawText = drawLine
      nextLineX = textX
      nextLineY += lineHeight
      chart = ''
    }

    if (charts.length === chartIndex + 1) {
      drawText = drawLine
    }


    if (drawText) {
      if (preFont === null) ctx.font = nextFont
      if (preFillStyle === null) ctx.fillStyle = nextFillStyle

      ctx.fillText(drawText, lineX, lineY)

      lineX = nextLineX
      lineY = nextLineY

      preFont = nextFont
      preFillStyle = nextFillStyle

      ctx.font = preFont
      ctx.fillStyle = preFillStyle

      drawLine = ''
    }
  }

  return {
    height: lineX,
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

    if (replyMessage.forward_sender_name) {
      messageFrom = {
        id: 0,
        first_name: replyMessage.forward_sender_name,
        username: 'HiddenSender',
      }
    } else if (replyMessage.forward_from_chat) {
      messageFrom = {
        id: replyMessage.forward_from_chat.id,
        first_name: replyMessage.forward_from_chat.title,
        username: replyMessage.forward_from_chat.username || null,
      }
    }

    if (replyMessage.forward_from) messageFrom = replyMessage.forward_from
    let nick = `${messageFrom.first_name} ${messageFrom.last_name || ''}`

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

    const nickIndex = Math.abs(messageFrom.id) % 7
    const nickMap = [0, 7, 4, 1, 6, 3, 5]

    canvasСtx.font = 'bold 26px OpenSans'
    canvasСtx.fillStyle = nickColor[nickMap[nickIndex]]

    const nickMaxLength = 380

    let nickLength = canvasСtx.measureText(nick).width

    if (nickLength > nickMaxLength) {
      while (nickLength > nickMaxLength) {
        nick = nick.substr(0, nick.length - 1)
        nickLength = canvasСtx.measureText(nick).width
      }

      nick += '…'
    }

    canvasСtx.fillText(nick, 100, 35)

    const minFontSize  = 22
    const maxFontSize  = 48

    let preTextSize = 25 / ((replyMessage.text.length / 10) * 0.2)

    if(preTextSize < minFontSize) preTextSize = minFontSize
    if(preTextSize > maxFontSize) preTextSize = maxFontSize

    const lineHeight = 4 * ( preTextSize * 0.25 )

    canvasСtx.font = `${preTextSize}px OpenSans`

    const drawTextX = 100
    const drawTextY = 45 + canvasСtx.measureText('test').emHeightAscent

    console.time('drawMultilineText')
    const canvasMultilineText = canvas.getContext('2d')
    const textSize = drawMultilineText(canvasMultilineText, replyMessage.text, replyMessage.entities, preTextSize, '#fff', drawTextX, drawTextY, canvas.width - 10, lineHeight)

    console.timeEnd('drawMultilineText')

    canvasСtx.font = '15px OpenSans'
    canvasСtx.fillStyle = usernameColor[nickMap[nickIndex]]
    // canvasСtx.fillStyle = '#5f82a3'

    if (messageFrom.username) canvasСtx.fillText(`@${messageFrom.username}`, 100, textSize.width + 40)
    else canvasСtx.fillText(`#${messageFrom.id}`, 100, textSize.width + 40)

    let groupWatermark = ctx.group.info.title

    if (ctx.group.info.username) groupWatermark = `@${ctx.group.info.username}`

    canvasСtx.fillText(groupWatermark, 500 - canvasСtx.measureText(groupWatermark).width, textSize.width + 40)

    let stickHeight = textSize.width + 55

    if (stickHeight > maxHeight) stickHeight = maxHeight

    const canvasSticker = createCanvas(512, stickHeight)
    const canvasBackСtx = canvasSticker.getContext('2d')

    canvasBackСtx.fillStyle = '#1e2c3a'
    roundRect(canvasBackСtx, 90, 0, 415, stickHeight, 20, true)

    const notchPic = await loadImageFromPatch('./assets/qnotch.png')
    canvasBackСtx.drawImage(notchPic, 65, textSize.width + 20, 40, 40)

    const avatarSize = 35

    const avatarX = 10
    const avatarY = textSize.width - avatarSize + 20

    const canvasAvatarСtx = canvas.getContext('2d')

    let userPhotoUrl = ''
    let avatar

    try {
      if (messageFrom.username) userPhotoUrl = `https://telega.one/i/userpic/320/${messageFrom.username}.jpg`

      const getChat = await ctx.telegram.getChat(messageFrom.id)
      const userPhoto = getChat.photo.small_file_id

      if (userPhoto) userPhotoUrl = await ctx.telegram.getFileLink(userPhoto)

      avatar = await loadImageFromUrl(userPhotoUrl)
    }
    catch (error) {
      avatar = await loadImageFromPatch('./assets/404.png')
    }

    if (avatar) {
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(avatarX + avatarSize, avatarY + avatarSize, avatarSize, 0, Math.PI * 2, true)
      canvasAvatarСtx.clip()
      canvasAvatarСtx.closePath()
      canvasAvatarСtx.restore()
      canvasAvatarСtx.drawImage(avatar, avatarX, avatarY, 70, 70)
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
