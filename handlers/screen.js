const https = require('https')
const { createCanvas, Image, registerFont } = require('canvas')


registerFont('assets/NotoSans-Regular.ttf', { family: 'NotoSans-Regular' })
registerFont('assets/NotoSans-Bold.ttf', { family: 'NotoSans-Bold' })
registerFont('assets/kochi-mincho-subst.ttf', { family: 'kochi-mincho-subst' })

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

function drawMultilineText(ctx, text, textX, textY, maxWidth, lineHeight) {
  const words = text.replace(/\n|\r/g, ' <br> ').split(' ')

  let line = ''

  for (let index = 0; index < words.length; index++) {
    if (words[index] === '<br>') {
      ctx.fillText(line, textX, textY)
      line = ''
      textY += lineHeight
    }
    else {
      const testLine = `${line + words[index]} `
      const metrics = ctx.measureText(testLine)
      const testWidth = metrics.width

      if (testWidth > maxWidth && index > 0) {
        ctx.fillText(line, textX, textY)
        line = `${words[index]} `
        textY += lineHeight
      }
      else {
        line = testLine
      }
    }
  }
  ctx.fillText(line, textX, textY)

  return {
    height: textX,
    width: textY,
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

    for (let side in defaultRadius) {
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
    const { text, from } = ctx.message.reply_to_message
    const login = `${from.first_name} ${from.last_name || ''}`

    const canvas = createCanvas(512, 512)

    const canvasСtx = canvas.getContext('2d')

    canvasСtx.font = '26px NotoSans-Bold, kochi-mincho-subst'
    canvasСtx.fillStyle = '#fff'
    canvasСtx.fillText(login, 110, 50)

    canvasСtx.font = '28px NotoSans-Regular, kochi-mincho-subst'
    canvasСtx.fillStyle = '#c9efff'
    canvasСtx.fillText(`@${from.username}`, 110, 90)

    canvasСtx.font = '23px NotoSans-Regular, kochi-mincho-subst'
    canvasСtx.fillStyle = '#fff'

    const textSize = drawMultilineText(canvasСtx, text, 25, 130, canvas.width - 40, 30)

    const userPhoto = await ctx.telegram.getUserProfilePhotos(from.id, 0, 1)
    const userPhotoUrl = await ctx.telegram.getFileLink(userPhoto.photos[0][0].file_id)

    const canvasAvatarСtx = canvas.getContext('2d')

    canvasAvatarСtx.beginPath()
    canvasAvatarСtx.arc(60, 60, 40, 0, Math.PI * 2, true)
    canvasAvatarСtx.clip()
    canvasAvatarСtx.closePath()
    canvasAvatarСtx.restore()
    canvasAvatarСtx.drawImage(await loadImageFromUrl(userPhotoUrl), 20, 20, 80, 80)

    let stickHeight = 512

    if (textSize.width < stickHeight) stickHeight = textSize.width + 30

    const canvasSticker = createCanvas(512, stickHeight)

    const canvasBackСtx = canvasSticker.getContext('2d')

    canvasBackСtx.fillStyle = '#7592a6'
    roundRect(canvasBackСtx, 10, 10, 492, stickHeight - 10, 20, true)

    const canvasStickerСtx = canvasSticker.getContext('2d')

    canvasStickerСtx.drawImage(canvas, 0, 0)

    ctx.replyWithSticker({
      source: canvasSticker.toBuffer(),
    })
  }
}
