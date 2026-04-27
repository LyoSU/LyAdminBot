// Register bot commands with Telegram (per-scope, per-locale) and set the
// default menu button to "commands". Called once on boot.
//
// Why scoped: Telegram shows different command lists in private vs group vs
// admin contexts; a non-admin in a group does not need /settings, a private
// chat does not need /banan, etc.
//
// Why per-locale: setMyCommands stores labels per `language_code`. Telegram
// picks the list matching the user's Telegram-app language. We set all 5
// locales we ship strings for; users with unsupported languages fall back to
// the `language_code`-less (default) list automatically.
//
// Why callApi('setMyCommands', …) and callApi('setChatMenuButton', …):
// Telegraf 3.33's typed helpers don't expose the `scope` / `language_code`
// parameters added in Bot API 6.3. Going through callApi bypasses Telegraf's
// argument whitelist so we can pass modern fields without upgrading the lib.
//
// Failures are logged at warn-level and swallowed — a bot that booted is more
// valuable than a bot that refused to boot because Telegram hiccupped on
// setMyCommands (which is purely cosmetic UX metadata).

const { bot: log } = require('../helpers/logger')

const LOCALES = ['uk', 'en', 'ru', 'tr', 'by']

// Commands per scope. Names are fixed; descriptions come from the
// `bot_commands` i18n namespace, keyed by command name.
const SCOPES = {
  default: ['start', 'help', 'ping', 'lang'],
  all_private_chats: ['start', 'help', 'lang', 'ping', 'mystats'],
  all_group_chats: [
    'banan', 'kick', 'del', 'report', 'mystats',
    'top', 'top_banan', 'extras', 'help', 'lang', 'ping'
  ],
  all_chat_administrators: [
    'banan', 'kick', 'del', 'report', 'mystats',
    'top', 'top_banan', 'extras', 'settings', 'digest', 'help', 'lang', 'ping'
  ]
}

const buildCommandList = (i18n, languageCode, commandNames) => {
  return commandNames.map((name) => ({
    command: name,
    description: i18n.t(languageCode, `bot_commands.${name}`)
  }))
}

const setupCommands = async (bot) => {
  const i18n = bot.context.i18n || bot.i18n || null

  // Fallback: if the i18n instance isn't attached to the bot context, try to
  // load it from the filesystem in the same shape bot.js uses. Keeps this
  // module decoupled from bot.js wiring specifics.
  let resolvedI18n = i18n
  if (!resolvedI18n) {
    // Fall back to the same factory the bot uses on boot so this module
    // never drifts from production wiring.
    resolvedI18n = require('./i18n').createI18n()
  }

  const scopeType = {
    default: { type: 'default' },
    all_private_chats: { type: 'all_private_chats' },
    all_group_chats: { type: 'all_group_chats' },
    all_chat_administrators: { type: 'all_chat_administrators' }
  }

  for (const [scopeKey, commandNames] of Object.entries(SCOPES)) {
    for (const languageCode of LOCALES) {
      try {
        const commands = buildCommandList(resolvedI18n, languageCode, commandNames)
        await bot.telegram.callApi('setMyCommands', {
          commands,
          scope: scopeType[scopeKey],
          language_code: languageCode
        })
      } catch (err) {
        log.warn(
          { err, scope: scopeKey, languageCode },
          'setMyCommands failed'
        )
      }
    }
  }

  // Set the global menu button to open the commands list. One-time global
  // call (no chat_id) — per-chat buttons would require per-chat setup.
  try {
    await bot.telegram.callApi('setChatMenuButton', {
      menu_button: { type: 'commands' }
    })
  } catch (err) {
    log.warn({ err }, 'setChatMenuButton failed')
  }
}

module.exports = { setupCommands, SCOPES, LOCALES }
