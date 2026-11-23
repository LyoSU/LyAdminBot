import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import {
  heavierSentenceStands, isChannelSender, moderationActionsOver, type ModerationTransport
} from './moderation-actions.js'

const makeTransport = (standing: unknown = { status: 'member', restrictions: null }) => {
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
    unbanChatMember: record('unbanChatMember'),
    getChatMember: vi.fn(async (): Promise<unknown> => {
      if (standing instanceof Error) throw standing
      return standing
    })
  }
  return { tg: tg as unknown as ModerationTransport, calls, spies: tg }
}

/** The fifteen send rights, all withheld — the shape `readMemberRestriction` calls a full mute. */
const ALL_BLOCKED = Object.fromEntries([
  'canSendMessages', 'canSendMedia', 'canSendStickers', 'canSendGifs', 'canSendGames',
  'canUseInline', 'canAddWebPreviews', 'canSendPolls', 'canSendPhotos', 'canSendVideos',
  'canSendRoundVideos', 'canSendAudios', 'canSendVoices', 'canSendFiles', 'canSendText'
].map((right) => [right, false]))
const inHours = (h: number): Date => new Date(Date.now() + h * 3600_000)

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

describe('kick', () => {
  it('REGRESSION: the ban half expires by itself if the unban never lands', async () => {
    // Ban-then-unban with no expiry: an unban that failed left a permanent ban
    // behind a record that said the kick did not apply (2026-09-23 review).
    // Under 30 seconds Telegram reads the date as "forever", so the safety net
    // sits above that.
    const { tg, calls } = makeTransport()
    const before = Date.now()
    await moderationActionsOver(tg).kick(CHAT, USER)
    expect(calls.map((c) => c.name)).toEqual(['banChatMember', 'unbanChatMember'])
    const until = (calls[0]!.args as { untilDate?: Date }).untilDate
    expect(until).toBeInstanceOf(Date)
    const seconds = (until!.getTime() - before) / 1000
    expect(seconds).toBeGreaterThan(30)
    expect(seconds).toBeLessThanOrEqual(120)
  })
})

/**
 * 2026-11-23: `channels.editBanned` replaces a member's banned rights, so a
 * mute written for a banned account turns the ban into that mute. 24 ballots in
 * 14 days closed "spam" over an account banned since they opened.
 */
describe('a mute never replaces a heavier sentence', () => {
  it('leaves a banned person banned and says so', async () => {
    const { tg, calls } = makeTransport({ status: 'banned', restrictions: { untilDate: null } })
    expect(await moderationActionsOver(tg).mute(CHAT, USER, 6 * 3600)).toBe('stands')
    expect(calls).toEqual([])
  })

  it('leaves a banned person banned even when the ban ends before the mute would', async () => {
    const { tg, calls } = makeTransport({ status: 'banned', restrictions: { untilDate: inHours(1) } })
    expect(await moderationActionsOver(tg).mute(CHAT, USER, 6 * 3600)).toBe('stands')
    expect(calls).toEqual([])
  })

  it('does not cut an indefinite or longer full mute down to its own length', async () => {
    for (const untilDate of [null, inHours(48)]) {
      const { tg, calls } = makeTransport({ status: 'restricted', restrictions: { ...ALL_BLOCKED, untilDate } })
      expect(await moderationActionsOver(tg).mute(CHAT, USER, 3600)).toBe('stands')
      expect(calls).toEqual([])
    }
  })

  it('extends a shorter full mute, and writes over a partial one', async () => {
    const shorter = makeTransport({ status: 'restricted', restrictions: { ...ALL_BLOCKED, untilDate: inHours(0.5) } })
    expect(await moderationActionsOver(shorter.tg).mute(CHAT, USER, 3600)).toBeUndefined()
    expect(shorter.calls.map((c) => c.name)).toEqual(['restrictChatMember'])
    const partial = makeTransport({ status: 'restricted', restrictions: { ...ALL_BLOCKED, canSendText: true, untilDate: null } })
    await moderationActionsOver(partial.tg).mute(CHAT, USER, 3600)
    expect(partial.calls.map((c) => c.name)).toEqual(['restrictChatMember'])
  })

  it('mutes when the member cannot be read, or is not there', async () => {
    for (const standing of [new Error('TIMEOUT'), null]) {
      const { tg, calls } = makeTransport(standing)
      expect(await moderationActionsOver(tg).mute(CHAT, USER, 3600)).toBeUndefined()
      expect(calls.map((c) => c.name)).toEqual(['restrictChatMember'])
    }
  })

  it('keeps a channel\'s standing ban only when it lasts at least as long', async () => {
    const forever = makeTransport({ status: 'banned', restrictions: { untilDate: null } })
    expect(await moderationActionsOver(forever.tg).mute(CHAT, CHANNEL, 3600)).toBe('stands')
    expect(forever.calls).toEqual([])
    const brief = makeTransport({ status: 'banned', restrictions: { untilDate: inHours(0.5) } })
    await moderationActionsOver(brief.tg).mute(CHAT, CHANNEL, 3600)
    expect(brief.calls.map((c) => c.name)).toEqual(['banChatMember'])
  })

  it('writes without looking when a person asked for exactly this', async () => {
    const { tg, calls, spies } = makeTransport({ status: 'banned', restrictions: { untilDate: null } })
    await moderationActionsOver(tg).mute(CHAT, USER, 3600, { replace: true })
    expect(spies.getChatMember).not.toHaveBeenCalled()
    expect(calls.map((c) => c.name)).toEqual(['restrictChatMember'])
  })

  it('property: whatever stands, a person\'s ban is kept, and a standing sentence is never shorter than the mute', () => {
    const until = fc.option(fc.integer({ min: 1, max: 4e12 }), { nil: null })
    fc.assert(fc.property(
      fc.constantFrom('banned', 'restricted', 'member', 'left', 'admin', 'creator', 'unknown'),
      until, fc.boolean(), fc.integer({ min: 1, max: 4e12 }), fc.boolean(),
      (status, untilMs, allSendBlocked, muteUntilMs, channel) => {
        const stands = heavierSentenceStands({ status, untilMs, allSendBlocked }, muteUntilMs, channel)
        if (status === 'banned' && !channel) expect(stands).toBe(true)
        if (status !== 'banned' && status !== 'restricted') expect(stands).toBe(false)
        if (stands && !(status === 'banned' && !channel)) expect(untilMs === null || untilMs >= muteUntilMs).toBe(true)
        if (status === 'restricted' && !allSendBlocked) expect(stands).toBe(false)
      }
    ))
  })
})
