import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '@mtcute/node'
import { userHasProfilePhoto } from './enrich.js'

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
