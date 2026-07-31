import { describe, expect, it, vi } from 'vitest'
import { createChatDescriptionCache } from './chat-profile.js'

describe('createChatDescriptionCache', () => {
  it('asks Telegram once and serves the rest from memory', () => {
    const fetch = vi.fn(async () => 'Вакансії у Львові')
    const cache = createChatDescriptionCache(fetch)
    return (async () => {
      expect(await cache.get(-100)).toBe('Вакансії у Львові')
      expect(await cache.get(-100)).toBe('Вакансії у Львові')
      expect(await cache.get(-100)).toBe('Вакансії у Львові')
      expect(fetch).toHaveBeenCalledTimes(1)
    })()
  })

  it('caches the absence of a description too', async () => {
    // Most chats have none. Without a negative entry every message in every such
    // chat would pay for the same lookup and get the same nothing back.
    const fetch = vi.fn(async () => null)
    const cache = createChatDescriptionCache(fetch)
    expect(await cache.get(-100)).toBeNull()
    expect(await cache.get(-100)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats an empty or blank description as absent', async () => {
    const cache = createChatDescriptionCache(async () => '   \n  ')
    expect(await cache.get(-100)).toBeNull()
  })

  it('re-reads after the entry expires, so an edited description is picked up', async () => {
    let clock = 1_000_000
    const fetch = vi.fn(async () => `desc ${clock}`)
    const cache = createChatDescriptionCache(fetch, { ttlMs: 1000, now: () => clock })

    expect(await cache.get(-100)).toBe('desc 1000000')
    clock += 999
    expect(await cache.get(-100)).toBe('desc 1000000')
    clock += 2
    expect(await cache.get(-100)).toBe('desc 1001001')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('collapses a concurrent burst into one call', async () => {
    // A chat under a spam wave delivers many messages at once, and they would all
    // miss the cache together.
    let release = (): void => {}
    const fetch = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return 'опис'
    })
    const cache = createChatDescriptionCache(fetch)

    const all = Promise.all([cache.get(-100), cache.get(-100), cache.get(-100)])
    release()
    expect(await all).toEqual(['опис', 'опис', 'опис'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a failed lookup degrades to null and does not stick forever', async () => {
    let clock = 0
    const fetch = vi.fn(async () => { throw new Error('CHANNEL_PRIVATE') })
    const cache = createChatDescriptionCache(fetch, { ttlMs: 100, now: () => clock })

    expect(await cache.get(-100)).toBeNull()
    // Cached, so a chat that errors does not cost a call per message …
    expect(await cache.get(-100)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    // … but the failure expires like any other entry, so rights granted later
    // (or a transient error) resolve by themselves.
    clock += 101
    expect(await cache.get(-100)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('an in-flight failure does not poison the callers waiting on it', async () => {
    const fetch = vi.fn(async () => { throw new Error('FLOOD_WAIT_12') })
    const cache = createChatDescriptionCache(fetch)
    const [a, b] = await Promise.all([cache.get(-1), cache.get(-1)])
    expect([a, b]).toEqual([null, null])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stays bounded — the bot watches an unbounded number of chats', async () => {
    const fetch = vi.fn(async (chatId: number) => `d${chatId}`)
    const cache = createChatDescriptionCache(fetch, { maxChats: 3 })
    for (const id of [1, 2, 3, 4]) await cache.get(id)
    expect(cache.size()).toBeLessThanOrEqual(3)
    // The oldest entry went, so it costs one more call.
    await cache.get(1)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})
