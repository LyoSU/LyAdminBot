import { describe, expect, it } from 'vitest'
import { MtArgumentError, MtPeerNotFoundError } from '@mtcute/node'
import { telegramErrorName } from './telegram-error.js'

describe('telegramErrorName', () => {
  it('takes the wire name out of a Telegram API error', () => {
    expect(telegramErrorName(new Error('Telegram API error 400: USER_NOT_PARTICIPANT')))
      .toBe('USER_NOT_PARTICIPANT')
    expect(telegramErrorName(new Error('Telegram API error 403: CHAT_ADMIN_REQUIRED')))
      .toBe('CHAT_ADMIN_REQUIRED')
  })

  /**
   * REGRESSION, 2026-10-14: the test above this one used to build a plain
   * Error and set `name` by hand. mtcute's classes never set `name` (it stays
   * "Error"), so the branch passed its test and named nothing in production:
   * every vote mute that failed on a cold peer cache was logged as `unknown`.
   * The real class, then.
   */
  it('keeps an mtcute error class, which is all such an error says', () => {
    const err = new MtPeerNotFoundError('Peer 8287901819 is not found in local cache')
    expect(err.name).toBe('Error')
    expect(telegramErrorName(err)).toBe('MtPeerNotFoundError')
    expect(telegramErrorName(new MtArgumentError('bad'))).toBe('MtArgumentError')
  })

  it('does not take the class name of anything that is not mtcute', () => {
    class SomethingFailedError extends Error {}
    expect(telegramErrorName(new SomethingFailedError('x'))).toBe('unknown')
    expect(telegramErrorName(new TypeError('x'))).toBe('unknown')
  })

  it('does not store what somebody wrote, however they wrote it', () => {
    // The hazard this function exists for: a stranger's text reaching an
    // exception message, and this value being persisted.
    expect(telegramErrorName(new Error('failed on «ЗАРОБІТОК ВІД 20000 ГРН»'))).toBe('unknown')
    expect(telegramErrorName(new Error('HELLO EVERYONE join my channel'))).toBe('unknown')
    expect(telegramErrorName(new Error('👋 ПРИВІТ'))).toBe('unknown')
  })

  it('a shout inside a real error does not outrank the wire name', () => {
    expect(telegramErrorName(new Error('Telegram API error 400: PEER_ID_INVALID on "BUY NOW"')))
      .toBe('PEER_ID_INVALID')
  })

  it('survives whatever it is handed', () => {
    expect(telegramErrorName(null)).toBe('unknown')
    expect(telegramErrorName(undefined)).toBe('unknown')
    expect(telegramErrorName({ weird: true })).toBe('unknown')
    expect(telegramErrorName('CHANNEL_PRIVATE')).toBe('CHANNEL_PRIVATE')
  })
})
