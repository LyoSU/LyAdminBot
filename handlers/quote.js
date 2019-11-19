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

  let textWidth = 0

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

      const lineWidth = ctx.measureText(drawLine).width

      if(lineWidth > textWidth) textWidth = lineWidth

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
    width: lineX,
    height: lineY,
    textWidth
  }
}

function drawRoundRect(ctx, x, y, width, height, radius, fill, stroke) {
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

function lightOrDark(color) {

  // Check the format of the color, HEX or RGB?
  if (color.match(/^rgb/)) {

    // If HEX --> store the red, green, blue values in separate variables
    color = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)$/);

    r = color[1];
    g = color[2];
    b = color[3];
  }
  else {

    // If RGB --> Convert it to HEX: http://gist.github.com/983661
    color = +("0x" + color.slice(1).replace(
      color.length < 5 && /./g, '$&$&'
    )
              );

    r = color >> 16;
    g = color >> 8 & 255;
    b = color & 255;
  }

  // HSP (Highly Sensitive Poo) equation from http://alienryderflex.com/hsp.html
  hsp = Math.sqrt(
    0.299 * (r * r) +
    0.587 * (g * g) +
    0.114 * (b * b)
  );

  // Using the HSP value, determine whether the color is light or dark
  if (hsp>127.5) {
    return 'light'
  }
  else {
    return 'dark'
  }
}

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const maxHeight = 1024
    const maxWidth = 512
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

    const canvas = createCanvas(maxWidth, maxHeight)

    const canvasСtx = canvas.getContext('2d')

    let backColor = '#130f1c'

    if(ctx.match && ctx.match[1] && ctx.match[1] === "random") backColor = `#${(Math.floor(Math.random() * 16777216)).toString(16)}`
    if(ctx.match && ctx.match[2]) backColor = `${ctx.match[2]}`
    if(ctx.match && ctx.match[2] && ctx.match[1] === '#') backColor = `#${ctx.match[2]}`

    canvasСtx.fillStyle = backColor

    const backStyle = lightOrDark(canvasСtx.fillStyle)

    const nickColor = [
      '#c03d33',
      '#4fad2d',
      '#d09306',
      '#168acd',
      '#8544d6',
      '#cd4073',
      '#2996ad',
      '#ce671b',
    ]

    const nickColorLight = [
      '#862a23',
      '#37791f',
      '#916604',
      '#0f608f',
      '#5d2f95',
      '#8f2c50',
      '#1c6979',
      '#904812',
    ]

    const nickColorBlack = [
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

    canvasСtx.font = 'bold 22px OpenSans'

    if(backStyle === 'light') canvasСtx.fillStyle = nickColorLight[nickMap[nickIndex]]
    else canvasСtx.fillStyle = nickColorBlack[nickMap[nickIndex]]

    const nickMaxLength = 330

    let nickWidth = canvasСtx.measureText(nick).width

    if (nickWidth > nickMaxLength) {
      while (nickWidth > nickMaxLength) {
        nick = nick.substr(0, nick.length - 1)
        nickWidth = canvasСtx.measureText(nick).width
      }

      nick += '…'
    }

    canvasСtx.fillText(nick, 110, 30)

    const minFontSize  = 20
    const maxFontSize  = 28

    let preTextSize = 25 / ((replyMessage.text.length / 10) * 0.2)

    if(preTextSize < minFontSize) preTextSize = minFontSize
    if(preTextSize > maxFontSize) preTextSize = maxFontSize

    const lineHeight = 4 * ( preTextSize * 0.25 )

    canvasСtx.font = `${preTextSize}px OpenSans`

    const drawTextX = 110
    const drawTextY = 45 + canvasСtx.measureText('test').emHeightAscent

    console.time('drawMultilineText')
    const canvasMultilineText = canvas.getContext('2d')

    let textColor = '#fff'
    if(backStyle === 'light') textColor = '#000'

    const textSize = drawMultilineText(canvasMultilineText, replyMessage.text, replyMessage.entities, preTextSize, textColor, drawTextX, drawTextY, canvas.width - 20, lineHeight)

    console.timeEnd('drawMultilineText')

    // canvasСtx.font = '15px OpenSans'
    // canvasСtx.fillStyle = usernameColor[nickMap[nickIndex]]
    // canvasСtx.fillStyle = '#5f82a3'

    // if (messageFrom.username) canvasСtx.fillText(`@${messageFrom.username}`, 110, textSize.width + 40)
    // else canvasСtx.fillText(`#${messageFrom.id}`, 110, textSize.width + 40)

    // let groupWatermark = ctx.group.info.title

    // if (ctx.group.info.username) groupWatermark = `@${ctx.group.info.username}`

    // canvasСtx.fillText(groupWatermark, 490 - canvasСtx.measureText(groupWatermark).width, textSize.width + 40)

    let stickHeight = textSize.height - 20
    let stickWidth = textSize.textWidth + 70

    if(textSize.textWidth + 20 < nickWidth) stickWidth = nickWidth + 40

    if (stickHeight > maxHeight) stickHeight = maxHeight
    if (stickWidth > maxWidth) stickWidth = maxWidth

    let canvasHeight = stickHeight
    if(canvasHeight < 512) canvasHeight += 110

    let canvasWidth = stickWidth + 90

    const canvasSticker = createCanvas(canvasWidth, canvasHeight)
    const canvasBackСtx = canvasSticker.getContext('2d')

    canvasBackСtx.fillStyle = backColor
    // canvasBackСtx.fillRect(152, 0, 275, stickHeight + 43);
    // canvasBackСtx.fillRect(100, 43, 400, stickHeight - 42);

    const notchLeftUpPic = await loadImageFromPatch('./assets/notch/left_up.png')

    const canvasNotch = createCanvas(72, 43)
    const canvasNotchСtx = canvasNotch.getContext('2d')

    canvasNotchСtx.drawImage(notchLeftUpPic, 0, 0, 72, 43)

    canvasNotchСtx.globalCompositeOperation = "source-in"

    canvasNotchСtx.fillStyle = backColor
    canvasNotchСtx.fillRect(0, 0, 72, 43)

    canvasBackСtx.drawImage(canvasNotch, 80, 0)

    drawRoundRect(canvasBackСtx, 90, 0, stickWidth, stickHeight + 43, 25, '#fff', false)

    // const notchPic = await loadImageFromPatch('./assets/notch.svg')

    // canvasBackСtx.drawImage(notchPic, 84, 2)

    // const notchRightUpPic = await loadImageFromPatch('./assets/notch/right_up.png')
    // canvasBackСtx.drawImage(notchRightUpPic, 427, 0, 72, 43)

    // const notchLeftBottomPic = await loadImageFromPatch('./assets/notch/left_bottom.png')
    // canvasBackСtx.drawImage(notchLeftBottomPic, 100, stickHeight, 72, 43)

    // const notchRightBottomPic = await loadImageFromPatch('./assets/notch/right_bottom.png')
    // canvasBackСtx.drawImage(notchRightBottomPic, 427, stickHeight, 72, 43)

    const avatarSize = 30

    const avatarX = 10
    const avatarY = 0

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
      canvasAvatarСtx.drawImage(avatar, avatarX, avatarY, avatarSize * 2, avatarSize * 2)
    }
    else {
      canvasAvatarСtx.fillStyle = '#a4b7c4'
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(avatarSize * 2, avatarSize * 2, 40, 0, Math.PI * 2, false)
      canvasAvatarСtx.fill()

      canvasСtx.font = 'bold 55px OpenSans'
      canvasAvatarСtx.fillStyle = '#fff'
      canvasСtx.fillText(messageFrom.first_name.split(/(?!$)/u, 1)[0], 30, 80)
    }

    const canvasStickerСtx = canvasSticker.getContext('2d')

    canvasStickerСtx.drawImage(canvas, 0, 0)

    const imageSharp = sharp(canvasSticker.toBuffer())

    if (stickHeight >= 512) imageSharp.resize({ height: 512 })

    const imageSharpBuffer = await imageSharp.webp({ lossless: true, force: true }).toBuffer()

    await ctx.replyWithDocument({
      source: imageSharpBuffer,
      filename: 'sticker.webp',
    }, {
      reply_to_message_id: replyMessage.message_id,
    })
  }
}
