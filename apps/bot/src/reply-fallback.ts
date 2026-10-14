import { telegramErrorName } from './telegram-error.js'

/**
 * Telegram's ways of saying "the message you are replying to is not there".
 *
 * Matched on the wire name, as `telegramErrorName` reads it. The class is "the
 * reply target is gone", not one prompt: any send that replies to a message
 * somebody else may have removed in the meantime meets it.
 */
const REPLY_TARGET_GONE = new Set(['REPLY_MESSAGE_ID_INVALID', 'REPLY_TO_INVALID'])

/**
 * Whether a failed send is worth one more try without its reply.
 *
 * Only when there WAS a reply and the refusal names it. Every other error —
 * the person left, the bot lost its rights, a flood wait — would fail the same
 * way a second time, and a retry would only double the cost of the failure.
 */
export const shouldRetryWithoutReply = (err: unknown, replyTo: number | undefined): boolean =>
  replyTo !== undefined && REPLY_TARGET_GONE.has(telegramErrorName(err))

/**
 * Send with a reply, and if the reply target has gone, once more without it.
 *
 * Added 2026-10-14 for the captcha whisper: on the arrival path the prompt
 * replies to Telegram's "X joined" line, which the arrival purge may already
 * have deleted, and Telegram then refuses the whole send. 32 of 45 captchas
 * filed `undeliverable` over 14 days failed with `REPLY_MESSAGE_ID_INVALID` —
 * a question nobody was asked because the line it pointed at was tidied away.
 * The reply is a courtesy; the question is the point. mtcute's ephemeral send
 * has no allow-without-reply flag, so the fallback is a second send.
 *
 * `onRetry` is told the reason so the caller can log it: a fallback that never
 * shows up anywhere cannot be counted.
 */
export const sendWithReplyFallback = async <T>(
  send: (replyTo: number | undefined) => Promise<T>,
  replyTo: number | undefined,
  onRetry?: (reason: string) => void
): Promise<T> => {
  try {
    return await send(replyTo)
  } catch (err) {
    if (!shouldRetryWithoutReply(err, replyTo)) throw err
    onRetry?.(telegramErrorName(err))
    return await send(undefined)
  }
}
