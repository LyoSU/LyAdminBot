/**
 * Bot command-menu registration (setMyCommands).
 *
 * Telegram shows a per-scope, per-language command list — the slash button and
 * the autocomplete that pops up on "/". The v2 rewrite never registered one, so
 * the menu was empty; this fills it.
 *
 * Why scoped: a non-admin in a group should not see admin-only commands, and a
 * private chat needs a different set than a group. Telegram resolves the
 * narrowest matching scope, so `chatAdmins` overrides `chats` for admins.
 *
 * Why per-language: setMyCommands stores labels per `langCode`; Telegram serves
 * the list matching the user's app language and falls back to the language-less
 * (default) list for everyone else — which is why we also register that.
 *
 * Failures are swallowed: a booted bot beats one that refused to start because
 * Telegram hiccupped on cosmetic command metadata.
 */
import type { TelegramClient, tl } from '@mtcute/node'
import { LOCALES, type Locale } from '@lyadmin/ui'
import { log } from './logger.js'

type CommandKey = keyof Locale['commands']

/** Locale-key → actual slash name (most match; top_banan is the exception). */
const SLASH_NAME: Record<CommandKey, string> = {
  start: 'start', help: 'help', lang: 'lang', mystats: 'mystats',
  report: 'report', settings: 'settings', banan: 'banan', kick: 'kick',
  del: 'del', untrust: 'untrust', check: 'check', top: 'top',
  topBanan: 'top_banan', extras: 'extras', welcome: 'welcome', ping: 'ping'
}

/** Command sets per Telegram scope. List order = menu order. */
const SCOPES: { scope: tl.TypeBotCommandScope; keys: CommandKey[] }[] = [
  { scope: { _: 'botCommandScopeDefault' }, keys: ['start', 'help'] },
  { scope: { _: 'botCommandScopeUsers' }, keys: ['start', 'help', 'lang', 'mystats'] },
  // Regular group members: only what a non-admin can actually use in a chat.
  { scope: { _: 'botCommandScopeChats' }, keys: ['report', 'help'] },
  // Admins get the full group toolset.
  {
    scope: { _: 'botCommandScopeChatAdmins' },
    keys: [
      'report', 'banan', 'kick', 'del', 'untrust', 'check',
      'top', 'topBanan', 'extras', 'welcome', 'settings', 'mystats', 'help'
    ]
  }
]

/**
 * Our locale keys → Telegram language_code. `by` is our internal key for
 * Belarusian, whose real two-letter client code is `be`.
 */
const LANG_CODE: Record<string, string> = { uk: 'uk', en: 'en', ru: 'ru', tr: 'tr', by: 'be' }

const buildCommands = (locale: Locale, keys: CommandKey[]): tl.RawBotCommand[] =>
  keys.map((k) => ({ _: 'botCommand', command: SLASH_NAME[k], description: locale.commands[k] }))

/** Register every scope × shipped-locale combination, plus a default fallback. */
export const registerBotCommands = async (tg: TelegramClient): Promise<void> => {
  const fallback = LOCALES['en'] ?? Object.values(LOCALES)[0]
  if (!fallback) return
  for (const { scope, keys } of SCOPES) {
    for (const [code, locale] of Object.entries(LOCALES)) {
      try {
        await tg.setMyCommands({ commands: buildCommands(locale, keys), scope, langCode: LANG_CODE[code] ?? code })
      } catch (err) {
        log.warn('setMyCommands failed', { scope: scope._, code, err: err instanceof Error ? err.message : String(err) })
      }
    }
    // Language-less list: clients on a locale we do not ship still get a menu.
    try {
      await tg.setMyCommands({ commands: buildCommands(fallback, keys), scope })
    } catch (err) {
      log.warn('setMyCommands default failed', { scope: scope._, err: err instanceof Error ? err.message : String(err) })
    }
  }
  log.info('bot_commands_registered', { scopes: SCOPES.length, locales: Object.keys(LOCALES).length })
}
