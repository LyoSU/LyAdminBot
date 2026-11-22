import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '@mtcute/node'
import fc from 'fast-check'
import type { tl } from '@mtcute/node'
import { CHANNEL_POSTS_LIMIT, fetchUserProfile, summarizeChannelPosts, userHasProfilePhoto } from './enrich.js'

const fakeTg = (user: unknown, calls: string[] = []): TelegramClient => ({
  resolvePeer: async () => ({ _: 'inputPeerUser', userId: 7, accessHash: 0 }),
  call: async (request: { _: string }) => {
    calls.push(request._)
    if (user instanceof Error) throw user
    return [user]
  }
}) as unknown as TelegramClient

describe('userHasProfilePhoto', () => {
  it('reads the picture off the user object, not the photo list', async () => {
    const calls: string[] = []
    const tg = fakeTg({ _: 'user', id: 7, photo: { _: 'userProfilePhoto' } }, calls)
    expect(await userHasProfilePhoto(tg, 7)).toBe(true)
    // `photos.getUserPhotos` is the call with a flood-wait history here.
    expect(calls).toEqual(['users.getUsers'])
  })

  it('no picture is an answer', async () => {
    expect(await userHasProfilePhoto(fakeTg({ _: 'user', id: 7 }), 7)).toBe(false)
    expect(await userHasProfilePhoto(
      fakeTg({ _: 'user', id: 7, photo: { _: 'userProfilePhotoEmpty' } }), 7)).toBe(false)
  })

  it('no answer is not "no picture"', async () => {
    expect(await userHasProfilePhoto(fakeTg(new Error('FLOOD_WAIT_30')), 7)).toBeNull()
    expect(await userHasProfilePhoto(fakeTg({ _: 'userEmpty', id: 7 }), 7)).toBeNull()
  })
})

describe('summarizeChannelPosts', () => {
  const NOW = 1_800_000_000
  const post = (over: Record<string, unknown> = {}): tl.TypeMessage =>
    ({ _: 'message', id: 1, date: NOW - 86400, message: 'text', ...over }) as unknown as tl.TypeMessage

  it('counts links, URL buttons and forwards, and dates the newest and the span', () => {
    const facts = summarizeChannelPosts([
      post({ date: NOW - 3600, entities: [{ _: 'messageEntityTextUrl' }] }),
      post({ date: NOW - 2 * 86400, replyMarkup: { _: 'replyInlineMarkup', rows: [{ buttons: [{ _: 'keyboardButtonUrl' }] }] } }),
      post({ date: NOW - 10 * 86400, fwdFrom: { _: 'messageFwdHeader' }, entities: [{ _: 'messageEntityBold' }] }),
      { _: 'messageService', id: 9, date: NOW } as unknown as tl.TypeMessage
    ], 340, NOW)
    expect(facts).toEqual({ fetched: 3, total: 340, withLinks: 1, withButtons: 1, forwarded: 1, newestAgeDays: 0, spanDays: 9 })
  })

  it('an empty channel is a fact, not a failure', () => {
    expect(summarizeChannelPosts([], 0, NOW)).toEqual({
      fetched: 0, total: 0, withLinks: 0, withButtons: 0, forwarded: 0, newestAgeDays: null, spanDays: null
    })
  })

  it('PROPERTY: whatever the posts, every count stays within what was fetched and no number is negative or NaN', () => {
    const anyPost = fc.record({
      _: fc.constantFrom('message', 'messageService', 'messageEmpty'),
      date: fc.oneof(fc.integer({ min: -5, max: NOW + 10 * 86400 }), fc.constant(undefined)),
      entities: fc.option(fc.array(fc.record({ _: fc.constantFrom('messageEntityUrl', 'messageEntityTextUrl', 'messageEntityBold') }), { maxLength: 3 }), { nil: undefined }),
      fwdFrom: fc.option(fc.constant({ _: 'messageFwdHeader' }), { nil: undefined }),
      replyMarkup: fc.option(fc.oneof(
        fc.constant({ _: 'replyKeyboardHide' }),
        fc.record({ _: fc.constant('replyInlineMarkup'), rows: fc.array(fc.record({ buttons: fc.array(fc.record({ _: fc.constantFrom('keyboardButtonUrl', 'keyboardButtonCallback') }), { maxLength: 2 }) }), { maxLength: 2 }) })
      ), { nil: undefined })
    })
    fc.assert(fc.property(fc.array(anyPost, { maxLength: 25 }), fc.option(fc.integer({ min: -3, max: 5000 }), { nil: null }), (posts, total) => {
      const f = summarizeChannelPosts(posts as unknown as tl.TypeMessage[], total, NOW)
      for (const n of [f.withLinks, f.withButtons, f.forwarded]) { expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(f.fetched) }
      expect(f.fetched).toBeLessThanOrEqual(posts.length)
      for (const n of [f.total, f.newestAgeDays, f.spanDays]) if (n !== null) { expect(Number.isInteger(n)).toBe(true); expect(n).toBeGreaterThanOrEqual(0) }
      if (f.total !== null) expect(f.total).toBeGreaterThanOrEqual(f.fetched)
    }))
  })
})

describe('fetchUserProfile — the channel on the profile', () => {
  const NOW = 1_800_000_000
  /** A client that answers each raw method from a table and records what was asked, with what options. */
  const tgWith = (answers: Record<string, unknown>, asked: Array<[string, unknown]> = []): TelegramClient => ({
    resolvePeer: async () => ({ _: 'inputPeerUser', userId: 7, accessHash: 0 }),
    call: async (request: { _: string }, options?: unknown) => {
      asked.push([request._, options])
      const a = answers[request._]
      if (a instanceof Error) throw a
      if (a === undefined) throw new Error('not stubbed')
      return a
    }
  }) as unknown as TelegramClient
  const fullUser = (personalChannelId?: number) => ({
    fullUser: { about: null, personalChannelId },
    chats: personalChannelId === undefined ? [] : [{ _: 'channel', id: personalChannelId, title: 'c', accessHash: 0 }]
  })

  it('reads the posts once, without sleeping on a flood wait, and counts them', async () => {
    const asked: Array<[string, unknown]> = []
    const profile = await fetchUserProfile(tgWith({
      'users.getFullUser': fullUser(55),
      'messages.getPersonalChannelHistory': {
        _: 'messages.channelMessages', count: 300,
        messages: [{ _: 'message', id: 2, date: NOW - 86400, message: 'x', entities: [{ _: 'messageEntityUrl' }] }]
      }
    }, asked), 7, NOW)
    expect(profile.channelPosts).toMatchObject({ fetched: 1, total: 300, withLinks: 1, newestAgeDays: 1 })
    const call = asked.filter(([name]) => name === 'messages.getPersonalChannelHistory')
    expect(call).toHaveLength(1)
    expect(call[0]?.[1]).toMatchObject({ floodSleepThreshold: 0 })
    expect(CHANNEL_POSTS_LIMIT).toBeLessThanOrEqual(20)
  })

  it('does not ask when the profile has no channel', async () => {
    const asked: Array<[string, unknown]> = []
    const profile = await fetchUserProfile(tgWith({ 'users.getFullUser': fullUser() }, asked), 7, NOW)
    expect(profile.channelPosts).toBeNull()
    expect(asked.map(([name]) => name)).not.toContain('messages.getPersonalChannelHistory')
  })

  it('a refusal leaves the rest of the profile intact; a flood wait switches the read off for the next account', async () => {
    const refused = await fetchUserProfile(tgWith({
      'users.getFullUser': fullUser(55),
      'messages.getPersonalChannelHistory': new Error('Telegram API error 400: USER_PERSONAL_CHANNEL_MISSING')
    }), 7, NOW)
    expect(refused.channelPosts).toBeNull()
    expect(refused.personalChannelId).toBe(55)

    await fetchUserProfile(tgWith({
      'users.getFullUser': fullUser(55),
      'messages.getPersonalChannelHistory': new Error('Telegram API error 420: FLOOD_WAIT_300')
    }), 7, NOW)
    const asked: Array<[string, unknown]> = []
    const after = await fetchUserProfile(tgWith({
      'users.getFullUser': fullUser(55),
      'messages.getPersonalChannelHistory': { _: 'messages.channelMessages', count: 1, messages: [] }
    }, asked), 8, NOW)
    expect(asked.map(([name]) => name)).not.toContain('messages.getPersonalChannelHistory')
    expect(after.channelPosts).toBeNull()
  })
})
