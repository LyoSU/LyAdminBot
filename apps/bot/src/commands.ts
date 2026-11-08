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
import { isEphemeralCommand } from './ephemeral-commands.js'

type CommandKey = keyof Locale['commands']

/** Locale-key → actual slash name (most match; top_banan is the exception). */
const SLASH_NAME: Record<CommandKey, string> = {
  start: 'start', help: 'help', lang: 'lang', mystats: 'mystats', stats: 'stats',
  report: 'report', settings: 'settings', banan: 'banan', kick: 'kick',
  del: 'del', untrust: 'untrust', check: 'check', mod: 'mod', top: 'top',
  topBanan: 'top_banan', extras: 'extras', welcome: 'welcome', ping: 'ping'
}

/**
 * Command sets per Telegram scope. List order = menu order.
 *
 * Trimmed 2026-11-08 to what each audience acts through. The handlers of the
 * commands that left the menu (`top`, `top_banan`, `ping`, `welcome`,
 * `extras`) stay: typed by hand they still work. `welcome` and `extras` are
 * edited from the `/settings` panel; the leaderboards and `ping` are for fun or
 * for us, and the menu is for neither.
 *
 * `ephemeral` marks entries the client sends as an ephemeral message — only in
 * group scopes, where there is somebody else to keep the exchange from. See
 * ephemeral-commands.ts for why the list is shared with the router.
 */
export const SCOPES: { scope: tl.TypeBotCommandScope; keys: CommandKey[]; group: boolean }[] = [
  { scope: { _: 'botCommandScopeDefault' }, keys: ['start', 'help'], group: false },
  { scope: { _: 'botCommandScopeUsers' }, keys: ['start', 'mystats', 'stats', 'lang', 'help'], group: false },
  /**
   * Regular group members. `/report` leads: it is the channel through which
   * the chat tells us about spam we missed, and nearly every false negative
   * correction this bot receives comes through it. The rest are lookups.
   */
  { scope: { _: 'botCommandScopeChats' }, keys: ['report', 'mystats', 'stats', 'help'], group: true },
  /**
   * Admins. Telegram resolves the narrowest scope, so this list REPLACES the
   * members' one for an admin rather than adding to it — `help` is repeated
   * here for that reason.
   *
   * `/mod` is the one moderation entry: reply to a message, get a panel only
   * the admin sees, act from its buttons. The reply commands it replaces
   * (`del`, `banan`, `kick`, `check`, `untrust`) still work when typed — they
   * are muscle memory for long-time admins — but the menu shows one door.
   */
  {
    scope: { _: 'botCommandScopeChatAdmins' },
    keys: ['mod', 'settings', 'help'],
    group: true
  }
]

/**
 * Our locale keys → Telegram language_code. `by` is our internal key for
 * Belarusian, whose real two-letter client code is `be`.
 */
const LANG_CODE: Record<string, string> = { uk: 'uk', en: 'en', ru: 'ru', tr: 'tr', by: 'be' }

export const buildCommands = (locale: Locale, keys: CommandKey[], group: boolean): tl.RawBotCommand[] =>
  keys.map((k) => ({
    _: 'botCommand',
    command: SLASH_NAME[k],
    description: locale.commands[k],
    ...(group && isEphemeralCommand(SLASH_NAME[k]) ? { ephemeral: true } : {})
  }))

/** Register every scope × shipped-locale combination, plus a default fallback. */
export const registerBotCommands = async (tg: TelegramClient): Promise<void> => {
  const fallback = LOCALES['en'] ?? Object.values(LOCALES)[0]
  if (!fallback) return
  for (const { scope, keys, group } of SCOPES) {
    // Empty scope is language-agnostic — one call clears the menu for every
    // locale, so skip the per-language loop entirely.
    if (keys.length === 0) {
      try {
        await tg.setMyCommands({ commands: [], scope })
      } catch (err) {
        log.warn('setMyCommands clear failed', { scope: scope._, err: err instanceof Error ? err.message : String(err) })
      }
      continue
    }
    for (const [code, locale] of Object.entries(LOCALES)) {
      try {
        await tg.setMyCommands({ commands: buildCommands(locale, keys, group), scope, langCode: LANG_CODE[code] ?? code })
      } catch (err) {
        log.warn('setMyCommands failed', { scope: scope._, code, err: err instanceof Error ? err.message : String(err) })
      }
    }
    // Language-less list: clients on a locale we do not ship still get a menu.
    try {
      await tg.setMyCommands({ commands: buildCommands(fallback, keys, group), scope })
    } catch (err) {
      log.warn('setMyCommands default failed', { scope: scope._, err: err instanceof Error ? err.message : String(err) })
    }
  }
  log.info('bot_commands_registered', { scopes: SCOPES.length, locales: Object.keys(LOCALES).length })
}
