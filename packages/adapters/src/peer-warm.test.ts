import { describe, expect, it, vi } from 'vitest'
import { memberSearchTerm, warmPeer, type PeerWarmTransport } from './peer-warm.js'

const CHAT = -1001000000001
const USER = 4242
const MSG = 77

/**
 * A client whose peer cache starts with `known` and fills the way mtcute's
 * does: as a side effect of whatever result names the account.
 */
const makeTransport = (opts: {
  known?: number[]
  /** The message still exists and was written by USER. */
  messageHasAuthor?: boolean
  messageThrows?: Error
  members?: number[]
  membersThrows?: Error
}) => {
  const cache = new Set(opts.known ?? [])
  const getMessages = vi.fn(async () => {
    if (opts.messageThrows) throw opts.messageThrows
    if (opts.messageHasAuthor) cache.add(USER)
    return [opts.messageHasAuthor ? {} : null]
  })
  const getChatMembers = vi.fn(async () => {
    if (opts.membersThrows) throw opts.membersThrows
    const found = (opts.members ?? []).map((id) => ({ user: { id } }))
    for (const m of found) cache.add(m.user.id)
    return found
  })
  const tg = {
    storage: { peers: { getById: vi.fn(async (id: number) => cache.has(id) ? { _: 'inputPeerUser' } : null) } },
    getMessages,
    getChatMembers
  }
  return { tg: tg as unknown as PeerWarmTransport, getMessages, getChatMembers }
}

describe('warmPeer', () => {
  it('asks Telegram nothing when the account is already addressable', async () => {
    const { tg, getMessages, getChatMembers } = makeTransport({ known: [USER] })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: MSG, nameHint: 'Name' })
    expect(res.source).toBe('cached')
    expect(getMessages).not.toHaveBeenCalled()
    expect(getChatMembers).not.toHaveBeenCalled()
  })

  // 2026-10-14: a vote outlived a deploy that emptied the cache; the message it
  // was about still held the author.
  it('fills a cold cache from the message the decision is about', async () => {
    const { tg, getMessages, getChatMembers } = makeTransport({ messageHasAuthor: true })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: MSG, nameHint: 'Name' })
    expect(res.source).toBe('message')
    expect(getMessages).toHaveBeenCalledWith(CHAT, [MSG])
    expect(getChatMembers).not.toHaveBeenCalled()
  })

  it('falls back to the member search, matched by id, when the message is gone', async () => {
    const { tg, getChatMembers } = makeTransport({ messageHasAuthor: false, members: [1, USER, 2] })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: MSG, nameHint: '  First Last ' })
    expect(res.source).toBe('members')
    expect(getChatMembers).toHaveBeenCalledWith(CHAT, { type: 'all', query: 'First', limit: 50 })
  })

  it('does not take a namesake for the account', async () => {
    const { tg } = makeTransport({ members: [1, 2] })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: MSG, nameHint: 'First' })
    expect(res.source).toBe('unresolved')
  })

  it('reports the first failure and still tries the next route', async () => {
    const first = new Error('CHANNEL_PRIVATE')
    const { tg, getChatMembers } = makeTransport({
      messageThrows: first, membersThrows: new Error('CHAT_ADMIN_REQUIRED')
    })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: MSG, nameHint: 'First' })
    expect(getChatMembers).toHaveBeenCalled()
    expect(res).toEqual({ source: 'unresolved', error: first })
  })

  it('never searches members for a channel sender', async () => {
    const { tg, getChatMembers } = makeTransport({})
    const res = await warmPeer(tg, { chatId: CHAT, userId: -1002000000002, messageId: MSG, nameHint: 'Channel' })
    expect(res.source).toBe('unresolved')
    expect(getChatMembers).not.toHaveBeenCalled()
  })

  it('without a message or a name, says it could not', async () => {
    const { tg, getMessages, getChatMembers } = makeTransport({})
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, nameHint: '   ' })
    expect(res).toEqual({ source: 'unresolved', error: undefined })
    expect(getMessages).not.toHaveBeenCalled()
    expect(getChatMembers).not.toHaveBeenCalled()
  })
})

describe('memberSearchTerm', () => {
  it('takes the first word of any whitespace-separated name', () => {
    expect(memberSearchTerm('A\tB')).toBe('A')
    expect(memberSearchTerm(' X Y')).toBe('X')
    expect(memberSearchTerm('')).toBeNull()
    expect(memberSearchTerm(null)).toBeNull()
    expect(memberSearchTerm(undefined)).toBeNull()
  })
})
