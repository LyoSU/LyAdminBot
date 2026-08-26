import { describe, expect, it } from 'vitest'
import type { EvaluationInput } from '@lyadmin/core'
import {
  PersistentVelocityPort, PersistentSessionPort,
  type VelocityBackend, type SessionBackend, type SessionEntry
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
  async readVelocity(hash: string): Promise<{ count: number; chatCount: number; userCount: number }> {
    if (this.fail) throw new Error('mongo down')
    const e = this.byHash.get(hash)
    return { count: e?.count ?? 0, chatCount: e?.chats.size ?? 0, userCount: e?.users.size ?? 0 }
  }
}

class FakeSessionBackend implements SessionBackend {
  private byKey = new Map<string, SessionEntry[]>()
  fail = false
  // Models the store's replace-by-id, because a fake that merely appends is a
  // fake of the bug: the real backend pulls the id before pushing.
  async appendSession(key: string, entry: SessionEntry, maxMessages: number): Promise<string[]> {
    if (this.fail) throw new Error('mongo down')
    const list = (this.byKey.get(key) ?? []).filter((e) => e.id !== entry.id)
    if (entry.text) list.push(entry)
    while (list.length > maxMessages) list.shift()
    this.byKey.set(key, list)
    return list.map((e) => e.text)
  }
  async resetSession(key: string): Promise<void> { this.byKey.delete(key) }
}

const makeInput = (text: string, chatId: number, userId: number, isEdit = false): EvaluationInput =>
  ({ message: { text, chatId, isEdit }, user: { id: userId } } as unknown as EvaluationInput)

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

  it('REGRESSION: editing a message is not another sighting of its text', async () => {
    // Production 2026-08-24, solo threshold 3: a neighbourhood outage notice was
    // posted twice and edited three times, the counter reached five, and
    // `velocity_repeats` deleted it at 0.908 — after the classifier had called
    // that exact text `legit_share` on each of the four preceding passes.
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { soloThreshold: 3 })
    const text = 'Район 3-ї школи: вул. Саксаганського, Кармелюка, Святкова'
    await port.check(makeInput(text, 1, 10))
    await port.check(makeInput(text, 1, 10, true))
    await port.check(makeInput(text, 1, 10, true))
    expect((await port.check(makeInput(text, 1, 10, true)))?.exceeded).toBe(false)
  })

  it('an edit still SEES a count the text genuinely earned', async () => {
    // Not counting is not the same as not looking: real repetition by other
    // senders must still be visible to a message that arrives as an edit.
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { chatThreshold: 3 })
    const text = 'buy cheap followers right here right now'
    await port.check(makeInput(text, 1, 10))
    await port.check(makeInput(text, 2, 11))
    await port.check(makeInput(text, 3, 12))
    expect((await port.check(makeInput(text, 4, 13, true)))?.exceeded).toBe(true)
  })

  it('a message edited into something else is counted once, on its new text', async () => {
    // The key IS the normalised text, which is what makes skipping the bump
    // safe: an advert edited in has a different key and earns its own first
    // sighting there. Without that, this fix would have hidden `edit_injected`.
    const backend = new FakeVelocityBackend()
    const port = new PersistentVelocityPort(backend, { soloThreshold: 1 })
    await port.check(makeInput('доброго ранку всім у цьому чаті', 1, 10))
    const after = await port.check(makeInput('заходьте у мій канал за заробітком', 1, 10, true))
    expect(after?.exceeded).toBe(false)
  })

  it('a message that arrives first as an edit is not invented a sighting', async () => {
    // Gap recovery can replay a message the window never saw. Zeros, not one.
    const port = new PersistentVelocityPort(new FakeVelocityBackend(), { soloThreshold: 1 })
    expect((await port.check(makeInput('a long enough spam template here', 1, 10, true)))?.exceeded)
      .toBe(false)
  })
})

describe('PersistentSessionPort', () => {
  it('accumulates the window across calls', async () => {
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 101, 'пиши мені')
    const w = await port.append(1, 10, 102, 'в особисті')
    expect(w).toEqual({ combinedText: 'пиши мені\nв особисті', count: 2 })
  })

  it('caps the window at maxMessages', async () => {
    const port = new PersistentSessionPort(new FakeSessionBackend(), { maxMessages: 2 })
    await port.append(1, 10, 101, 'a')
    await port.append(1, 10, 102, 'b')
    const w = await port.append(1, 10, 103, 'c')
    expect(w.combinedText).toBe('b\nc')
  })

  it('reset clears the window', async () => {
    const backend = new FakeSessionBackend()
    const port = new PersistentSessionPort(backend)
    await port.append(1, 10, 101, 'x')
    await port.reset(1, 10)
    expect((await port.append(1, 10, 102, 'y')).count).toBe(1)
  })

  it('degrades to a single-message window when the backend is unavailable', async () => {
    const backend = new FakeSessionBackend(); backend.fail = true
    const port = new PersistentSessionPort(backend)
    expect(await port.append(1, 10, 101, 'solo')).toEqual({ combinedText: 'solo', count: 1 })
  })

  it('REGRESSION: editing a buffered message replaces it, never doubles it', async () => {
    // Production 2026-08-26, a nine-year-old account in an ordinary chat: three
    // conversational messages, each edited once, became a window of five lines
    // — A A B B C. The model was asked about that and answered what it saw,
    // "repeated identical phrases": flood, 0.89, message deleted.
    //
    // Across every session verdict ever recorded, 867 of 2172 windows held a
    // repeated line; the bot acted on 49 of those, and 42 of the 49 had an edit
    // from the same sender inside the same window.
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 101, 'вони ще іноді посаджені квіти викопують собі')
    const w = await port.append(1, 10, 101, 'вони ще іноді посаджені квіти викопують собі')
    expect(w.count).toBe(1)
    expect(w.combinedText).toBe('вони ще іноді посаджені квіти викопують собі')
  })

  it('an edit is judged on its NEW text, not the one it replaced', async () => {
    // Replaces rather than ignores: "hi" edited into an advert is an attack this
    // codebase already names (`edit_injected_link`), so the newest text counts.
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 101, 'привіт')
    const w = await port.append(1, 10, 101, 'заходь у мій канал')
    expect(w.combinedText).toBe('заходь у мій канал')
  })

  it('an edited message moves to the end, because that is when it was said', async () => {
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 101, 'перше')
    await port.append(1, 10, 102, 'друге')
    const w = await port.append(1, 10, 101, 'перше, виправлене')
    expect(w.combinedText).toBe('друге\nперше, виправлене')
  })

  it('two different messages with the same words still count twice', async () => {
    // The point is not to dedupe text. Somebody genuinely posting one line
    // twice IS repetition, and 7 of the 49 acted-on windows were exactly that.
    const port = new PersistentSessionPort(new FakeSessionBackend())
    await port.append(1, 10, 101, 'заробіток')
    const w = await port.append(1, 10, 102, 'заробіток')
    expect(w.count).toBe(2)
  })
})
