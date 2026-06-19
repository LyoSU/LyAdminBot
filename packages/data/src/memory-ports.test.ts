import { describe, expect, it } from 'vitest'
import type { EvaluationInput } from '@lyadmin/core'
import { MemoryVelocityPort } from './velocity-port.js'
import { MemorySessionPort } from './session-port.js'

const makeInput = (chatId: number, userId: number, text: string): EvaluationInput => ({
  message: {
    chatId, messageId: 1, threadId: null, date: 0, isEdit: false, text,
    urls: [], mentions: [], attachments: [], inlineButtons: [],
    forward: null, replyTo: null, channelComment: null, editDelta: null,
    customEmoji: [], guestBot: null
  },
  chat: { id: chatId, kind: 'group', title: 't', topLanguage: null },
  user: {
    id: userId, username: null, displayName: 'U', languageCode: null,
    flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
    predictedAgeDays: null, localAgeDays: null, messagesInChat: 0, messagesGlobal: 0,
    groupsActive: 0, spamDetections: 0, reputationScore: 50, reputationStatus: 'neutral',
    externalBan: null, unofficialClientRisk: null, avatars: null, nameChurn24h: 0, usernameChurn24h: 0
  },
  policy: {
    enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true,
    reactionModeration: false, externalBanEnabled: true, customRules: [], trustedUserIds: []
  },
  enrichment: { bio: null, resolvedMentions: [], conversationWindow: [], photoBase64: null }
})

const SPAM = 'Потрібні люди на склад оплата щодня пиши в особисті'

describe('MemoryVelocityPort', () => {
  it('triggers when the same template hits 3 chats', async () => {
    const port = new MemoryVelocityPort()
    expect((await port.check(makeInput(-1, 10, SPAM)))?.exceeded).toBe(false)
    expect((await port.check(makeInput(-2, 11, SPAM)))?.exceeded).toBe(false)
    const third = await port.check(makeInput(-3, 12, SPAM))
    expect(third?.exceeded).toBe(true)
    expect(third?.evidence).toContain('3 chats')
  })

  it('templated variants (different numbers/usernames) match', async () => {
    const port = new MemoryVelocityPort()
    await port.check(makeInput(-1, 1, 'Заробіток 500$ пиши @a_bot'))
    await port.check(makeInput(-2, 2, 'Заробіток 900$ пиши @b_bot'))
    const third = await port.check(makeInput(-3, 3, 'Заробіток 100$ пиши @c_bot'))
    expect(third?.exceeded).toBe(true)
  })

  it('the window expires', async () => {
    let now = 1_000_000
    const port = new MemoryVelocityPort({ windowMs: 1000 }, () => now)
    await port.check(makeInput(-1, 1, SPAM))
    await port.check(makeInput(-2, 2, SPAM))
    now += 5000
    const after = await port.check(makeInput(-3, 3, SPAM))
    expect(after?.exceeded).toBe(false)
  })

  it('ignores short / non-textual messages', async () => {
    const port = new MemoryVelocityPort()
    expect(await port.check(makeInput(-1, 1, '😀😀'))).toBeNull()
    expect(await port.check(makeInput(-1, 1, ''))).toBeNull()
  })
})

describe('MemorySessionPort', () => {
  it('accumulates per chat:user and joins with newlines', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 'пиши мені')
    await port.append(-1, 42, 'в особисті')
    const window = await port.append(-1, 42, 'заробіток')
    expect(window.count).toBe(3)
    expect(window.combinedText).toBe('пиши мені\nв особисті\nзаробіток')
  })

  it('sessions are isolated between users and chats', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 'a')
    const other = await port.append(-1, 43, 'b')
    expect(other.count).toBe(1)
  })

  it('expires after the window', async () => {
    let now = 0
    const port = new MemorySessionPort({ windowMs: 1000 }, () => now)
    await port.append(-1, 42, 'a')
    now = 5000
    const fresh = await port.append(-1, 42, 'b')
    expect(fresh.count).toBe(1)
  })

  it('reset clears the buffer', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 'a')
    port.reset(-1, 42)
    const fresh = await port.append(-1, 42, 'b')
    expect(fresh.count).toBe(1)
  })
})
