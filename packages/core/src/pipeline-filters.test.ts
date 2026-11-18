import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type {
  ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage, UserSnapshot
} from './types.js'
import type { PipelinePorts } from './ports.js'
import { evaluateMessage } from './pipeline.js'
import { DEFAULT_FILTERS, type ChatFilters } from './filters.js'
import { TIMED_BAN_SECONDS } from './policy.js'

const makeMsg = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -100123, messageId: 1, threadId: null, date: 1_780_000_000,
  isEdit: false, editDate: 0, text: 'Звичайне повідомлення в чаті, нічого особливого тут немає',
  urls: [], mentions: [], attachments: [], inlineButtons: [],
  forward: null, replyTo: null, channelComment: null, editDelta: null,
  customEmoji: [], guestBot: null,
  ...over
})

/** A member with standing: tenure and volume, not newish on any clock. */
const regular: Partial<UserSnapshot> = { messagesInChat: 8, messagesGlobal: 40, localAgeDays: 400 }
const newcomer: Partial<UserSnapshot> = { messagesInChat: 1, messagesGlobal: 2, localAgeDays: 0, predictedAgeDays: 10 }

const makeUser = (over: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42, username: 'someone', displayName: 'Someone', languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800, predictedAgeBoundsDays: null, localAgeDays: 400,
  messagesInChat: 8, messagesGlobal: 40, groupsActive: 2,
  spamDetections: 0, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: { count: 2, latestSetDaysAgo: 200 },
  nameChurn24h: 0, usernameChurn24h: 0, restrictionReasons: [], joinedAgoSeconds: null,
  ...over
})

const chat: NormalizedChat = { id: -100123, kind: 'group', title: 'Test', topLanguage: 'uk', description: null }

const enrichment: Enrichment = {
  bio: null, businessTexts: [], linkedChannels: [], personalChannelId: null, resolvedMentions: [],
  conversationWindow: [], photoBase64: null, avatarBase64: null, storyBase64: []
}

const input = (f: Partial<ChatFilters>, over: {
  msg?: Partial<NormalizedMessage>; user?: Partial<UserSnapshot>; policy?: Partial<ChatPolicy>
} = {}): EvaluationInput => ({
  message: makeMsg(over.msg),
  chat,
  user: makeUser(over.user),
  policy: {
    enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
    externalBanEnabled: true, customRules: [], trustedUserIds: [],
    filters: { ...DEFAULT_FILTERS, ...f },
    ...over.policy
  },
  enrichment
})

/** Ports that fail the test if anything paid is asked: a filter needs none. */
const noPorts: PipelinePorts = {
  llm: { classify: async () => { throw new Error('the LLM must not be asked') } }
} as unknown as PipelinePorts

const farsi = 'سلام دوستان، کار آنلاین با درآمد عالی'

describe('evaluateMessage — chat filters', () => {
  it('removes a Farsi message from a newcomer with the configured action, unasked', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'], action: 'ban' }, {
      msg: { text: farsi }, user: newcomer
    }), noPorts)
    expect(v).toMatchObject({
      action: 'ban', decidedBy: 'chat_filter', reasonCode: 'filter_script',
      ruleId: 'filter:script:arabic', needsVote: false, banDurationSeconds: TIMED_BAN_SECONDS, pSpam: 0
    })
    expect(v.meta['filter']).toBe('script')
    expect(v.meta['filterScript']).toBe('arabic')
  })

  it('takes only the message from a member with standing, and says it capped', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'], action: 'ban' }, {
      msg: { text: farsi }, user: regular
    }), noPorts)
    expect(v.action).toBe('delete')
    expect(v.meta['filterCappedFrom']).toBe('ban')
  })

  it('binds an established regular too — a house rule is not a spam guess', async () => {
    const v = await evaluateMessage(input({ locks: ['stickers'] }, {
      msg: { text: '', attachments: [{ kind: 'sticker', fileUniqueId: 'x' }] },
      user: { messagesInChat: 500, messagesGlobal: 2000, localAgeDays: 900 }
    }), noPorts)
    expect(v).toMatchObject({ action: 'delete', decidedBy: 'chat_filter', reasonCode: 'filter_lock' })
  })

  it('binds a member on the chat\'s trusted list: trust is "not a spammer", not "above the rules"', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi },
      user: { messagesInChat: 500, messagesGlobal: 2000, localAgeDays: 900 },
      policy: { trustedUserIds: [42] }
    }), noPorts)
    expect(v).toMatchObject({ action: 'delete', decidedBy: 'chat_filter', reasonCode: 'filter_script' })
  })

  it('binds a member the network trusts by volume', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi },
      user: { messagesInChat: 500, messagesGlobal: 2000, localAgeDays: 900, reputationStatus: 'trusted' }
    }), noPorts)
    expect(v).toMatchObject({ action: 'delete', decidedBy: 'chat_filter', reasonCode: 'filter_script' })
  })

  it('an admin ALLOW rule still wins over a filter', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi }, user: newcomer, policy: { customRules: ['ALLOW: سلام'] }
    }), {})
    expect(v).toMatchObject({ action: 'none', reasonCode: 'custom_allow' })
  })

  it('keeps the house rules on when the chat switched the antispam off', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi }, user: newcomer, policy: { enabled: false }
    }), noPorts)
    expect(v).toMatchObject({ action: 'delete', decidedBy: 'chat_filter' })
  })

  it('a message in the chat’s own language passes the filter untouched', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic', 'han'], locks: ['stickers'] }, {
      user: regular
    }), {})
    expect(v.decidedBy).not.toBe('chat_filter')
  })
})

describe('evaluateMessage — flood and warnings', () => {
  it('a newcomer past the flood limit gets the chat’s action', async () => {
    const i = input({ flood: { messages: 5, seconds: 10 }, action: 'mute' }, { user: newcomer })
    i.enrichment = { ...i.enrichment, senderRecentCount: 6 }
    const v = await evaluateMessage(i, noPorts)
    expect(v).toMatchObject({ action: 'mute', reasonCode: 'filter_flood', ruleId: 'filter:flood' })
    expect(v.meta['filterCount']).toBe(6)
  })

  it('warn deletes and asks the app layer for a warning — for a newcomer only', async () => {
    const forNewcomer = await evaluateMessage(input({ words: ['казино'], action: 'warn' }, {
      msg: { text: 'найкраще казино' }, user: newcomer
    }), noPorts)
    expect(forNewcomer).toMatchObject({ action: 'delete', reasonCode: 'filter_word', ruleId: 'filter:word' })
    expect(forNewcomer.meta['filterWarn']).toBe(true)

    const forRegular = await evaluateMessage(input({ words: ['казино'], action: 'warn' }, {
      msg: { text: 'найкраще казино' }, user: regular
    }), noPorts)
    expect(forRegular.action).toBe('delete')
    expect(forRegular.meta['filterWarn']).toBeUndefined()
  })

  it('the stop-word itself never reaches the rule id', async () => {
    const v = await evaluateMessage(input({ words: ['секретнеслово'] }, {
      msg: { text: 'тут секретнеслово' }, user: newcomer
    }), noPorts)
    expect(v.ruleId).toBe('filter:word')
    expect(JSON.stringify(v.meta)).not.toContain('секретнеслово')
  })
})

describe('evaluateMessage — house rules stand above the antispam', () => {
  /**
   * Whoever the sender is and however the antispam is tuned, a message a filter
   * catches is removed by the filter. Only an admin's ALLOW rule (here) and an
   * admin sender (the executor) stand above it. Every exemption the antispam
   * grows later is a field this generator already varies or must be added to.
   */
  it('a filter hit is the verdict for any sender facts and any antispam setting', async () => {
    const userArb = fc.record({
      messagesInChat: fc.option(fc.nat(100_000), { nil: null }),
      messagesGlobal: fc.option(fc.nat(1_000_000), { nil: null }),
      localAgeDays: fc.option(fc.nat(5_000), { nil: null }),
      predictedAgeDays: fc.option(fc.nat(5_000), { nil: null }),
      spamDetections: fc.nat(50),
      reputationStatus: fc.constantFrom('trusted', 'neutral', 'suspicious', 'restricted') as
        fc.Arbitrary<UserSnapshot['reputationStatus']>
    })
    const policyArb = fc.record({
      enabled: fc.boolean(),
      preset: fc.constantFrom('relaxed', 'standard', 'strict') as fc.Arbitrary<ChatPolicy['preset']>,
      captchaEnabled: fc.boolean(),
      votingEnabled: fc.boolean(),
      externalBanEnabled: fc.boolean(),
      trustedUserIds: fc.constantFrom<number[]>([], [42]),
      customRules: fc.constantFrom<string[]>([], ['DENY: казино'])
    })
    await fc.assert(fc.asyncProperty(
      userArb, policyArb, fc.constantFrom('delete', 'warn', 'mute', 'ban') as fc.Arbitrary<ChatFilters['action']>,
      async (user, policy, action) => {
        const v = await evaluateMessage(input({ scripts: ['arabic'], action }, {
          msg: { text: farsi }, user, policy
        }), noPorts)
        expect(v.decidedBy).toBe('chat_filter')
        expect(['delete', 'mute', 'ban']).toContain(v.action)
      }
    ), { numRuns: 300 })
  })
})
