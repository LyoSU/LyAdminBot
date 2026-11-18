import { describe, expect, it } from 'vitest'
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
    expect(v.meta['filter']).toBe('arabic')
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

  it('leaves trusted members alone', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi }, user: newcomer, policy: { trustedUserIds: [42] }
    }), {})
    expect(v.decidedBy).not.toBe('chat_filter')
  })

  it('an admin ALLOW rule still wins over a filter', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi }, user: newcomer, policy: { customRules: ['ALLOW: سلام'] }
    }), {})
    expect(v).toMatchObject({ action: 'none', reasonCode: 'custom_allow' })
  })

  it('does nothing when the chat switched the bot off', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic'] }, {
      msg: { text: farsi }, user: newcomer, policy: { enabled: false }
    }), {})
    expect(v.action).toBe('none')
  })

  it('a message in the chat’s own language passes the filter untouched', async () => {
    const v = await evaluateMessage(input({ scripts: ['arabic', 'han'], locks: ['stickers'] }, {
      user: regular
    }), {})
    expect(v.decidedBy).not.toBe('chat_filter')
  })
})
