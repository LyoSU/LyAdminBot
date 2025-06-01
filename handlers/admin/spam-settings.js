module.exports = async (ctx) => {
  const args = ctx.message.text.split(' ')
  const command = args[1] && args[1].toLowerCase()

  // Initialize spam settings if they don't exist
  if (!ctx.group.info.settings.openaiSpamCheck) {
    ctx.group.info.settings.openaiSpamCheck = {
      enabled: true,
      globalBan: true,
      customRules: []
    }
  }

  const settings = ctx.group.info.settings.openaiSpamCheck

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

    case 'clear':
      const rulesCount = settings.customRules.length
      settings.customRules = []
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.clear', { count: rulesCount }))

    default: {
      // Show current settings
      const status = settings.enabled
        ? ctx.i18n.t('cmd.spam_settings.status.enabled_text')
        : ctx.i18n.t('cmd.spam_settings.status.disabled_text')

      let message = `${ctx.i18n.t('cmd.spam_settings.status.title')}\n\n`
      message += `<b>Статус:</b> ${status}\n\n`

      if (settings.customRules.length > 0) {
        message += `<b>${ctx.i18n.t('cmd.spam_settings.status.rules_title', { count: settings.customRules.length })}</b>\n`
        settings.customRules.forEach((rule, index) => {
          const type = rule.startsWith('ALLOW:')
            ? ctx.i18n.t('cmd.spam_settings.status.rule_allow')
            : ctx.i18n.t('cmd.spam_settings.status.rule_deny')
          const text = rule.substring(rule.indexOf(':') + 1).trim()
          message += `${index + 1}. ${type}: ${text}\n`
        })
      } else {
        message += `<b>Правила:</b> ${ctx.i18n.t('cmd.spam_settings.status.rules_empty')}\n`
      }

      // Add global ban status
      const globalBanStatus = settings.globalBan !== false
        ? ctx.i18n.t('cmd.spam_settings.status.globalban_enabled')
        : ctx.i18n.t('cmd.spam_settings.status.globalban_disabled')
      message += `<b>Глобальний бан:</b> ${globalBanStatus}\n`

      message += `\n<b>${ctx.i18n.t('cmd.spam_settings.status.commands_title')}</b>\n`
      message += ctx.i18n.t('cmd.spam_settings.status.commands')

      return ctx.replyWithHTML(message)
    }
  }
}
