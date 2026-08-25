import { describe, expect, it } from 'vitest'
import { PendingInput } from './pending-input.js'

describe('PendingInput', () => {
  it('takes a set entry exactly once', () => {
    const p = new PendingInput()
    p.set(1, { type: 'welcome.text', chatId: -100 })
    expect(p.take(1)).toEqual({ type: 'welcome.text', chatId: -100 })
    expect(p.take(1)).toBeNull()
  })

  it('preserves an optional arg', () => {
    const p = new PendingInput()
    p.set(1, { type: 'extra', chatId: -100, arg: 'rules' })
    expect(p.take(1)).toEqual({ type: 'extra', chatId: -100, arg: 'rules' })
  })

  it('expires entries past the TTL', () => {
    const p = new PendingInput(1000)
    p.set(1, { type: 'welcome.gif', chatId: -100 }, 0)
    expect(p.has(1, 500)).toBe(true)
    expect(p.take(1, 2000)).toBeNull()
  })

  it('has() evicts an expired entry', () => {
    const p = new PendingInput(1000)
    p.set(1, { type: 'welcome.gif', chatId: -100 }, 0)
    expect(p.has(1, 2000)).toBe(false)
    expect(p.take(1, 2001)).toBeNull()
  })

  it('cancel() clears a pending entry', () => {
    const p = new PendingInput()
    p.set(1, { type: 'welcome.text', chatId: -100 })
    p.cancel(1)
    expect(p.has(1)).toBe(false)
  })

  it('isolates entries per user', () => {
    const p = new PendingInput()
    p.set(1, { type: 'welcome.text', chatId: -100 })
    p.set(2, { type: 'extra', chatId: -200, arg: 'faq' })
    expect(p.take(1)).toEqual({ type: 'welcome.text', chatId: -100 })
    expect(p.take(2)).toEqual({ type: 'extra', chatId: -200, arg: 'faq' })
  })

  it('peeks without consuming, so a validation failure can ask again', () => {
    const p = new PendingInput()
    p.set(1, { type: 'welcome.gif', chatId: -100 })
    expect(p.peek(1)).toEqual({ type: 'welcome.gif', chatId: -100 })
    // Still there: the whole point. "That's not media, send a gif" used to
    // destroy the flow it was asking the admin to correct.
    expect(p.peek(1)).toEqual({ type: 'welcome.gif', chatId: -100 })
    expect(p.take(1)).toEqual({ type: 'welcome.gif', chatId: -100 })
    expect(p.peek(1)).toBeNull()
  })

  it('distinguishes a lapsed flow from no flow at all', () => {
    const p = new PendingInput(1000)
    p.set(1, { type: 'extra.name', chatId: -100 }, 0)
    expect(p.peek(1, 1001)).toBe('expired')
    // Evicted by that read, so the next one is an honest "nothing here".
    expect(p.peek(1, 1002)).toBeNull()
  })
})
