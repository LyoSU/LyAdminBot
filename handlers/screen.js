const Markup = require('telegraf/markup')
const https = require('https')
const fs = require('fs')
const { createCanvas, Image, registerFont } = require('canvas')


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

function drawMultilineText(ctx, text, entities, fonstSize, textX, textY, maxWidth, lineHeight) {
  const words = text.split(' ')

  let chart = 0
  const line = ''
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
        ctx.font = `bold ${fonstSize}px OpenSans`
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
            }
          }

          ctx.fillText(letter, lineX, lineY)
          lineX += ctx.measureText(letter).width
          ctx.font = `${fonstSize}px OpenSans`

          chart += 1
          word = word.substr(chart - lettersIndex)
        }

        for (let entitieIndex = 0; entitieIndex < entities.length; entitieIndex++) {
          const entity = entities[entitieIndex]

          if (chart + word.length > entity.offset && chart < entity.offset + entity.length + 1) {

          }

          // console.log(wordEntity)
          // console.log(word.substr(chart + entity.length))
        }
      }

      ctx.fillText(word, lineX, lineY)

      lineX += ctx.measureText(word).width
    }

    chart += word.length

    // let word = words[index]

    // if (word === '<br>') {
    //   ctx.fillText(line, textX, textY)
    //   line = ''
    //   textY += lineHeight
    // }
    // else {
    //   const testLine = `${line + word} `
    //   const metrics = ctx.measureText(testLine)
    //   const testWidth = metrics.width

    //   if (testWidth > maxWidth && index > 0 && line !== '') {
    //     ctx.fillText(line, textX, textY)
    //     line = `${word} `
    //     textY += lineHeight
    //   }
    //   else {
    //     line = testLine
    //   }
    // }
  }
  // ctx.fillText(line, textX, textY)

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
    const replyMessage = ctx.message.reply_to_message
    const nick = `${replyMessage.from.first_name} ${replyMessage.from.last_name || ''}`

    const canvas = createCanvas(512, 512)

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

    const nickIndex = replyMessage.from.id % 7
    const nickMap = [0, 7, 4, 1, 6, 3, 5]

    canvasСtx.font = 'bold 23px OpenSans'
    canvasСtx.fillStyle = nickColor[nickMap[nickIndex]]
    canvasСtx.fillText(nick, 110, 50)

    canvasСtx.font = '30px OpenSans'
    canvasСtx.fillStyle = usernameColor[nickMap[nickIndex]]
    if (replyMessage.from.username) canvasСtx.fillText(`@${replyMessage.from.username}`, 110, 90)
    else canvasСtx.fillText(`#${replyMessage.from.id}`, 110, 90)

    canvasСtx.font = '28px OpenSans'
    canvasСtx.fillStyle = '#fff'

    const textSize = drawMultilineText(canvasСtx, replyMessage.text, replyMessage.entities, 28, 25, 140, canvas.width - 40, 30)

    const canvasAvatarСtx = canvas.getContext('2d')

    const userPhoto = await ctx.telegram.getUserProfilePhotos(replyMessage.from.id, 0, 1)

    if (userPhoto.photos[0]) {
      const userPhotoUrl = await ctx.telegram.getFileLink(userPhoto.photos[0][0].file_id)

      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(60, 60, 40, 0, Math.PI * 2, true)
      canvasAvatarСtx.clip()
      canvasAvatarСtx.closePath()
      canvasAvatarСtx.restore()
      canvasAvatarСtx.drawImage(await loadImageFromUrl(userPhotoUrl), 20, 20, 80, 80)
    }
    else {
      canvasAvatarСtx.fillStyle = '#a4b7c4'
      canvasAvatarСtx.beginPath()
      canvasAvatarСtx.arc(60, 60, 40, 0, Math.PI * 2, false)
      canvasAvatarСtx.fill()

      canvasСtx.font = 'bold 55px OpenSans'
      canvasAvatarСtx.fillStyle = '#fff'
      canvasСtx.fillText(replyMessage.from.first_name.split(/(?!$)/u, 1)[0], 30, 80)
    }

    let stickHeight = 512

    if (textSize.width < stickHeight) stickHeight = textSize.width + 30

    const canvasSticker = createCanvas(512, stickHeight)

    const canvasBackСtx = canvasSticker.getContext('2d')

    canvasBackСtx.fillStyle = '#1e2c3a'
    roundRect(canvasBackСtx, 10, 10, 492, stickHeight - 10, 20, true)

    const canvasStickerСtx = canvasSticker.getContext('2d')

    canvasStickerСtx.drawImage(canvas, 0, 0)

    ctx.replyWithSticker({
      source: canvasSticker.toBuffer(),
    }, {
      reply_to_message_id: replyMessage.message_id,
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton('add', 'add'),
      ]),
    })
  }
}
