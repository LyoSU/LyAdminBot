module.exports = async (ctx) => {
  const args = ctx.message.text.split(' ')
  const command = args[1] && args[1].toLowerCase()

  // Initialize spam settings if they don't exist
  if (!ctx.group.info.settings.openaiSpamCheck) {
    ctx.group.info.settings.openaiSpamCheck = {
      enabled: true,
      globalBan: true,
      customRules: [],
      trustedUsers: []
    }
  }

  const settings = ctx.group.info.settings.openaiSpamCheck

  // Ensure trustedUsers array exists
  if (!settings.trustedUsers) {
    settings.trustedUsers = []
  }

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

    case 'trust': {
      let targetUser = null
      let targetId = null
      let targetName = null

      // Try to get user from reply
      const replyMsg = ctx.message.reply_to_message
      if (replyMsg && replyMsg.from) {
        targetUser = replyMsg.from
        targetId = targetUser.id
        targetName = targetUser.first_name
      } else {
        // Try to parse from args: !spam trust @username or !spam trust 123456
        const arg = args[2]
        if (!arg) {
          return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.usage'))
        }

        if (arg.startsWith('@')) {
          // Username - try to find in DB
          const username = arg.substring(1).toLowerCase()
          try {
            const user = await ctx.db.User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })
            if (user) {
              targetId = user.telegram_id
              targetName = user.first_name || `@${username}`
            } else {
              return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.user_not_found', { username: arg }))
            }
          } catch (e) {
            return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.user_not_found', { username: arg }))
          }
        } else {
          // Try as numeric ID
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

      // Check if already trusted
      if (settings.trustedUsers.includes(targetId)) {
        return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.already_trusted', { name: targetName }))
      }

      // Add to trusted list
      settings.trustedUsers.push(targetId)
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.trust.added', { name: targetName }))
    }

    case 'untrust': {
      let targetId = null
      let targetName = null

      // Try to get user from reply
      const replyMsg = ctx.message.reply_to_message
      if (replyMsg && replyMsg.from) {
        targetId = replyMsg.from.id
        targetName = replyMsg.from.first_name
      } else {
        // Try to parse from args
        const arg = args[2]
        if (!arg) {
          return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.usage'))
        }

        if (arg.startsWith('@')) {
          const username = arg.substring(1).toLowerCase()
          try {
            const user = await ctx.db.User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })
            if (user) {
              targetId = user.telegram_id
              targetName = user.first_name || `@${username}`
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

      // Remove from trusted list
      settings.trustedUsers.splice(index, 1)
      return ctx.replyWithHTML(ctx.i18n.t('cmd.spam_settings.untrust.removed', { name: targetName }))
    }

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

      // Add trusted users count
      if (settings.trustedUsers && settings.trustedUsers.length > 0) {
        message += `<b>Довірені:</b> ${settings.trustedUsers.length} ${ctx.i18n.t('cmd.spam_settings.status.trusted_users')}\n`
      }

      message += `\n<b>${ctx.i18n.t('cmd.spam_settings.status.commands_title')}</b>\n`
      message += ctx.i18n.t('cmd.spam_settings.status.commands')

      return ctx.replyWithHTML(message)
    }
  }
}
