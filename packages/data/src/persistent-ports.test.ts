import { describe, expect, it } from 'vitest'
import type { EvaluationInput } from '@lyadmin/core'
import {
  PersistentVelocityPort, PersistentSessionPort,
  type VelocityBackend, type SessionBackend
} from './persistent-ports.js'

/** In-memory doubles for the Mongo-backed backends (real aggregation logic). */
class FakeVelocityBackend implements VelocityBackend {
  private byHash = new Map<string, { count: number; chats: Set<number>; users: Set<number> }>()
  fail = false
  async bumpVelocity(hash: string, chatId: number, userId: number): Promise<{ count: number; chatCount: number; userCount: number }> {
    if (this.fail) throw new Error('mongo down')
    const e = this.byHash.get(hash) ?? { count: 0, chats: new Set(), users: new Set() }
    e.count += 1; e.chats.add(chatId); e.users.add(userId)
    this.byHash.set(hash, e)
    return { count: e.count, chatCount: e.chats.size, userCount: e.users.size }
  }
}

class FakeSessionBackend implements SessionBackend {
  private byKey = new Map<string, string[]>()
  fail = false
  async appendSession(key: string, text: string, maxMessages: number): Promise<string[]> {
    if (this.fail) throw new Error('mongo down')
    const list = this.byKey.get(key) ?? []
    if (text) list.push(text)
    while (list.length > maxMessages) list.shift()
    this.byKey.set(key, list)
    return [...list]
  }
  async resetSession(key: string): Promise<void> { this.byKey.delete(key) }
}

const makeInput = (text: string, chatId: number, userId: number): EvaluationInput =>
  ({ message: { text, chatId }, user: { id: userId } } as unknown as EvaluationInput)

describe('PersistentVelocityPort', () => {
  it('flags the same template across enough chats', async () => {
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { chatThreshold: 3 })
    const text = 'buy cheap followers right here right now'
    expect((await port.check(makeInput(text, 1, 10)))?.exceeded).toBe(false)
    expect((await port.check(makeInput(text, 2, 11)))?.exceeded).toBe(false)
    const third = await port.check(makeInput(text, 3, 12))
    expect(third?.exceeded).toBe(true)
    expect(third?.evidence).toContain('3 chats')
  })

  it('flags repetition in a single chat past the count threshold', async () => {
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { countThreshold: 2 })
    const text = 'join my private channel for signals today'
    expect((await port.check(makeInput(text, 1, 10)))?.exceeded).toBe(false)
    expect((await port.check(makeInput(text, 1, 10)))?.exceeded).toBe(true)
  })

  it('tells one account repeating itself apart from a crowd', async () => {
    // Computed by the backend since this port existed and thrown away by it
    // until 2026-08-01, so `singleAuthor` was permanently absent and the
    // pipeline — which reads absence conservatively, as a wave — never once ran
    // the one-account branch. The in-memory port had been fixed; the Mongo one,
    // the only one the bot actually runs, had not.
    const solo = new PersistentVelocityPort(new FakeVelocityBackend())
    const text = 'join my private channel for signals today'
    await solo.check(makeInput(text, 1, 10))
    await solo.check(makeInput(text, 1, 10))
    expect((await solo.check(makeInput(text, 1, 10)))?.singleAuthor).toBe(true)

    // Three accounts in three chats — over the spread bar, so the verdict
    // exists and can be asked who produced it.
    const crowd = new PersistentVelocityPort(new FakeVelocityBackend())
    await crowd.check(makeInput(text, 1, 10))
    await crowd.check(makeInput(text, 2, 11))
    expect((await crowd.check(makeInput(text, 3, 12)))?.singleAuthor).toBe(false)
  })

  it('one account needs fewer copies than a crowd does', async () => {
    // Three copies from one account is a pattern nobody produces by accident.
    // The same three spread over three people is what a line going round a chat
    // looks like, so that keeps the higher bar.
    const solo = new PersistentVelocityPort(new FakeVelocityBackend())
    const text = 'earn from home no experience needed write me'
    expect((await solo.check(makeInput(text, 1, 10)))?.exceeded).toBe(false)
    expect((await solo.check(makeInput(text, 1, 10)))?.exceeded).toBe(false)
    expect((await solo.check(makeInput(text, 1, 10)))?.exceeded).toBe(true)

    const crowd = new PersistentVelocityPort(new FakeVelocityBackend())
    await crowd.check(makeInput(text, 1, 10))
    await crowd.check(makeInput(text, 1, 11))
    expect((await crowd.check(makeInput(text, 1, 12)))?.exceeded).toBe(false)
  })

  it('the solo bar may only lower the threshold, never raise it', async () => {
    // Read as a replacement rather than a floor, a caller could tighten
    // `countThreshold` and have it silently ignored for the very case the
    // window sees best.
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { countThreshold: 2 })
    const text = 'a template long enough to survive normalisation'
    expect((await port.check(makeInput(text, 1, 10)))?.exceeded).toBe(false)
    expect((await port.check(makeInput(text, 1, 10)))?.exceeded).toBe(true)
  })

  it('ignores empty / too-short text', async () => {
    const port = new PersistentVelocityPort(new FakeVelocityBackend())
    expect(await port.check(makeInput('', 1, 10))).toBeNull()
    expect(await port.check(makeInput('hi', 1, 10))).toBeNull()
  })

  it('degrades to null when the backend is unavailable', async () => {
    const backend = new FakeVelocityBackend(); backend.fail = true
    const port = new PersistentVelocityPort(backend)
    expect(await port.check(makeInput('a long enough spam template here', 1, 10))).toBeNull()
  })
})

describe('PersistentSessionPort', () => {
  it('accumulates the window across calls', async () => {
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 'пиши мені')
    const w = await port.append(1, 10, 'в особисті')
    expect(w).toEqual({ combinedText: 'пиши мені\nв особисті', count: 2 })
  })

  it('caps the window at maxMessages', async () => {
    const port = new PersistentSessionPort(new FakeSessionBackend(), { maxMessages: 2 })
    await port.append(1, 10, 'a')
    await port.append(1, 10, 'b')
    const w = await port.append(1, 10, 'c')
    expect(w.combinedText).toBe('b\nc')
  })

  it('reset clears the window', async () => {
    const backend = new FakeSessionBackend()
    const port = new PersistentSessionPort(backend)
    await port.append(1, 10, 'x')
    await port.reset(1, 10)
    expect((await port.append(1, 10, 'y')).count).toBe(1)
  })

  it('degrades to a single-message window when the backend is unavailable', async () => {
    const backend = new FakeSessionBackend(); backend.fail = true
    const port = new PersistentSessionPort(backend)
    expect(await port.append(1, 10, 'solo')).toEqual({ combinedText: 'solo', count: 1 })
  })
})
