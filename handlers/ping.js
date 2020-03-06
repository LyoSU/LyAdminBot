const humanizeDuration = require('humanize-duration')
const { version } = require('../package.json')
const spawn = require('child_process').spawn
const os = require('os')

function getTempPi () {
  return new Promise((resolve) => {
    const temp = spawn('cat', ['/sys/class/thermal/thermal_zone0/temp'])

    temp.stdout.on('data', (data) => {
      resolve(data.toString())
    })

    temp.stderr.on('data', (data) => {
      resolve({ error: data.toString() })
    })
  })
}

module.exports = async (ctx) => {
  const sms = new Date() - ctx.ms
  const dt = (new Date() / 1000) - ctx.message.date
  let delay = ''

  if (dt > 2) {
    const delayTime = humanizeDuration(dt * 1000, { language: ctx.i18n.locale(), fallbacks: ['en'], round: true })

    delay = ctx.i18n.t('cmd.ping.delay', { delayTime })
  }

  const message = await ctx.replyWithHTML('Pong', {
    reply_to_message_id: ctx.message.message_id
  })
  const tms = new Date() - ctx.ms - sms
  const workTime = humanizeDuration(
    new Date() - global.startDate,
    { language: ctx.i18n.locale(), fallbacks: ['en'], round: true }
  )

  const tmpPi = await getTempPi()

  const usemem = ((os.totalmem() - os.freemem()) / (1024 * 1024)).toFixed(0)
  const totalmem = (os.totalmem() / (1024 * 1024)).toFixed(0)

  let extra = ''

  extra += `Version: ${version}\n\n`

  extra += `💡 Server info:\n`
  extra += `<b>RAM:</b> ${usemem}/${totalmem} MB\n`
  extra += `<b>CPU Load:</b> ${os.loadavg()[0].toFixed(2)}\n`
  if (!tmpPi.error) extra += `<b>Temp:</b> ${(tmpPi / 1000).toFixed(2)} ℃\n`

  extra += '\n'

  extra += delay

  await ctx.telegram.editMessageText(
    message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping.pong', { sms, tms, workTime, extra }),
    { parse_mode: 'HTML' }
  )

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
    ctx.deleteMessage()
  }, 5 * 1000)
}
