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

/** The slice of the client these four actions need. */
export type ModerationTransport = Pick<
  TelegramClient,
  'deleteMessagesById' | 'restrictChatMember' | 'banChatMember' | 'unbanChatMember'
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
  mute: async (chatId, userId, untilSeconds) => {
    const until = new Date(Date.now() + untilSeconds * 1000)
    if (isChannelSender(userId)) {
      await tg.banChatMember({ chatId, participantId: userId, untilDate: until })
      return
    }
    await tg.restrictChatMember({ chatId, userId, restrictions: { ...SILENCE_ALL }, until })
  },

  // Kick = ban then immediately unban: Telegram has no "remove without
  // blocking", and leaving the ban in place would make it a silent permaban.
  // Matches what the manual /kick command already does.
  kick: async (chatId, userId) => {
    await tg.banChatMember({ chatId, participantId: userId })
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
