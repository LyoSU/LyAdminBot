import { describe, expect, it } from 'vitest'
import type { EvaluationInput } from '@lyadmin/core'
import { MemoryVelocityPort } from './velocity-port.js'
import { MemorySessionPort } from './session-port.js'

let nextMessageId = 1
const makeInput = (
  chatId: number, userId: number, text: string, messageId = nextMessageId++
): EvaluationInput => ({
  message: {
    chatId, messageId, threadId: null, date: 0, isEdit: false, editDate: 0, text,
    urls: [], mentions: [], attachments: [], inlineButtons: [],
    forward: null, replyTo: null, channelComment: null, editDelta: null,
    customEmoji: [], guestBot: null
  },
  chat: { id: chatId, kind: 'group', title: 't', topLanguage: null , description: null},
  user: {
    id: userId, username: null, displayName: 'U', languageCode: null,
    flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
    predictedAgeDays: null, predictedAgeBoundsDays: null, localAgeDays: null, messagesInChat: 0, messagesGlobal: 0,
    groupsActive: 0, spamDetections: 0, reputationStatus: 'neutral',
    externalBan: null, unofficialClientRisk: null, avatars: null, nameChurn24h: 0, usernameChurn24h: 0,
    restrictionReasons: [], joinedAgoSeconds: null
  },
  policy: {
    enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true,
    externalBanEnabled: true, customRules: [], trustedUserIds: []
  },
  enrichment: {
    bio: null, businessTexts: [], personalChannelId: null, linkedChannels: [],
    resolvedMentions: [], conversationWindow: [], photoBase64: null, avatarBase64: null, storyBase64: []
  }
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

  it('REGRESSION: one message seen twice is one copy, not two', async () => {
    // The same defect the Mongo-backed port carried, in the implementation whose
    // own comment says two answers to "what counts as the same message" is one
    // too many. For a while the id half of that answer was in neither.
    const port = new MemoryVelocityPort({ soloThreshold: 3 })
    for (let i = 0; i < 3; i += 1) await port.check(makeInput(-1, 10, SPAM, 7001))
    expect((await port.check(makeInput(-1, 10, SPAM, 7001)))?.exceeded).toBe(false)
  })

  it('the same text from two different messages is two copies', async () => {
    const port = new MemoryVelocityPort({ soloThreshold: 2 })
    await port.check(makeInput(-1, 10, SPAM, 8001))
    expect((await port.check(makeInput(-1, 10, SPAM, 8002)))?.exceeded).toBe(true)
  })

  it('ids are namespaced by chat, because Telegram numbers messages per chat', async () => {
    const port = new MemoryVelocityPort({ soloThreshold: 2, chatThreshold: 99 })
    await port.check(makeInput(-1, 10, SPAM, 5000))
    expect((await port.check(makeInput(-2, 10, SPAM, 5000)))?.exceeded).toBe(true)
  })

  it('templated variants (different numbers/usernames) match', async () => {
    const port = new MemoryVelocityPort()
    await port.check(makeInput(-1, 1, 'Заробіток 500$ пиши @a_bot'))
    await port.check(makeInput(-2, 2, 'Заробіток 900$ пиши @b_bot'))
    const third = await port.check(makeInput(-3, 3, 'Заробіток 100$ пиши @c_bot'))
    expect(third?.exceeded).toBe(true)
  })

  it('reports ONE account blasting separately from several accounts carrying a text', async () => {
    // The distinction the port used to compute and then discard. A blast is
    // certain; a wave might be a campaign or might be a viral line, and the
    // pipeline prices the two differently.
    const blast = new MemoryVelocityPort()
    await blast.check(makeInput(-1, 7, SPAM))
    await blast.check(makeInput(-2, 7, SPAM))
    expect((await blast.check(makeInput(-3, 7, SPAM)))?.singleAuthor).toBe(true)

    const wave = new MemoryVelocityPort()
    await wave.check(makeInput(-1, 10, SPAM))
    await wave.check(makeInput(-2, 11, SPAM))
    expect((await wave.check(makeInput(-3, 12, SPAM)))?.singleAuthor).toBe(false)
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
    await port.append(-1, 42, 101, 'пиши мені')
    await port.append(-1, 42, 102, 'в особисті')
    const window = await port.append(-1, 42, 103, 'заробіток')
    expect(window.count).toBe(3)
    expect(window.combinedText).toBe('пиши мені\nв особисті\nзаробіток')
  })

  it('sessions are isolated between users and chats', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 101, 'a')
    const other = await port.append(-1, 43, 102, 'b')
    expect(other.count).toBe(1)
  })

  it('expires after the window', async () => {
    let now = 0
    const port = new MemorySessionPort({ windowMs: 1000 }, () => now)
    await port.append(-1, 42, 101, 'a')
    now = 5000
    const fresh = await port.append(-1, 42, 102, 'b')
    expect(fresh.count).toBe(1)
  })

  it('reset clears the buffer', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 101, 'a')
    port.reset(-1, 42)
    const fresh = await port.append(-1, 42, 102, 'b')
    expect(fresh.count).toBe(1)
  })

  it('REGRESSION: an edit replaces its message instead of doubling it', async () => {
    // The same defect the persistent port carried, in the same shape: this
    // buffer was keyed by nothing, so a message that came back through the
    // pipeline as an edit was stored a second time. See `SessionPort.append`.
    const port = new MemorySessionPort()
    await port.append(-1, 42, 101, 'посаджені квіти викопують собі')
    const w = await port.append(-1, 42, 101, 'посаджені квіти викопують собі')
    expect(w.count).toBe(1)
  })

  it('the replaced message moves to the end, carrying its new text', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 101, 'привіт')
    await port.append(-1, 42, 102, 'друге')
    const w = await port.append(-1, 42, 101, 'заходь у мій канал')
    expect(w.combinedText).toBe('друге\nзаходь у мій канал')
  })

  it('two different messages with the same words are still two messages', async () => {
    const port = new MemorySessionPort()
    await port.append(-1, 42, 101, 'заробіток')
    const w = await port.append(-1, 42, 102, 'заробіток')
    expect(w.count).toBe(2)
  })
})
