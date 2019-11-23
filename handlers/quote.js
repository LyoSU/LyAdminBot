const https = require('https')
const fs = require('fs')
const { createCanvas, Image, registerFont } = require('canvas')
const sharp = require('sharp')
const runes = require('runes')
const {
  emojipedia
} = require('../helpers')

const emojiDataPatch = './node_modules/emoji-datasource-apple/img/apple/64/'

const fontsDir = 'assets/fonts/'

fs.readdir(fontsDir, (_err, files) => {
  files.forEach((file) => {
    registerFont(`${fontsDir}/${file}`, { family: file })
  })
})

function loadImageFromUrl (url) {
  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => resolve(img)
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

function loadImageFromPatch (patch) {
  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))

    img.src = fs.readFileSync(patch)
  })
}

async function drawMultilineText (ctx, text, entities, fontSize, fillStyle, textX, textY, maxWidth, maxHeight, lineHeight) {
  const charts = runes(text)

  let chartNum = 0

  const styledChart = []

  for (let chartIndex = 0; chartIndex < charts.length; chartIndex++) {
    let chart = charts[chartIndex]

    const style = []

    if (entities && typeof entities === 'object') {
      for (let entitieIndex = 0; entitieIndex < entities.length; entitieIndex++) {
        const entity = entities[entitieIndex]

        if (chartNum + chart.length > entity.offset && chartNum + chart.length < entity.offset + entity.length + 1) {
          if (entity.type === 'bold') style.push('bold')
          if (entity.type === 'italic') style.push('italic')
          if (['pre', 'code'].includes(entity.type)) {
            style.push('monospace')
          }
          if (['mention', 'text_mention', 'hashtag', 'email', 'phone_number', 'bot_command', 'url', 'text_link'].includes(entity.type)) style.push('mention')
        }
      }
    }

    if (entities && typeof entities === 'string') style.push(entities)

    const checkEmoji = emojipedia.getEmoji(chart)

    if (checkEmoji.length > 0) style.push('emoji')

    styledChart.push({
      chart,
      style
    })

    chartNum += chart.length
  }

  const styledWords = []

  let stringNum = 0

  const breakMatch = /<br>|\n|\r/
  const spaceMatch = /\s/

  for (let index = 0; index < styledChart.length; index++) {
    const chartStyle = styledChart[index]
    const lastChart = styledChart[index - 1]

    if (
      lastChart && (
        (chartStyle.style.includes('emoji')) ||
        (chartStyle.chart.match(breakMatch)) ||
        (chartStyle.chart.match(spaceMatch) && !lastChart.chart.match(spaceMatch)) ||
        (lastChart.chart.match(spaceMatch) && !chartStyle.chart.match(spaceMatch)) ||
        (chartStyle.style && lastChart.style && chartStyle.style.toString() !== lastChart.style.toString())
      )
    ) {
      stringNum++
    }

    if (!styledWords[stringNum]) {
      styledWords[stringNum] = {
        word: chartStyle.chart,
        style: chartStyle.style
      }
    } else styledWords[stringNum].word += chartStyle.chart
  }

  let lineX = textX
  let lineY = textY

  let textWidth = 0

  let breakWrite = false

  for (let index = 0; index < styledWords.length; index++) {
    const styledWord = styledWords[index]

    let emoji

    if (styledWord.style.includes('emoji')) {
      const getEmoji = emojipedia.getEmoji(styledWord.word)
      let emojiDb = emojipedia.emojiDb[getEmoji]
      if (emojiDb.redirect) emojiDb = emojipedia.emojiDb[emojiDb.redirect]
      const emojiPng = `${emojiDataPatch}${getEmoji.join('-')}.png`
      try {
        emoji = await loadImageFromPatch(emojiPng)
      } catch (error) {
        emoji = await loadImageFromUrl(emojiDb.image.src)
      }
    } else if (styledWord.style.includes('bold')) {
      ctx.font = `bold ${fontSize}px OpenSans`
      ctx.fillStyle = fillStyle
    } else if (styledWord.style.includes('italic')) {
      ctx.font = `italic ${fontSize}px OpenSans`
      ctx.fillStyle = fillStyle
    } else if (styledWord.style.includes('monospace')) {
      ctx.font = `${fontSize}px monospace`
      ctx.fillStyle = '#5887a7'
    } else if (styledWord.style.includes('mention')) {
      ctx.font = `${fontSize}px mention`
      ctx.fillStyle = '#6ab7ec'
    } else {
      ctx.font = `${fontSize}px OpenSans`
      ctx.fillStyle = fillStyle
    }

    let lineWidth

    if (styledWord.style.includes('emoji')) lineWidth = lineX + fontSize + (fontSize * 0.25)
    else lineWidth = lineX + ctx.measureText(styledWord.word).width

    if (styledWord.word.match(breakMatch) || lineWidth > maxWidth) {
      if (!styledWord.word.match(breakMatch) && lineY + lineHeight > maxHeight) {
        while (lineWidth > maxWidth) {
          styledWord.word = styledWord.word.substr(0, styledWord.word.length - 1)
          lineWidth = lineX + ctx.measureText(styledWord.word).width
        }

        styledWord.word += '…'
        breakWrite = true
      } else {
        lineWidth = textX + ctx.measureText(styledWord.word).width
        lineX = textX
        lineY += lineHeight
      }
    }

    if (lineWidth > textWidth) textWidth = lineWidth

    if (emoji) {
      ctx.drawImage(emoji, lineX, lineY - fontSize, fontSize + 5, fontSize + 5)
    } else {
      ctx.fillText(styledWord.word, lineX, lineY)
    }

    lineX = lineWidth

    if (breakWrite) break
  }

  return {
    width: textWidth,
    height: lineY
  }
}

// https://stackoverflow.com/a/3368118
function drawRoundRect (ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof stroke === 'undefined') {
    stroke = true
  }
  if (typeof radius === 'undefined') {
    radius = 5
  }
  if (typeof radius === 'number') {
    radius = { tl: radius, tr: radius, br: radius, bl: radius }
  } else {
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

// https://codepen.io/andreaswik/pen/YjJqpK
function lightOrDark (color) {
  let r, g, b

  // Check the format of the color, HEX or RGB?
  if (color.match(/^rgb/)) {
    // If HEX --> store the red, green, blue values in separate variables
    color = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)$/)

    r = color[1]
    g = color[2]
    b = color[3]
  } else {
    // If RGB --> Convert it to HEX: http://gist.github.com/983661
    color = +('0x' + color.slice(1).replace(
      color.length < 5 && /./g, '$&$&'
    )
    )

    r = color >> 16
    g = color >> 8 & 255
    b = color & 255
  }

  // HSP (Highly Sensitive Poo) equation from http://alienryderflex.com/hsp.html
  const hsp = Math.sqrt(
    0.299 * (r * r) +
    0.587 * (g * g) +
    0.114 * (b * b)
  )

  // Using the HSP value, determine whether the color is light or dark
  if (hsp > 127.5) {
    return 'light'
  } else {
    return 'dark'
  }
}

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    // settings
    const maxWidth = 512
    const maxHeight = 512

    // set parms
    const replyMessage = ctx.message.reply_to_message

    let messageFrom = replyMessage.from

    if (replyMessage.forward_sender_name) {
      messageFrom = {
        id: 0,
        first_name: replyMessage.forward_sender_name,
        username: 'HiddenSender'
      }
    } else if (replyMessage.forward_from_chat) {
      messageFrom = {
        id: replyMessage.forward_from_chat.id,
        first_name: replyMessage.forward_from_chat.title,
        username: replyMessage.forward_from_chat.username || null
      }
    }

    if (replyMessage.forward_from) messageFrom = replyMessage.forward_from
    let nick = `${messageFrom.first_name} ${messageFrom.last_name || ''}`

    // create canvas
    const canvas = createCanvas(maxWidth, maxHeight)
    const canvasСtx = canvas.getContext('2d')

    // ser background color
    let backgroundColor = '#130f1c'

    if (ctx.group && ctx.group.info.settings.quote.backgroundColor) backgroundColor = ctx.group.info.settings.quote.backgroundColor

    if ((ctx.match && ctx.match[2] === 'random') || backgroundColor === 'random') backgroundColor = `#${(Math.floor(Math.random() * 16777216)).toString(16)}`
    else if (ctx.match && ctx.match[1] === '#' && ctx.match[2]) backgroundColor = `#${ctx.match[2]}`
    else if (ctx.match && ctx.match[2]) backgroundColor = `${ctx.match[2]}`

    canvasСtx.fillStyle = backgroundColor

    // check background style color black/light
    const backStyle = lightOrDark(canvasСtx.fillStyle)

    // defsult color from tdesktop
    // https://github.com/telegramdesktop/tdesktop/blob/67d08c2d4064e04bec37454b5b32c5c6e606420a/Telegram/SourceFiles/data/data_peer.cpp#L43
    // const nickColor = [
    //   '#c03d33',
    //   '#4fad2d',
    //   '#d09306',
    //   '#168acd',
    //   '#8544d6',
    //   '#cd4073',
    //   '#2996ad',
    //   '#ce671b'
    // ]

    // nick light style color
    const nickColorLight = [
      '#862a23',
      '#37791f',
      '#916604',
      '#0f608f',
      '#5d2f95',
      '#8f2c50',
      '#1c6979',
      '#904812'
    ]

    // nick black style color
    const nickColorBlack = [
      '#fb6169',
      '#85de85',
      '#f3bc5c',
      '#65bdf3',
      '#b48bf2',
      '#ff5694',
      '#62d4e3',
      '#faa357'
    ]

    // user nick  color
    // https://github.com/telegramdesktop/tdesktop/blob/67d08c2d4064e04bec37454b5b32c5c6e606420a/Telegram/SourceFiles/data/data_peer.cpp#L43
    const nickIndex = Math.abs(messageFrom.id) % 7
    const nickMap = [0, 7, 4, 1, 6, 3, 5]

    canvasСtx.font = 'bold 22px OpenSans'

    if (backStyle === 'light') canvasСtx.fillStyle = nickColorLight[nickMap[nickIndex]]
    else canvasСtx.fillStyle = nickColorBlack[nickMap[nickIndex]]

    // nick max length

    // if (nickWidth > nickMaxLength) {
    //   while (nickWidth > nickMaxLength) {
    //     nick = nick.substr(0, nick.length - 1)
    //     nickWidth = canvasСtx.measureText(nick).width
    //   }

    //   nick += '…'
    // }

    // render nick
    // canvasСtx.fillText(nick, 110, 30)

    const nickTextSize = await drawMultilineText(canvasСtx, nick, 'bold', 22, canvasСtx.fillStyle, 110, 30, maxWidth, 0, 0)

    const minFontSize = 25
    const maxFontSize = 34

    let preTextSize = 25 / ((replyMessage.text.length / 10) * 0.2)

    if (preTextSize < minFontSize) preTextSize = minFontSize
    if (preTextSize > maxFontSize) preTextSize = maxFontSize

    const lineHeight = 4 * (preTextSize * 0.30)

    canvasСtx.font = `${preTextSize}px OpenSans`

    const drawTextX = 110
    const drawTextY = 45 + canvasСtx.measureText('test').emHeightAscent

    console.time('drawMultilineText')
    const canvasMultilineText = canvas.getContext('2d')

    let textColor = '#fff'
    if (backStyle === 'light') textColor = '#000'

    const textSize = await drawMultilineText(canvasMultilineText, replyMessage.text, replyMessage.entities, preTextSize, textColor, drawTextX, drawTextY, maxWidth, 512, lineHeight)

    console.timeEnd('drawMultilineText')

    let stickHeight = textSize.height - 20
    let stickWidth = textSize.width - 70

    const nickWidth = nickTextSize.width - 70

    if (stickWidth < nickWidth) stickWidth = nickWidth

    if (stickHeight > maxHeight) stickHeight = maxHeight
    if (stickWidth > maxWidth) stickWidth = maxWidth

    let canvasHeight = stickHeight + 40
    let canvasWidth = stickWidth + 90

    const canvasQuote = createCanvas(canvasWidth, canvasHeight)
    const canvasBackСtx = canvasQuote.getContext('2d')

    canvasBackСtx.fillStyle = backgroundColor
    // canvasBackСtx.fillRect(152, 0, 275, stickHeight + 43);
    // canvasBackСtx.fillRect(100, 43, 400, stickHeight - 42);

    const notchLeftUpPic = await loadImageFromPatch('./assets/notch/left_up.png')

    const canvasNotch = createCanvas(72, 43)
    const canvasNotchСtx = canvasNotch.getContext('2d')

    canvasNotchСtx.drawImage(notchLeftUpPic, 0, 0, 72, 43)

    canvasNotchСtx.globalCompositeOperation = 'source-in'

    canvasNotchСtx.fillStyle = backgroundColor
    canvasNotchСtx.fillRect(0, 0, 72, 43)

    canvasBackСtx.drawImage(canvasNotch, 80, 0)

    drawRoundRect(canvasBackСtx, 90, 0, stickWidth, stickHeight + 43, 25, '#fff', false)

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
    } catch (error) {
      avatar = await loadImageFromPatch('./assets/404.png')
    }

    if (avatar) {
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(avatarX + avatarSize, avatarY + avatarSize, avatarSize, 0, Math.PI * 2, true)
      canvasAvatarСtx.clip()
      canvasAvatarСtx.closePath()
      canvasAvatarСtx.restore()
      canvasAvatarСtx.drawImage(avatar, avatarX, avatarY, avatarSize * 2, avatarSize * 2)
    } else {
      canvasAvatarСtx.fillStyle = '#a4b7c4'
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(avatarSize * 2, avatarSize * 2, 40, 0, Math.PI * 2, false)
      canvasAvatarСtx.fill()

      canvasСtx.font = 'bold 55px OpenSans'
      canvasAvatarСtx.fillStyle = '#fff'
      canvasСtx.fillText(messageFrom.first_name.split(/(?!$)/u, 1)[0], 30, 80)
    }

    const canvasQuoteСtx = canvasQuote.getContext('2d')

    canvasQuoteСtx.drawImage(canvas, 0, 0)

    const imageQuoteSharp = sharp(canvasQuote.toBuffer())

    if (stickHeight > stickWidth) imageQuoteSharp.resize({ height: 512 })
    else imageQuoteSharp.resize({ width: 512 })

    const imageMetadata = await sharp(await imageQuoteSharp.toBuffer()).metadata()

    const canvasSticker = createCanvas(imageMetadata.width, imageMetadata.height + 75)
    const canvasStickerСtx = canvasSticker.getContext('2d')

    const imgQuote = new Image()
    imgQuote.src = await imageQuoteSharp.toBuffer()

    canvasStickerСtx.drawImage(imgQuote, 0, 0)

    const imageStickerSharp = sharp(canvasSticker.toBuffer())

    const imageSharpBuffer = await imageStickerSharp.webp({ lossless: true, force: true }).toBuffer()

    await ctx.replyWithDocument({
      source: imageSharpBuffer,
      filename: 'sticker.webp'
    }, {
      reply_to_message_id: replyMessage.message_id
    })
  }
}
