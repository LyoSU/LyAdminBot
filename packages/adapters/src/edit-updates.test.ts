import { describe, expect, it } from 'vitest'
import type { EditBaseline } from '@lyadmin/core'
import { classifyEditDelivery, isContentEdit } from './edit-updates.js'

describe('isContentEdit', () => {
  it('refuses the reaction on a message nobody ever edited', () => {
    // The production symptom (2026-08-27): a thumbs-up on a `/top` message ran
    // `/top` again. Telegram reports the reaction as an edit of the message,
    // and the message carries no edit stamp because its text never changed.
    expect(isContentEdit({ editDate: null })).toBe(false)
  })

  it('lets a real edit through', () => {
    // Edited-in promo is the reason the pipeline reads edits at all.
    expect(isContentEdit({ editDate: new Date(1_780_000_100_000) })).toBe(true)
  })
})

/**
 * `isContentEdit` answers "was this message EVER edited"; this answers "does
 * THIS delivery carry a version the pipeline has not judged yet". The gap
 * between the two questions is what convicted somebody (production
 * 2026-08-28): a reaction on a message that carried an edit stamp re-entered
 * the pipeline two hours after the same text had been judged clean, picked up
 * the `edited_message` signal plus two hours of corpus drift, and flipped the
 * verdict to delete.
 */
describe('classifyEditDelivery', () => {
  const judged = (over: Partial<EditBaseline> = {}): EditBaseline => ({
    urls: 1, mentions: 0, invisibles: 0, urlKeys: ['5db1f486f81c'],
    editDate: 1_780_000_100_000, contentKey: 'aabbccddeeff', ...over
  })

  it('runs when nobody remembers an earlier version', () => {
    expect(classifyEditDelivery(null, judged())).toBe('run')
  })

  it('runs against a record from an older build, which has no stamp to compare', () => {
    const legacy: EditBaseline = { urls: 1, mentions: 0, invisibles: 0 }
    expect(classifyEditDelivery(legacy, judged())).toBe('run')
  })

  it('drops a delivery whose stamp is not newer than the judged version', () => {
    // A reaction repeats the stamp of the version it sits on, verbatim.
    expect(classifyEditDelivery(judged(), judged())).toBe('stale_echo')
    expect(classifyEditDelivery(judged(), judged({ editDate: 1_780_000_099_000 }))).toBe('stale_echo')
  })

  it('drops a stampless delivery of a message already judged un-edited', () => {
    // The gateway refuses these already; kept here so the app-level guard
    // stands on its own if that ever changes.
    expect(classifyEditDelivery(judged({ editDate: 0 }), judged({ editDate: 0 }))).toBe('stale_echo')
  })

  it('skips a newer stamp whose content is what was already judged', () => {
    // The 2026-08-28 shape: the stamp moved, the message did not. Whatever
    // stamped it, there is nothing new to judge — re-scoring the same text
    // against a corpus that grew in the meantime is how a verdict flips
    // without the sender doing anything.
    expect(classifyEditDelivery(judged(), judged({ editDate: 1_780_000_200_000 })))
      .toBe('noop_edit')
  })

  it('runs a real edit: newer stamp, different content', () => {
    expect(classifyEditDelivery(
      judged(),
      judged({ editDate: 1_780_000_200_000, contentKey: '112233445566' })
    )).toBe('run')
  })

  it('runs a first edit of a message judged only on arrival', () => {
    // Arrival baseline carries stamp 0; any real edit is newer.
    expect(classifyEditDelivery(
      judged({ editDate: 0 }),
      judged({ editDate: 1_780_000_200_000, contentKey: '112233445566' })
    )).toBe('run')
  })

  it('treats a record without a content key as unjudgeable content, and runs', () => {
    const { contentKey: _dropped, ...keyless } = judged()
    expect(classifyEditDelivery(
      keyless,
      judged({ editDate: 1_780_000_200_000 })
    )).toBe('run')
  })
})
