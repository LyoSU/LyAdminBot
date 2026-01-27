const humanizeDuration = require('humanize-duration')
const { version } = require('../package.json')
const spawn = require('child_process').spawn
const os = require('os')
const { scheduleDeletion } = require('../helpers/message-cleanup')

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
  const sms = new Date() - ctx.state.startMs
  const dt = (new Date() / 1000) - ctx.message.date
  let delay = ''

  if (dt > 2) {
    const delayTime = humanizeDuration(dt * 1000, { language: ctx.i18n.locale(), fallbacks: ['en'], round: true })

    delay = ctx.i18n.t('cmd.ping.delay', { delayTime })
  }

  const message = await ctx.replyWithHTML('Pong', {
    reply_to_message_id: ctx.message.message_id
  })
  const tms = new Date() - ctx.state.startMs - sms
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

  // Easter egg for fast/slow response
  let pingKey = 'cmd.ping.pong'
  const totalMs = sms + tms
  if (totalMs < 50) {
    pingKey = 'cmd.ping.easter.fast'
  } else if (totalMs > 2000 || dt > 5) {
    pingKey = 'cmd.ping.easter.slow'
  }

  await ctx.telegram.editMessageText(
    message.chat.id, message.message_id, null,
    ctx.i18n.t(pingKey, { sms, tms, workTime, extra }),
    { parse_mode: 'HTML' }
  )

  // Schedule auto-delete after 5 seconds (persistent)
  if (ctx.db) {
    const delayMs = 5 * 1000
    // Delete bot's response
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: message.message_id,
      delayMs,
      source: 'cmd_ping'
    }, ctx.telegram)
    // Delete user's command
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs,
      source: 'cmd_ping'
    }, ctx.telegram)
  }
}
