// Onboarding wizard — 3-button card sent when the bot is added to a group
// with admin rights. Replaces the former `bot_added.as_admin` one-liner.
//
// Access: 'group_admin' — any admin in the chat can press either button, not
// just the user who added the bot (we don't know who that was anyway since
// my_chat_member.from is the promoter, which may or may not match later).
//
// Buttons:
//  [✓ Так підходить] → react 👌 on the card + schedule deletion
//                      (cleanup_policy.onboarding_ack)
//  [🔧 Налаштувати] → renderScreen(ctx, 'settings.root') if registered;
//                      otherwise toast a "coming soon" placeholder.

const { registerMenu, getMenu } = require('../registry')
const { cb, btn, row } = require('../keyboard')
const { setReaction } = require('../../reactions')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')

const SCREEN_ID = 'onboarding.root'

// Pretty-print a locale code to its human name. Kept here so we don't
// duplicate the map in multiple screens — if /lang picker grows, it should
// import from here.
const LANGUAGE_NAMES = {
  uk: 'Українська',
  en: 'English',
  ru: 'Русский',
  tr: 'Türkçe',
  by: 'Беларуская'
}

const languageName = (code) => LANGUAGE_NAMES[code] || code || 'English'

// Map the numeric confidence threshold to a 3-bucket label (for the card
// summary only — the actual slider lives in /settings).
const sensitivityLabel = (ctx, threshold) => {
  if (threshold >= 80) return ctx.i18n.t('menu.onboarding.sensitivity.high')
  if (threshold >= 65) return ctx.i18n.t('menu.onboarding.sensitivity.mid')
  return ctx.i18n.t('menu.onboarding.sensitivity.low')
}

const welcomeState = (ctx, enabled) => {
  return enabled
    ? ctx.i18n.t('menu.onboarding.welcome.on')
    : ctx.i18n.t('menu.onboarding.welcome.off')
}

// Pull current group defaults out of ctx.group.info.settings, falling back
// to sensible literals if settings haven't been saved yet (bot-added.js
// often runs before the contextLoader for that chat created the Group doc).
const readSettings = (ctx) => {
  const g = ctx.group && ctx.group.info && ctx.group.info.settings
  const locale = (g && g.locale) || (ctx.i18n && ctx.i18n.locale()) || 'en'
  const threshold = (g && g.openaiSpamCheck && g.openaiSpamCheck.confidenceThreshold) || 70
  const welcomeEnabled = Boolean(g && g.welcome && g.welcome.enable)
  return { locale, threshold, welcomeEnabled }
}

const renderView = (ctx) => {
  const { locale, threshold, welcomeEnabled } = readSettings(ctx)
  const text = ctx.i18n.t('menu.onboarding.card', {
    language: languageName(locale),
    threshold,
    sensitivityLabel: sensitivityLabel(ctx, threshold),
    welcomeState: welcomeState(ctx, welcomeEnabled)
  })
  const keyboard = {
    inline_keyboard: [
      row(
        btn(ctx.i18n.t('menu.onboarding.btn.ack'), cb(SCREEN_ID, 'ack')),
        btn(ctx.i18n.t('menu.onboarding.btn.config'), cb(SCREEN_ID, 'config'))
      )
    ]
  }
  return { text, keyboard }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'group_admin',
    render: (ctx) => renderView(ctx),
    handle: async (ctx, action) => {
      if (action === 'ack') {
        // React 👌 on the onboarding card itself, then schedule deletion.
        // The react call is cosmetic — failures are swallowed inside
        // setReaction. scheduleDeletion may no-op silently in edge cases
        // (no db, no chat); not worth the try/catch noise.
        const msg = ctx.callbackQuery && ctx.callbackQuery.message
        if (msg) {
          await setReaction(ctx, ctx.chat.id, msg.message_id, '👌')
          if (ctx.db) {
            scheduleDeletion(ctx.db, {
              chatId: ctx.chat.id,
              messageId: msg.message_id,
              delayMs: policy.onboarding_ack,
              source: 'onboarding_ack'
            }, ctx.telegram).catch(() => {})
          }
        }
        return { render: false, toast: 'menu.onboarding.ack' }
      }

      if (action === 'config') {
        // Forward to /settings root if Plan 4 has registered it already;
        // otherwise toast a placeholder so the button is never dead.
        const settingsScreen = getMenu('settings.root')
        if (settingsScreen) {
          // Lazy require to avoid a circular dep between router and screens.
          const { renderScreen } = require('../router')
          await renderScreen(ctx, settingsScreen, {})
          return { render: false }
        }
        return { render: false, toast: 'menu.onboarding.config_soon' }
      }

      return { render: false }
    }
  })
}

module.exports = {
  register,
  SCREEN_ID,
  LANGUAGE_NAMES,
  languageName,
  sensitivityLabel,
  welcomeState,
  renderView
}
