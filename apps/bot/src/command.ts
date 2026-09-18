/**
 * A slash command, if the message is one addressed to this bot.
 *
 * Every dispatcher used to match `/^\/name(@\w+)?$/`, and `(@\w+)?` accepts any
 * bot's name — so in a group with two bots, `/mystats@OtherBot` ran ours too.
 * The private-chat dispatcher matched a bare prefix, so `/helpme` was `/help`.
 *
 * `@name` must be ours, compared without case as Telegram does. Until getMe has
 * told us who we are, an addressed command is not ours: answering a command
 * meant for another bot is the failure, and the window is the first seconds of
 * a process. `-` stays inside the name because `/top-banan` predates this.
 */
export interface Command {
  /** Lower-cased, without the slash or the `@bot` suffix. */
  name: string
  /** Everything after the first whitespace, trimmed; '' when there is none. */
  args: string
}

const COMMAND_RE = /^\/([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/

export const parseCommand = (text: string, selfUsername: string | null | undefined): Command | null => {
  const m = COMMAND_RE.exec(text.trim())
  if (!m) return null
  const [, name = '', addressee, args = ''] = m
  if (addressee !== undefined) {
    if (!selfUsername || addressee.toLowerCase() !== selfUsername.toLowerCase()) return null
  }
  return { name: name.toLowerCase(), args: args.trim() }
}
