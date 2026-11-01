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
  /** The access hash Telegram accepts for USER; any other is answered with nothing. */
  validHash?: string
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
  const getUsers = vi.fn(async (ids: Array<{ userId: number; accessHash: { toString: () => string } }>) => {
    for (const id of ids) if (id.accessHash.toString() === opts.validHash) cache.add(id.userId)
    return ids.map(() => null)
  })
  const tg = {
    storage: { peers: { getById: vi.fn(async (id: number) => cache.has(id) ? { _: 'inputPeerUser' } : null) } },
    getMessages,
    getChatMembers,
    getUsers
  }
  return { tg: tg as unknown as PeerWarmTransport, getMessages, getChatMembers, getUsers }
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

describe('warmPeer — a newcomer with nothing to go on (2026-10-31)', () => {
  it('finds a recent joiner in the recent-members list', async () => {
    const { tg, getChatMembers } = makeTransport({ members: [7, USER] })
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, recentMembers: true })
    expect(res).toEqual({ source: 'recent', error: undefined })
    expect(getChatMembers).toHaveBeenCalledWith(CHAT, { type: 'recent', limit: 200 })
  })

  it('files the whole list, so the next of a batch is already cached', async () => {
    const { tg, getChatMembers } = makeTransport({ members: [USER, 9001] })
    await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, recentMembers: true })
    const next = await warmPeer(tg, { chatId: CHAT, userId: 9001, messageId: null, recentMembers: true })
    expect(next.source).toBe('cached')
    expect(getChatMembers).toHaveBeenCalledTimes(1)
  })

  it('reports the list failing, and never asks it unless told to', async () => {
    const boom = new Error('CHAT_ADMIN_REQUIRED')
    const failing = makeTransport({ membersThrows: boom })
    expect(await warmPeer(failing.tg, { chatId: CHAT, userId: USER, messageId: null, recentMembers: true }))
      .toEqual({ source: 'unresolved', error: boom })
    const quiet = makeTransport({ members: [USER] })
    await warmPeer(quiet.tg, { chatId: CHAT, userId: USER, messageId: null })
    expect(quiet.getChatMembers).not.toHaveBeenCalled()
  })
})

// 2026-11-01: three cohort siblings joined a day or two before a deploy, never
// wrote, and had dropped out of a large chat's latest 200 joiners.
describe('warmPeer — the access hash kept from the join', () => {
  const HASH = '-8070450532247928832'

  it('asks the account back by its kept hash, before the members list', async () => {
    const { tg, getUsers, getChatMembers } = makeTransport({ validHash: HASH, members: [USER] })
    const storedAccessHash = vi.fn(async () => HASH)
    const res = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash, recentMembers: true })
    expect(res).toEqual({ source: 'stored', error: undefined })
    expect(getUsers.mock.calls[0]![0]![0]).toMatchObject({ _: 'inputPeerUser', userId: USER })
    expect(getUsers.mock.calls[0]![0]![0]!.accessHash.toString()).toBe(HASH)
    expect(getChatMembers).not.toHaveBeenCalled()
  })

  it('reads the store only when the cache does not have the account', async () => {
    const { tg } = makeTransport({ known: [USER] })
    const storedAccessHash = vi.fn(async () => HASH)
    expect((await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash })).source).toBe('cached')
    expect(storedAccessHash).not.toHaveBeenCalled()
  })

  it('falls through to the members list when no hash was kept, or Telegram refuses it', async () => {
    const none = makeTransport({ members: [USER] })
    const a = await warmPeer(none.tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash: async () => null, recentMembers: true })
    expect(a.source).toBe('recent')
    expect(none.getUsers).not.toHaveBeenCalled()
    const stale = makeTransport({ validHash: '1', members: [USER] })
    expect((await warmPeer(stale.tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash: async () => HASH, recentMembers: true })).source).toBe('recent')
  })

  it('reports a failing store read or a malformed hash and goes on', async () => {
    const boom = new Error('store down')
    const { tg } = makeTransport({ members: [USER] })
    expect(await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash: async () => { throw boom } }))
      .toEqual({ source: 'unresolved', error: boom })
    const bad = await warmPeer(tg, { chatId: CHAT, userId: USER, messageId: null, storedAccessHash: async () => 'not-a-number', recentMembers: true })
    expect(bad.source).toBe('recent')
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
