/**
 * Cheap mention resolution. Telegram requires every bot username to end with
 * "bot", so a promo mention of a bot can be classified for free — no MTProto
 * round-trip. Other mentions stay 'unknown' (resolving them would cost a call
 * per username and rarely changes the verdict). This is what lights up the
 * core `bot_mention` signal.
 */
import type { ResolvedMention } from '@lyadmin/core'

export const resolveMentionKinds = (mentions: string[]): ResolvedMention[] => {
  const seen = new Set<string>()
  const result: ResolvedMention[] = []
  for (const raw of mentions) {
    const username = raw.replace(/^@/, '')
    if (!username) continue
    const key = username.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      username,
      kind: key.endsWith('bot') ? 'bot' : 'unknown',
      isNewish: null
    })
  }
  return result
}
