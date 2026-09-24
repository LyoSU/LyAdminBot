import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { NOTIFY_TTL_QUIET_MS, noticeDelivery } from './quiet.js'

const LOUD = 10 * 60 * 1000
const BOT = 'LyAdminBot'

describe('noticeDelivery', () => {
  it('leaves every notice as it was while quiet mode is off', () => {
    const loud = { ttlMs: LOUD, silent: false, buttons: true }
    expect(noticeDelivery({}, { needsVote: false }, LOUD, BOT)).toEqual(loud)
    expect(noticeDelivery({ quietMode: false }, { needsVote: false }, LOUD, BOT)).toEqual(loud)
  })

  it('quiets a confident notice: short, without a sound, the link instead of a button', () => {
    expect(noticeDelivery({ quietMode: true }, { needsVote: false }, LOUD, BOT))
      .toEqual({ ttlMs: NOTIFY_TTL_QUIET_MS, silent: true, buttons: false })
  })

  it('keeps the button when there is no link to the PM card to replace it', () => {
    expect(noticeDelivery({ quietMode: true }, { needsVote: false }, LOUD, null).buttons).toBe(true)
  })

  it('never quiets an unsure verdict, even with voting off', () => {
    expect(noticeDelivery({ quietMode: true }, { needsVote: true }, LOUD, BOT))
      .toEqual({ ttlMs: LOUD, silent: false, buttons: true })
  })

  it('never keeps a notice longer than it would stay without quiet mode', () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 24 * 3600 * 1000 }), fc.option(fc.constant(BOT)),
      (quietMode, needsVote, loud, bot) => {
        const d = noticeDelivery({ quietMode }, { needsVote }, loud, bot)
        const quiet = quietMode && !needsVote
        return d.ttlMs <= loud && d.silent === quiet && d.buttons === (!quiet || bot === null)
      }
    ))
  })
})
