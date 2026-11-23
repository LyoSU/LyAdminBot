/**
 * ModerationActions over MTProto.
 *
 * Extracted from gateway.ts, which states its own rule — thin, no business
 * logic — and then had to carry the one piece of knowledge that is neither
 * transport nor policy: which encoding of a sentence Telegram actually honours
 * for which kind of sender. That belongs somewhere it can be tested without a
 * live client, next to the other pieces the gateway delegates to.
 */
import { isChannelSenderId } from '@lyadmin/core'
import type { TelegramClient } from '@mtcute/node'
import type { ModerationActions } from './executor.js'
import { readMemberRestriction, type MemberRestriction, type MemberRestrictionAnswer } from './member-restriction.js'

/** The slice of the client these four actions need. */
export type ModerationTransport = Pick<
  TelegramClient,
  'deleteMessagesById' | 'restrictChatMember' | 'banChatMember' | 'unbanChatMember' | 'getChatMember'
>

/**
 * Everything a person may be stopped from doing in a chat. Spelled out rather
 * than derived: a right Telegram adds later must be an explicit decision here,
 * not something a spread quietly starts or stops covering.
 */
const SILENCE_ALL = {
  sendMessages: true, sendMedia: true, sendStickers: true, sendGifs: true,
  sendGames: true, sendInline: true, embedLinks: true, sendPolls: true,
  sendPhotos: true, sendVideos: true, sendRoundvideos: true, sendAudios: true,
  sendVoices: true, sendDocs: true, sendPlain: true
} as const

/**
 * A sender that is a channel rather than a person — re-exported from core so
 * the executor and `mayAskCaptcha` cannot drift apart on what one is.
 */
export const isChannelSender = isChannelSenderId

/**
 * How long the ban half of a kick lasts if nothing lifts it. Telegram reads an
 * expiry under 30 seconds away as "forever", so the net sits above that.
 */
export const KICK_BAN_SECONDS = 60

/**
 * Whether a sentence at least as heavy as the mute about to be written already
 * stands on the member — in which case the mute must not be written at all.
 *
 * `channels.editBanned` does not add a restriction, it REPLACES the member's
 * banned rights wholesale. A timed mute sent for an account that is banned
 * turns the ban into that mute; a short mute sent over a longer one shortens
 * it. Every caller of `mute` acts some time after the fact that made it decide
 * — a ballot closes hours after it opened, a look runs half an hour after the
 * join, a captcha window lapses after two minutes — and until 2026-11-23 none
 * of them asked what had happened to the member in between. 14 days to that
 * date: 24 ballots opened before the bot banned the same account in the same
 * chat closed as "spam" after it, and each wrote its six-hour mute over the
 * ban; 2026-11-22, four arrival looks did the same to a ban carried from
 * another chat minutes earlier.
 *
 *   - a person who is banned stays banned, whatever the two deadlines are: a
 *     ban is never traded for a mute;
 *   - a channel is "muted" by a timed ban (see `mute`), so for it the standing
 *     ban wins only when it lasts at least as long;
 *   - a full mute that lasts at least as long stands — an admin's indefinite
 *     mute is not cut down to our hour.
 *
 * Not covered: a PARTIAL restriction an admin set (media only, say) is still
 * replaced by the full mute and gone when that lapses. Putting it back needs a
 * write after our expiry, which nothing here schedules.
 */
export const heavierSentenceStands = (
  current: MemberRestriction, muteUntilMs: number, channel: boolean
): boolean => {
  const outlasts = current.untilMs === null || current.untilMs >= muteUntilMs
  if (current.status === 'banned') return channel ? outlasts : true
  if (current.status === 'restricted') return current.allSendBlocked && outlasts
  return false
}

export const moderationActionsOver = (tg: ModerationTransport): ModerationActions => ({
  deleteMessage: async (chatId, messageId) => {
    await tg.deleteMessagesById(chatId, [messageId])
  },

  /**
   * Silence a sender until the deadline — in the encoding that sender's kind
   * understands.
   *
   * `channels.editBanned` is the single RPC behind both this and `ban` below;
   * the rights it carries are the whole difference. A person is silenced by the
   * partial set above. A CHANNEL is not, because a sender chat has exactly two
   * states in a group — posting, or banned — and there is no third one to put
   * it in. Telegram accepts the partial set for a channel participant, answers
   * with updates, and applies none of it.
   *
   * So until 2026-08-27 a muted channel was recorded as muted and went on
   * posting. Of 35 restrictions the executor recorded as applied, 25 were
   * followed by the same channel posting into the same chat inside the 24-hour
   * window it was supposedly serving — the quickest after 16 minutes. Nothing
   * failed and nothing was logged, because the call itself succeeded.
   *
   * The ban with the same expiry is that sentence in the only encoding that
   * lands, and it is narrower than it reads: it takes away a posting identity,
   * not a person. Whoever owns the channel keeps writing under their own
   * account — which a mute, had it worked, would have stopped.
   */
  mute: async (chatId, userId, untilSeconds, opts) => {
    const until = new Date(Date.now() + untilSeconds * 1000)
    const channel = isChannelSender(userId)
    // A read that fails stops nothing: the mute is what the caller decided, and
    // a lookup timeout must not spare an account that is still posting.
    const current = opts?.replace === true ? null : await tg.getChatMember({ chatId, userId })
      .then((member) => readMemberRestriction(member as MemberRestrictionAnswer))
      .catch(() => null)
    if (current !== null && heavierSentenceStands(current, until.getTime(), channel)) return 'stands'
    if (channel) {
      await tg.banChatMember({ chatId, participantId: userId, untilDate: until })
      return
    }
    await tg.restrictChatMember({ chatId, userId, restrictions: { ...SILENCE_ALL }, until })
  },

  // Kick = ban then immediately unban: Telegram has no "remove without
  // blocking", and leaving the ban in place would make it a silent permaban.
  // The ban carries its own short expiry as a safety net: when the unban
  // fails, the kick heals itself within a minute instead of standing forever
  // behind a record that says it did not apply (2026-09-23 review).
  kick: async (chatId, userId) => {
    const until = new Date(Date.now() + KICK_BAN_SECONDS * 1000)
    await tg.banChatMember({ chatId, participantId: userId, untilDate: until })
    await tg.unbanChatMember({ chatId, participantId: userId })
  },

  ban: async (chatId, userId, untilSeconds) => {
    await tg.banChatMember({
      chatId,
      participantId: userId,
      ...(untilSeconds === null ? {} : { untilDate: new Date(Date.now() + untilSeconds * 1000) })
    })
  }
})
