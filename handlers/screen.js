const https = require('https')
const { createCanvas, loadImage, Image, registerFont } = require('canvas')
const drawMultilineText = require('canvas-multiline-text')


registerFont('assets/NotoSans-Regular.ttf', { family: 'NotoSans-Regular' })
registerFont('assets/NotoSans-Bold.ttf', { family: 'NotoSans-Bold' })
registerFont('assets/NotoColorEmoji.ttf', { family: 'NotoColorEmoji' })
registerFont('assets/kochi-mincho-subst.ttf', { family: 'kochi-mincho-subst' })

function loadImageFromUrl(url) {
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

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const { text, from } = ctx.message.reply_to_message
    const login = `${from.first_name} ${from.last_name || ''}`

    const canvas = createCanvas(512, 320)

    const quoteTemplate = await loadImage('assets/quote-template.png')

    const canvasСtx = canvas.getContext('2d')

    canvasСtx.drawImage(quoteTemplate, 0, 0)

    canvasСtx.font = '28px NotoSans-Bold, NotoColorEmoji, kochi-mincho-subst'
    canvasСtx.fillStyle = '#fff'
    canvasСtx.fillText(login, 110, 50)

    canvasСtx.font = '28px NotoSans-Regular, NotoColorEmoji, kochi-mincho-subst'
    canvasСtx.fillStyle = '#c9efff'
    canvasСtx.fillText(`@${from.username}`, 110, 90)

    canvasСtx.font = 'NotoSans-Regular, NotoColorEmoji, kochi-mincho-subst'
    canvasСtx.fillStyle = '#e0e0e0'

    drawMultilineText(
      canvasСtx,
      text,
      {
        rect: {
          x: 25,
          y: 110,
          width: canvas.width - 40,
          height: canvas.height - 50,
        },
        font: 'Impact',
        verbose: false,
        lineHeight: 1.2,
        minFontSize: 12,
        maxFontSize: 32,
      }
    )

    const userPhoto = await ctx.telegram.getUserProfilePhotos(from.id, 0, 1)
    const userPhotoUrl = await ctx.telegram.getFileLink(userPhoto.photos[0][0].file_id)

    const canvasAvatarСtx = canvas.getContext('2d')

    canvasAvatarСtx.beginPath()
    canvasAvatarСtx.arc(60, 60, 40, 0, Math.PI * 2, true)
    canvasAvatarСtx.clip()
    canvasAvatarСtx.closePath()
    canvasAvatarСtx.restore()
    canvasAvatarСtx.drawImage(await loadImageFromUrl(userPhotoUrl), 20, 20, 80, 80)

    // const textX = 120
    // let textY = 60
    // const maxWidth = canvas.width - 130
    // const lineHeight = 15

    // const words = text.split(' ')
    // let line = ''

    // for (let index = 0; index < words.length; index++) {
    //   const testLine = `${line + words[index]} `
    //   const metrics = canvasСtx.measureText(testLine)
    //   const testWidth = metrics.width

    //   if (testWidth > maxWidth && index > 0) {
    //     canvasСtx.fillText(line, textX, textY)
    //     line = `${words[index]} `
    //     textY += lineHeight
    //   }
    //   else {
    //     line = testLine
    //   }
    // }
    // canvasСtx.fillText(line, textX, textY)

    ctx.replyWithSticker({
      source: canvas.toBuffer(),
    })
  }
}
