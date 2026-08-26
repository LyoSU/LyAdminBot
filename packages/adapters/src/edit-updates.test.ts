import { describe, expect, it } from 'vitest'
import { isContentEdit } from './edit-updates.js'

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
