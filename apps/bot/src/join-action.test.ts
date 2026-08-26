import { describe, expect, it } from 'vitest'
import { joinerSource } from './join-action.js'

describe('joinerSource', () => {
  it('REGRESSION: on a bulk add the joiners are named, and the sender is not one', () => {
    // `/report` on an "X added Y" line used to screen X, because the branch read
    // `replied.sender`. The sender of that line is the person who did the
    // adding. This is the whole of that bug, in one assertion.
    expect(joinerSource({ type: 'users_added', users: [111, 222] }))
      .toEqual({ kind: 'ids', ids: [111, 222] })
  })

  it('a link join and an approved join are about the sender', () => {
    expect(joinerSource({ type: 'user_joined_link' })).toEqual({ kind: 'sender' })
    expect(joinerSource({ type: 'user_joined_approved' })).toEqual({ kind: 'sender' })
  })

  it('every other service line names nobody who just arrived', () => {
    // The old test was `if (message.action)`, which is true of all of these.
    for (const type of [
      'pinned_message', 'user_left', 'user_removed', 'title_changed',
      'photo_changed', 'group_created', 'video_chat_started', 'history_cleared'
    ]) {
      expect(joinerSource({ type }), type).toEqual({ kind: 'none' })
    }
  })

  it('no action at all is not a join', () => {
    expect(joinerSource(null)).toEqual({ kind: 'none' })
    expect(joinerSource(undefined)).toEqual({ kind: 'none' })
  })

  it('a bulk add with no ids names nobody rather than falling back to the sender', () => {
    expect(joinerSource({ type: 'users_added' })).toEqual({ kind: 'ids', ids: [] })
  })

  it('the ids are copied, so a caller cannot edit the update it was handed', () => {
    const users = [111]
    const out = joinerSource({ type: 'users_added', users })
    if (out.kind !== 'ids') throw new Error('unreachable')
    out.ids.push(222)
    expect(users).toEqual([111])
  })
})
