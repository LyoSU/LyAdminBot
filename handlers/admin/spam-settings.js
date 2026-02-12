const { btnIcons } = require('../../helpers/emoji-map')

/**
 * Build inline keyboard for spam settings
 */
const buildKeyboard = (settings, i18n) => {
  const enabled = settings.enabled
  const globalBan = settings.globalBan !== false

  return {
    inline_keyboard: [
      [
        {
          text: enabled
            ? i18n.t('cmd.spam_settings.btn.disable')
            : i18n.t('cmd.spam_settings.btn.enable'),
          callback_data: `spam:toggle:${enabled ? 'off' : 'on'}`,
          icon_custom_emoji_id: enabled ? btnIcons.disable : btnIcons.enable
        }
      ],
      [
        {
          text: globalBan
            ? i18n.t('cmd.spam_settings.btn.globalban_on')
            : i18n.t('cmd.spam_settings.btn.globalban_off'),
          callback_data: `spam:globalban:${globalBan ? 'off' : 'on'}`,
          icon_custom_emoji_id: btnIcons.globalBan
        }
      ],
      [
        {
          text: i18n.t('cmd.spam_settings.btn.rules'),
          callback_data: 'spam:rules:show',
          icon_custom_emoji_id: btnIcons.rules
        },
        {
          text: i18n.t('cmd.spam_settings.btn.trusted'),
          callback_data: 'spam:trusted:show',
          icon_custom_emoji_id: btnIcons.trusted
        }
      ],
      [
        {
          text: i18n.t('cmd.spam_settings.btn.help'),
          callback_data: 'spam:help:show',
          icon_custom_emoji_id: btnIcons.help
        }
      ]
    ]
  }
}

/**
 * Format status message
 */
const formatStatusMessage = (settings, i18n) => {
  const status = settings.enabled
    ? i18n.t('cmd.spam_settings.status.enabled_text')
    : i18n.t('cmd.spam_settings.status.disabled_text')

  const globalBanStatus = settings.globalBan !== false
    ? i18n.t('cmd.spam_settings.status.globalban_enabled')
    : i18n.t('cmd.spam_settings.status.globalban_disabled')

  const threshold = settings.confidenceThreshold || 70

  let message = `${i18n.t('cmd.spam_settings.status.title')}\n\n`
  message += `<b>Статус:</b> ${status}\n`
  message += `<b>Глобальний бан:</b> ${globalBanStatus}\n`
  message += `<b>Поріг впевненості:</b> ${threshold}%\n`

  if (settings.customRules && settings.customRules.length > 0) {
    message += `<b>Правила:</b> ${settings.customRules.length}\n`
  }

  if (settings.trustedUsers && settings.trustedUsers.length > 0) {
    message += `<b>Довірені:</b> ${settings.trustedUsers.length}\n`
  }

  return message
}

/**
 * Initialize spam settings if needed
 */
const initializeSettings = (ctx) => {
  if (!ctx.group.info.settings.openaiSpamCheck) {
    ctx.group.info.settings.openaiSpamCheck = {
      enabled: true,
      globalBan: true,
      confidenceThreshold: 70,
      customRules: [],
      trustedUsers: []
    }
  }

  const settings = ctx.group.info.settings.openaiSpamCheck

  // Ensure all fields exist (for groups created before these settings)
  if (!settings.trustedUsers) {
    settings.trustedUsers = []
  }
  if (!settings.customRules) {
    settings.customRules = []
  }
  if (settings.confidenceThreshold === undefined) {
    settings.confidenceThreshold = 70
  }

  return settings
}

/**
 * Handle !spam command
 */
const handleSpamCommand = async (ctx) => {
  const args = ctx.message.text.split(' ')
  const command = args[1] && args[1].toLowerCase()

  const settings = initializeSettings(ctx)

  switch (command) {
    case 'on':
      settings.enabled = true
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.enabled'))

    case 'off':
      settings.enabled = false
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.disabled'))

    case 'globalban': {
      const subCommand = args[2] && args[2].toLowerCase()
      if (subCommand === 'on') {
        settings.globalBan = true
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.globalban.enabled'))
      } else if (subCommand === 'off') {
        settings.globalBan = false
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.globalban.disabled'))
      } else {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.globalban.error'))
      }
    }

    case 'allow': {
      const ruleText = args.slice(2).join(' ')
      if (!ruleText.trim()) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.allow.error'))
      }
      settings.customRules.push(`ALLOW: ${ruleText.trim()}`)
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.allow.added', { rule: ruleText.trim() }))
    }

    case 'deny': {
      const ruleText = args.slice(2).join(' ')
      if (!ruleText.trim()) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.deny.error'))
      }
      settings.customRules.push(`DENY: ${ruleText.trim()}`)
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.deny.added', { rule: ruleText.trim() }))
    }

    case 'remove': {
      const ruleIndex = parseInt(args[2]) - 1
      if (isNaN(ruleIndex) || ruleIndex < 0 || ruleIndex >= settings.customRules.length) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.remove.error'))
      }
      const removedRule = settings.customRules.splice(ruleIndex, 1)[0]
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.remove.success', { rule: removedRule }))
    }

    case 'clear': {
      const rulesCount = settings.customRules.length
      settings.customRules = []
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.clear', { count: rulesCount }))
    }

    case 'trust': {
      return handleTrustCommand(ctx, args, settings)
    }

    case 'untrust': {
      return handleUntrustCommand(ctx, args, settings)
    }

    case 'threshold': {
      const value = parseInt(args[2])
      if (isNaN(value) || value < 50 || value > 95) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.threshold.error'))
      }
      settings.confidenceThreshold = value
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.threshold.set', { value }))
    }

    default: {
      // Show status with inline keyboard
      const message = formatStatusMessage(settings, ctx.i18n)
      const keyboard = buildKeyboard(settings, ctx.i18n)

      return ctx.replyWithHTML(message, { reply_markup: keyboard })
    }
  }
}

/**
 * Escape special regex characters to prevent ReDoS/injection
 */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Handle trust subcommand
 */
const handleTrustCommand = async (ctx, args, settings) => {
  let targetUser = null
  let targetId = null
  let targetName = null

  const replyMsg = ctx.message.reply_to_message
  if (replyMsg && replyMsg.from) {
    targetUser = replyMsg.from
    targetId = targetUser.id
    targetName = targetUser.first_name
  } else {
    const arg = args[2]
    if (!arg) {
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.usage'))
    }

    if (arg.startsWith('@')) {
      const username = escapeRegex(arg.substring(1).toLowerCase())
      try {
        const user = await ctx.db.User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })
        if (user) {
          targetId = user.telegram_id
          targetName = user.first_name || `@${arg.substring(1)}`
        } else {
          return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.user_not_found', { username: arg }))
        }
      } catch (e) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.user_not_found', { username: arg }))
      }
    } else {
      targetId = parseInt(arg)
      if (isNaN(targetId)) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.usage'))
      }
      targetName = `ID:${targetId}`
    }
  }

  if (targetUser && targetUser.is_bot) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.cant_trust_bot'))
  }

  if (settings.trustedUsers.includes(targetId)) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.already_trusted', { name: targetName }))
  }

  settings.trustedUsers.push(targetId)
  return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.added', { name: targetName }))
}

/**
 * Handle untrust subcommand
 */
const handleUntrustCommand = async (ctx, args, settings) => {
  let targetId = null
  let targetName = null

  const replyMsg = ctx.message.reply_to_message
  if (replyMsg && replyMsg.from) {
    targetId = replyMsg.from.id
    targetName = replyMsg.from.first_name
  } else {
    const arg = args[2]
    if (!arg) {
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.usage'))
    }

    if (arg.startsWith('@')) {
      const username = escapeRegex(arg.substring(1).toLowerCase())
      try {
        const user = await ctx.db.User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })
        if (user) {
          targetId = user.telegram_id
          targetName = user.first_name || `@${arg.substring(1)}`
        } else {
          return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.user_not_found', { username: arg }))
        }
      } catch (e) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.user_not_found', { username: arg }))
      }
    } else {
      targetId = parseInt(arg)
      if (isNaN(targetId)) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.usage'))
      }
      targetName = `ID:${targetId}`
    }
  }

  const index = settings.trustedUsers.indexOf(targetId)
  if (index === -1) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.not_trusted', { name: targetName }))
  }

  settings.trustedUsers.splice(index, 1)
  return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.removed', { name: targetName }))
}

/**
 * Handle callback queries for spam settings
 */
const handleSpamCallback = async (ctx) => {
  const data = ctx.callbackQuery.data
  const parts = data.split(':')
  const action = parts[1]
  const value = parts[2]

  // Check if user is admin
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
    const isAdmin = ['creator', 'administrator'].includes(member.status)
    if (!isAdmin) {
      return ctx.answerCbQuery(ctx.i18n.t('only_admin'), { show_alert: true })
    }
  } catch (e) {
    return ctx.answerCbQuery(ctx.i18n.t('cmd.spam_settings.cb.error'))
  }

  const settings = initializeSettings(ctx)

  switch (action) {
    case 'toggle':
      settings.enabled = value === 'on'
      await ctx.answerCbQuery(
        settings.enabled
          ? ctx.i18n.t('cmd.spam_settings.cb.enabled')
          : ctx.i18n.t('cmd.spam_settings.cb.disabled')
      )
      break

    case 'globalban':
      settings.globalBan = value === 'on'
      await ctx.answerCbQuery(
        settings.globalBan
          ? ctx.i18n.t('cmd.spam_settings.cb.globalban_on')
          : ctx.i18n.t('cmd.spam_settings.cb.globalban_off')
      )
      break

    case 'rules':
      if (settings.customRules && settings.customRules.length > 0) {
        let rulesText = `<b>${ctx.i18n.t('cmd.spam_settings.cb.rules_title')}</b>\n\n`
        settings.customRules.forEach((rule, index) => {
          const type = rule.startsWith('ALLOW:')
            ? ctx.i18n.t('cmd.spam_settings.status.rule_allow')
            : ctx.i18n.t('cmd.spam_settings.status.rule_deny')
          const text = rule.substring(rule.indexOf(':') + 1).trim()
          rulesText += `${index + 1}. ${type}: ${text}\n`
        })
        rulesText += `\n<code>!spam remove N</code>`
        return ctx.answerCbQuery() && ctx.replyWithHTML(rulesText)
      }
      return ctx.answerCbQuery(ctx.i18n.t('cmd.spam_settings.cb.no_rules'), { show_alert: true })

    case 'trusted':
      if (settings.trustedUsers && settings.trustedUsers.length > 0) {
        let trustedText = `<b>${ctx.i18n.t('cmd.spam_settings.cb.trusted_title')}</b>\n\n`
        settings.trustedUsers.forEach((id, index) => {
          trustedText += `${index + 1}. <code>${id}</code>\n`
        })
        trustedText += `\n<code>!spam untrust ID</code>`
        return ctx.answerCbQuery() && ctx.replyWithHTML(trustedText)
      }
      return ctx.answerCbQuery(ctx.i18n.t('cmd.spam_settings.cb.no_trusted'), { show_alert: true })

    case 'help':
      await ctx.answerCbQuery()
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.status.commands'))

    default:
      return ctx.answerCbQuery()
  }

  // Update the message with new keyboard
  const message = formatStatusMessage(settings, ctx.i18n)
  const keyboard = buildKeyboard(settings, ctx.i18n)

  try {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    })
  } catch (e) {
    // Message not modified - that's ok
  }
}

module.exports = handleSpamCommand
module.exports.handleSpamCallback = handleSpamCallback
module.exports.initializeSettings = initializeSettings
