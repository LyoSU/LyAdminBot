// "Дай мені права" card (§8 of the UX design).
//
// Called from any mod-action site that hit a "not enough rights" error:
// instead of the flat `banan.error_no_rights` one-liner we render a
// multi-line card with a `[📖 Як дати права]` button. Clicking expands
// the same message in place to a 4-step instruction.
//
// Callback shape:
//   m:v1:mod.rights:show:<action>   → expand to step list
//   m:v1:mod.rights:ack             → collapse back / dismiss via _close
//
// Access: public. The rights card is informational and must render for
// everyone — including the admin who doesn't yet have rights. The `show`
// action is a pure re-render; there's no destructive path to guard.

const { registerMenu } = require('../registry')
const { cb, btn, row, CLOSE } = require('../keyboard')
const { replyHTML, editHTML } = require('../../reply-html')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')
const botPermissions = require('../../bot-permissions')

const SCREEN_ID = 'mod.rights'

// Which flag matters for which action. The card enumerates only the
// flags that are actually missing.
const ACTION_PERMS = {
  banan: ['can_restrict_members'],
  kick: ['can_restrict_members'],
  del: ['can_delete_messages'],
  generic: ['can_restrict_members', 'can_delete_messages']
}

const PERM_LABEL_KEY = {
  can_restrict_members: 'menu.mod.rights.perms.restrict',
  can_delete_messages: 'menu.mod.rights.perms.delete'
}

/**
 * Resolve which permissions are missing for the bot in the current chat.
 * Returns array of field names; empty array if all good / unknown.
 */
const missingPerms = async (ctx, action) => {
  const need = ACTION_PERMS[action] || ACTION_PERMS.generic
  const botId = (ctx.botInfo && ctx.botInfo.id) || (ctx.tg && ctx.tg.options && ctx.tg.options.id)
  const record = botId ? await botPermissions.resolve(ctx.telegram, ctx.chat.id, botId).catch(() => null) : null
  if (!record) {
    // Unknown — assume all `need` are missing so we surface the card.
    return need.slice()
  }
  const missing = []
  for (const flag of need) {
    if (flag === 'can_restrict_members' && !record.canRestrict) missing.push(flag)
    if (flag === 'can_delete_messages' && !record.canDelete) missing.push(flag)
  }
  return missing
}

/**
 * Build the "card" text listing missing permissions.
 * action: 'banan' | 'kick' | 'del' | 'generic'
 * targetUser: optional, used for the title line.
 */
const buildCardText = (ctx, { action, targetUser, missing }) => {
  const titleKey = `menu.mod.rights.card.title_${action}`
  const fallback = 'menu.mod.rights.card.title_generic'
  const name = targetUser
    ? (targetUser.first_name || targetUser.username || targetUser.title || 'user')
    : ''
  // i18n fallback: if a specific title_<action> key isn't defined in the
  // locale, telegraf-i18n returns the key literal; fall back to generic.
  let title = ctx.i18n.t(titleKey, { name })
  if (title === titleKey) title = ctx.i18n.t(fallback, { name })

  const permsHeader = ctx.i18n.t('menu.mod.rights.card.missing_header')
  const permsLines = missing
    .map(flag => ctx.i18n.t('menu.mod.rights.card.bullet', {
      perm: ctx.i18n.t(PERM_LABEL_KEY[flag] || 'menu.mod.rights.perms.restrict')
    }))

  if (permsLines.length === 0) {
    return title
  }
  return `${title}\n\n${permsHeader}\n${permsLines.join('\n')}`
}

const buildCardKeyboard = (ctx, action) => ({
  inline_keyboard: [
    row(btn(ctx.i18n.t('menu.mod.rights.btn.how'), cb(SCREEN_ID, 'show', action))),
    row(btn(ctx.i18n.t('menu.mod.rights.btn.dismiss'), CLOSE))
  ]
})

const buildStepsText = (ctx) => {
  const header = ctx.i18n.t('menu.mod.rights.steps.header')
  const steps = [1, 2, 3, 4].map(n => ctx.i18n.t(`menu.mod.rights.steps.step_${n}`))
  return `${header}\n\n${steps.join('\n')}`
}

const buildStepsKeyboard = (ctx) => ({
  inline_keyboard: [
    row(btn(ctx.i18n.t('menu.mod.rights.btn.ack'), CLOSE))
  ]
})

/**
 * Entry point invoked from handlers/banan.js, handlers/kick.js, handlers/delete.js
 * when the Telegram API returns a permissions error.
 *
 * @returns {Promise<{message}|null>}
 */
const sendRightsCard = async (ctx, { action = 'generic', targetUser } = {}) => {
  const missing = await missingPerms(ctx, action)
  const text = buildCardText(ctx, { action, targetUser, missing })
  const keyboard = buildCardKeyboard(ctx, action)
  let sent
  try {
    sent = await replyHTML(ctx, text, {
      reply_markup: keyboard,
      reply_to_message_id: ctx.message && ctx.message.message_id
    })
  } catch (_err) {
    return null
  }
  if (sent && sent.message_id && ctx.db) {
    // Schedule auto-delete — the expanded view re-arms with its own TTL.
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.mod_event_expanded,
      source: 'mod_rights_card'
    }, ctx.telegram).catch(() => {})
  }
  return sent
}

const handle = async (ctx, action, args) => {
  if (action === 'show') {
    const whichAction = (args && args[0]) || 'generic'
    const text = buildStepsText(ctx)
    const keyboard = buildStepsKeyboard(ctx)
    try {
      await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
        reply_markup: keyboard
      })
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        // Swallow — cosmetic.
      }
    }
    if (ctx.db && ctx.chat) {
      scheduleDeletion(ctx.db, {
        chatId: ctx.chat.id,
        messageId: ctx.callbackQuery.message.message_id,
        delayMs: policy.mod_event_expanded,
        source: `mod_rights_steps:${whichAction}`
      }, ctx.telegram).catch(() => {})
    }
    return { render: false, silent: true }
  }

  if (action === 'ack') {
    try { await ctx.deleteMessage() } catch { /* ignore */ }
    return { render: false, silent: true }
  }

  return { render: false, silent: true }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'public',
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  ACTION_PERMS,
  PERM_LABEL_KEY,
  missingPerms,
  buildCardText,
  buildCardKeyboard,
  buildStepsText,
  buildStepsKeyboard,
  sendRightsCard,
  handle
}
