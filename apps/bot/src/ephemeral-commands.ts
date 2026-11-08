/**
 * Which group commands answer ephemerally — seen only by the member who asked.
 *
 * Telegram (Bot API 10.2, 2026-07) lets a command menu entry carry
 * `is_ephemeral`: the client then sends `/command` as an ephemeral message,
 * which reaches the bot as its own update type and is never part of the chat.
 * The answer goes back the same way. So a lookup — the help, a stats card, a
 * profile check — leaves nothing for the chat to scroll past and nothing for
 * the bot to clean up on a timer.
 *
 * One list for both ends on purpose. The menu flag decides how the CLIENT
 * sends the command; the router decides whether the BOT can answer that
 * update. A command flagged in the menu and missing from the router is a
 * command that silently stopped working, and the test pins the two together.
 *
 * What stays out: anything that changes the chat (`banan`, `kick`, `del`,
 * `untrust`) — the members should see the moderation happen — and `/report`,
 * which is a public act by decision of 2026-11-08.
 */
export const EPHEMERAL_COMMANDS: ReadonlySet<string> = new Set([
  'help', 'stats', 'mystats', 'check', 'settings', 'lang', 'start'
])

export const isEphemeralCommand = (name: string): boolean => EPHEMERAL_COMMANDS.has(name)
