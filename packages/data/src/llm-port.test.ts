import { describe, expect, it } from 'vitest'
import type {
  ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage, UserSnapshot
} from '@lyadmin/core'
import { buildSystemPrompt, buildUserContent } from './llm-port.js'

// ── fixtures ──────────────────────────────────────────────────────────

const makeMsg = (o: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -100, messageId: 1, threadId: null, date: 1_780_000_000,
  isEdit: false, text: 'звичайне повідомлення',
  urls: [], mentions: [], attachments: [], inlineButtons: [],
  forward: null, replyTo: null, channelComment: null, editDelta: null,
  customEmoji: [], guestBot: null, ...o
})

const makeUser = (o: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42, username: 'sender', displayName: 'Sender', languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800, localAgeDays: 400, messagesInChat: 3, messagesGlobal: 5,
  groupsActive: 1, spamDetections: 0, reputationScore: 60, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: null,
  nameChurn24h: 0, usernameChurn24h: 0, restrictionReasons: [], joinedAgoSeconds: null, ...o
})

const chat: NormalizedChat = { id: -100, kind: 'group', title: 'Чат', topLanguage: 'uk' }
const policy: ChatPolicy = {
  enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
  reactionModeration: false, externalBanEnabled: true, customRules: [], trustedUserIds: []
}
const enrich = (o: Partial<Enrichment> = {}): Enrichment => ({
  bio: null, personalChannelId: null, resolvedMentions: [], conversationWindow: [],
  photoBase64: null, avatarBase64: null, storyBase64: [], ...o
})
const makeInput = (o: { msg?: Partial<NormalizedMessage>; user?: Partial<UserSnapshot>; enrichment?: Partial<Enrichment> } = {}): EvaluationInput => ({
  message: makeMsg(o.msg), chat, user: makeUser(o.user), policy, enrichment: enrich(o.enrichment)
})

const asText = (c: ReturnType<typeof buildUserContent>): string =>
  typeof c === 'string' ? c : (c[0]?.text ?? '')

// ── tests ─────────────────────────────────────────────────────────────

describe('buildUserContent — author labels', () => {
  it('labels the sender [SENDER] and other members [user A]/[user B] stably', () => {
    const text = asText(buildUserContent(makeInput({
      user: { id: 42 },
      enrichment: {
        conversationWindow: [
          { authorId: 7, authorKind: 'user', textPreview: 'перше від іншого' },
          { authorId: 42, authorKind: 'user', textPreview: 'від сендера' },
          { authorId: 9, authorKind: 'user', textPreview: 'від третього' },
          { authorId: 7, authorKind: 'user', textPreview: 'знову перший' }
        ]
      }
    }), 'CANARY'))
    expect(text).toContain('[user A] перше від іншого')
    expect(text).toContain('[SENDER] від сендера')
    expect(text).toContain('[user B] від третього')
    // same author id → same label on re-appearance
    expect(text).toContain('[user A] знову перший')
  })
})

describe('buildUserContent — fence', () => {
  it('wraps the message text between canary fences', () => {
    const text = asText(buildUserContent(makeInput({ msg: { text: 'купи крипту' } }), 'ABC123'))
    expect(text).toContain('<<<ABC123\nкупи крипту\nABC123>>>')
  })

  it('renders (no text) inside the fence for empty messages', () => {
    const text = asText(buildUserContent(makeInput({ msg: { text: '' } }), 'ABC123'))
    expect(text).toContain('<<<ABC123\n(no text)\nABC123>>>')
  })
})

describe('buildUserContent — message facts', () => {
  it('exposes hidden link destinations', () => {
    const text = asText(buildUserContent(makeInput({
      msg: { urls: [{ visible: 'тиць сюди', target: 'http://evil.example', hidden: true }] }
    }), 'C'))
    expect(text).toContain('MESSAGE FACTS')
    expect(text).toContain('http://evil.example (hidden behind link text "тиць сюди")')
  })

  it('attributes a reply to the sender under review vs another member', () => {
    const text = asText(buildUserContent(makeInput({
      user: { id: 42 },
      msg: { replyTo: { authorId: 99, isSelf: false, ageSeconds: 120, textPreview: 'попереднє' } }
    }), 'C'))
    expect(text).toContain('reply to a message by [user A]')
  })

  it('flags edits with injected content', () => {
    const text = asText(buildUserContent(makeInput({
      msg: { isEdit: true, editDelta: { injectedUrls: 1, injectedMentions: 0, injectedInvisibles: 3 } }
    }), 'C'))
    expect(text).toContain('this is an EDIT')
    expect(text).toContain('1 url(s)')
    expect(text).toContain('3 invisible char(s)')
  })

  it('omits the MESSAGE FACTS section when there are no facts', () => {
    const text = asText(buildUserContent(makeInput(), 'C'))
    expect(text).not.toContain('MESSAGE FACTS')
  })
})

describe('buildSystemPrompt', () => {
  it('embeds the canary and explains the fence', () => {
    const sys = buildSystemPrompt('TOKEN42', null)
    expect(sys).toContain('TOKEN42')
    expect(sys).toContain('<<<TOKEN42')
    expect(sys).toContain('TOKEN42>>>')
  })

  it('frames the briefing as untrusted data', () => {
    const sys = buildSystemPrompt('T', 'sample spam campaign text')
    expect(sys).toContain('UNTRUSTED DATA')
    expect(sys).toContain('sample spam campaign text')
  })
})
