import { describe, expect, it, vi } from 'vitest'
import { sendWithReplyFallback, shouldRetryWithoutReply } from './reply-fallback.js'

const wire = (name: string): Error => new Error(`Telegram API error 400: ${name}`)

describe('shouldRetryWithoutReply', () => {
  it('retries when the reply target is gone', () => {
    expect(shouldRetryWithoutReply(wire('REPLY_MESSAGE_ID_INVALID'), 42)).toBe(true)
    expect(shouldRetryWithoutReply(wire('REPLY_TO_INVALID'), 42)).toBe(true)
  })

  it('does not retry a send that had no reply', () => {
    expect(shouldRetryWithoutReply(wire('REPLY_MESSAGE_ID_INVALID'), undefined)).toBe(false)
  })

  it('does not retry refusals a second send would meet again', () => {
    for (const name of ['USER_NOT_PARTICIPANT', 'CHAT_WRITE_FORBIDDEN', 'FLOOD_WAIT_30', 'MESSAGE_ID_INVALID']) {
      expect(shouldRetryWithoutReply(wire(name), 42), name).toBe(false)
    }
    expect(shouldRetryWithoutReply(new Error('socket hang up'), 42)).toBe(false)
    expect(shouldRetryWithoutReply('REPLY_MESSAGE_ID_INVALID is a string', 42)).toBe(true)
  })
})

describe('sendWithReplyFallback', () => {
  it('sends once when the first send works', async () => {
    const send = vi.fn(async (r: number | undefined) => r ?? -1)
    expect(await sendWithReplyFallback(send, 7)).toBe(7)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drops the reply once, and only once, when its target is gone', async () => {
    const send = vi.fn(async (r: number | undefined) => {
      if (r !== undefined) throw wire('REPLY_MESSAGE_ID_INVALID')
      return 99
    })
    const onRetry = vi.fn()
    expect(await sendWithReplyFallback(send, 7, onRetry)).toBe(99)
    expect(send.mock.calls).toEqual([[7], [undefined]])
    expect(onRetry).toHaveBeenCalledWith('REPLY_MESSAGE_ID_INVALID')
  })

  it('surfaces the second failure, and any other failure untouched', async () => {
    const always = vi.fn(async () => { throw wire('REPLY_MESSAGE_ID_INVALID') })
    await expect(sendWithReplyFallback(always, 7)).rejects.toThrow('REPLY_MESSAGE_ID_INVALID')
    expect(always).toHaveBeenCalledTimes(2)
    const other = vi.fn(async () => { throw wire('USER_NOT_PARTICIPANT') })
    await expect(sendWithReplyFallback(other, 7)).rejects.toThrow('USER_NOT_PARTICIPANT')
    expect(other).toHaveBeenCalledTimes(1)
  })
})
