import { describe, expect, it, vi } from 'vitest'
import {
  isChannelSender, moderationActionsOver, type ModerationTransport
} from './moderation-actions.js'

const makeTransport = () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const record = (name: string) => vi.fn(async (args: Record<string, unknown>) => {
    calls.push({ name, args })
  })
  const tg = {
    deleteMessagesById: vi.fn(async (chatId: number, ids: number[]) => {
      calls.push({ name: 'deleteMessagesById', args: { chatId, ids } })
    }),
    restrictChatMember: record('restrictChatMember'),
    banChatMember: record('banChatMember'),
    unbanChatMember: record('unbanChatMember')
  }
  return { tg: tg as unknown as ModerationTransport, calls, spies: tg }
}

const USER = 42
const CHANNEL = -1004497662524
const CHAT = -1001158592603

describe('isChannelSender', () => {
  it('reads the kind off the sign of the marked id', () => {
    expect(isChannelSender(USER)).toBe(false)
    expect(isChannelSender(CHANNEL)).toBe(true)
    expect(isChannelSender(CHAT)).toBe(true)
  })
})

describe('mute', () => {
  it('silences a person by restricting them', async () => {
    const { tg, calls, spies } = makeTransport()
    await moderationActionsOver(tg).mute(CHAT, USER, 3600)
    expect(calls.map((c) => c.name)).toEqual(['restrictChatMember'])
    expect(spies.banChatMember).not.toHaveBeenCalled()
    const args = calls[0]!.args as { restrictions: Record<string, boolean>; until: Date }
    expect(args.restrictions['sendMessages']).toBe(true)
    expect(args.restrictions['sendPlain']).toBe(true)
  })

  /**
   * 2026-08-27: a sender chat has two states, not three. The partial rights a
   * mute sends are accepted for a channel participant and applied to nothing,
   * so the restriction reported success while the channel kept posting.
   */
  it('silences a channel the only way a channel can be silenced', async () => {
    const { tg, calls, spies } = makeTransport()
    await moderationActionsOver(tg).mute(CHAT, CHANNEL, 24 * 60 * 60)
    expect(calls.map((c) => c.name)).toEqual(['banChatMember'])
    expect(spies.restrictChatMember).not.toHaveBeenCalled()
  })

  it('gives a channel back the same deadline the mute carried', async () => {
    const { tg, calls } = makeTransport()
    const before = Date.now()
    await moderationActionsOver(tg).mute(CHAT, CHANNEL, 600)
    const { untilDate } = calls[0]!.args as { untilDate: Date }
    // The sentence is the duration, whichever encoding carries it.
    expect(untilDate.getTime()).toBeGreaterThanOrEqual(before + 600_000)
    expect(untilDate.getTime()).toBeLessThan(before + 600_000 + 5_000)
  })

  it('never leaves a channel banned for good', async () => {
    const { tg, calls } = makeTransport()
    await moderationActionsOver(tg).mute(CHAT, CHANNEL, 24 * 60 * 60)
    expect((calls[0]!.args as { untilDate?: Date }).untilDate).toBeInstanceOf(Date)
  })
})

describe('the other three actions', () => {
  it('deletes by id', async () => {
    const { tg, calls } = makeTransport()
    await moderationActionsOver(tg).deleteMessage(CHAT, 7)
    expect(calls).toEqual([{ name: 'deleteMessagesById', args: { chatId: CHAT, ids: [7] } }])
  })

  it('kicks by banning and undoing it at once', async () => {
    const { tg, calls } = makeTransport()
    await moderationActionsOver(tg).kick(CHAT, USER)
    expect(calls.map((c) => c.name)).toEqual(['banChatMember', 'unbanChatMember'])
    // No deadline: the ban exists to be undone on the next line.
    expect((calls[0]!.args as { untilDate?: Date }).untilDate).toBeUndefined()
  })

  it('bans for a term, or for good when there is none', async () => {
    const { tg, calls } = makeTransport()
    const actions = moderationActionsOver(tg)
    await actions.ban(CHAT, USER, 2592000)
    await actions.ban(CHAT, USER, null)
    expect((calls[0]!.args as { untilDate?: Date }).untilDate).toBeInstanceOf(Date)
    expect((calls[1]!.args as { untilDate?: Date }).untilDate).toBeUndefined()
  })
})
