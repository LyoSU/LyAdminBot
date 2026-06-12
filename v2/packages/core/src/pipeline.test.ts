import { describe, expect, it } from 'vitest'
import type {
  ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage, UserSnapshot
} from './types.js'
import type { LlmTier, PipelinePorts } from './ports.js'
import { evaluateMessage } from './pipeline.js'

// ── fixtures ──────────────────────────────────────────────────────────

const makeMsg = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -100123, messageId: 1, threadId: null, date: 1_780_000_000,
  isEdit: false, text: 'Звичайне повідомлення в чаті, нічого особливого тут немає',
  urls: [], mentions: [], attachments: [], inlineButtons: [],
  forward: null, replyTo: null, channelComment: null, editDelta: null,
  customEmoji: [], guestBot: null,
  ...overrides
})

const makeUser = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42, username: 'someone', displayName: 'Someone', languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800, localAgeDays: 400,
  messagesInChat: 25, messagesGlobal: 120, groupsActive: 2,
  spamDetections: 0, reputationScore: 65, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: { count: 2, latestSetDaysAgo: 200 },
  nameChurn24h: 0, usernameChurn24h: 0,
  ...overrides
})

const chat: NormalizedChat = { id: -100123, kind: 'group', title: 'Test', topLanguage: 'uk' }

const makePolicy = (overrides: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
  reactionModeration: false, customRules: [], trustedUserIds: [],
  ...overrides
})

const emptyEnrichment: Enrichment = {
  bio: null, resolvedMentions: [], conversationWindow: [], photoBase64: null
}

const makeInput = (over: {
  msg?: Partial<NormalizedMessage>
  user?: Partial<UserSnapshot>
  policy?: Partial<ChatPolicy>
  enrichment?: Partial<Enrichment>
} = {}): EvaluationInput => ({
  message: makeMsg(over.msg),
  chat,
  user: makeUser(over.user),
  policy: makePolicy(over.policy),
  enrichment: { ...emptyEnrichment, ...over.enrichment }
})

const newcomer = { messagesInChat: 1, messagesGlobal: 2, localAgeDays: 0, predictedAgeDays: 10 }

// ── tests ─────────────────────────────────────────────────────────────

describe('evaluateMessage — gates', () => {
  it('disabled policy short-circuits to none', async () => {
    const v = await evaluateMessage(makeInput({ policy: { enabled: false } }), {})
    expect(v.action).toBe('none')
    expect(v.reasonCode).toBe('spam_check_disabled')
  })

  it('custom DENY rule fires with custom_rule attribution', async () => {
    const input = makeInput({
      msg: { text: 'Продам казино акаунти дешево' },
      user: newcomer,
      policy: { customRules: ['DENY: казино'] }
    })
    const v = await evaluateMessage(input, {})
    expect(v.decidedBy).toBe('custom_rule')
    expect(v.action).not.toBe('none')
  })

  it('custom ALLOW rule short-circuits to none even with promo content', async () => {
    const input = makeInput({
      msg: {
        text: 'Наш партнерський магазин https://shop.example',
        urls: [{ visible: 'https://shop.example', target: 'https://shop.example', hidden: false }]
      },
      policy: { customRules: ['ALLOW: shop.example'] }
    })
    const v = await evaluateMessage(input, {})
    expect(v.action).toBe('none')
    expect(v.decidedBy).toBe('custom_rule')
  })

  it('chat-level trusted user gets trust treatment', async () => {
    const input = makeInput({
      msg: { text: 'дивіться відео' },
      user: { id: 42 },
      policy: { trustedUserIds: [42] }
    })
    const v = await evaluateMessage(input, {})
    expect(v.action).toBe('none')
  })
})

describe('evaluateMessage — deterministic stage', () => {
  it('scam-flagged newcomer is decided without any ports', async () => {
    const input = makeInput({
      user: { ...newcomer, flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false } }
    })
    const v = await evaluateMessage(input, {})
    expect(v.decidedBy).toBe('deterministic')
    expect(v.ruleId).toBe('scam_flag_new')
    expect(v.action).toBe('ban')
  })

  it('deterministic clean skips all ports', async () => {
    let llmCalled = false
    const ports: PipelinePorts = {
      llm: { classify: async () => { llmCalled = true; return null } }
    }
    const input = makeInput({
      msg: {
        text: 'так, погоджуюсь',
        replyTo: { authorId: 9, isSelf: false, ageSeconds: 60, textPreview: 'а ти як думаєш?' }
      },
      user: { messagesGlobal: 500, reputationScore: 80 }
    })
    const v = await evaluateMessage(input, ports)
    expect(v.action).toBe('none')
    expect(v.decidedBy).toBe('deterministic')
    expect(llmCalled).toBe(false)
  })
})

describe('evaluateMessage — abstain & session', () => {
  it('bare mention from a newcomer → observe (the "@username bug" fix)', async () => {
    const input = makeInput({ msg: { text: '@someadmin' }, user: newcomer })
    const v = await evaluateMessage(input, {})
    expect(v.action).toBe('observe')
    expect(v.decidedBy).toBe('abstain')
  })

  it('session escalation: 5th low-info message evaluates the combined window', async () => {
    const calls: LlmTier[] = []
    const ports: PipelinePorts = {
      session: {
        append: async () => ({
          combinedText: 'пиши мені\nв особисті\nзаробіток\nвід 500$\nна день усім хто напише',
          count: 5
        })
      },
      llm: {
        classify: async (_input, tier) => {
          calls.push(tier)
          return { pSpam: 0.9, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    }
    const input = makeInput({ msg: { text: 'на день усім хто напише' }, user: newcomer })
    const v = await evaluateMessage(input, ports)
    expect(v.decidedBy).toBe('session')
    expect(v.action).toBe('mute')
    expect(calls).toEqual(['cheap'])
  })
})

describe('evaluateMessage — knowledge ports', () => {
  // Deliberately avoids deterministic-rule territory (no private invite,
  // no scam flag) so the knowledge ports actually get to decide.
  const spamText = {
    text: 'Потрібні люди на склад, оплата щодня, пишіть в особисті',
    urls: [{ visible: 'https://rabota.example', target: 'https://rabota.example', hidden: false }]
  }

  it('confirmed signature match decides immediately', async () => {
    const ports: PipelinePorts = {
      signatures: { match: async () => ({ status: 'confirmed', pSpam: 0.96, signatureId: 'sig1' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('signature')
    expect(v.ruleId).toBe('sig1')
    expect(['mute', 'ban']).toContain(v.action)
  })

  it('candidate signature only adds a signal, does not decide', async () => {
    const ports: PipelinePorts = {
      signatures: { match: async () => ({ status: 'candidate', pSpam: 0.96, signatureId: 'sig2' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'просто текст про щось довге і нейтральне' } }), ports)
    expect(v.decidedBy).not.toBe('signature')
    expect(v.signals.some((s) => s.name === 'signature_candidate_match')).toBe(true)
  })

  it('velocity exceeded decides delete+vote territory or stronger', async () => {
    const ports: PipelinePorts = {
      velocity: { check: async () => ({ exceeded: true, evidence: '6 copies in 4 chats' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('velocity')
    expect(['delete', 'mute', 'ban']).toContain(v.action)
  })

  it('confirmed vector match above threshold decides', async () => {
    const ports: PipelinePorts = {
      vectors: { search: async () => ({ similarity: 0.95, status: 'confirmed', vectorId: 'v1' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('vector')
  })

  it('weak vector similarity only contributes a signal', async () => {
    const ports: PipelinePorts = {
      vectors: { search: async () => ({ similarity: 0.85, status: 'confirmed', vectorId: 'v2' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'нейтральний текст про справи і життя' } }), ports)
    expect(v.decidedBy).not.toBe('vector')
    expect(v.signals.some((s) => s.name === 'vector_similar_spam')).toBe(true)
  })

  it('moderation flag is a signal, not a decision', async () => {
    const ports: PipelinePorts = {
      moderation: { check: async () => ({ flagged: true, categories: ['sexual'] }) }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'якийсь текст з натяками тут' } }), ports)
    expect(v.signals.some((s) => s.name === 'moderation_flagged')).toBe(true)
  })
})

describe('evaluateMessage — LLM escalation', () => {
  const greyZoneInput = (): EvaluationInput => makeInput({
    msg: {
      text: 'Хочеш заробляти на криптовалюті? Звертайся',
      urls: [{ visible: 'https://crypto.example', target: 'https://crypto.example', hidden: false }]
    },
    user: newcomer
  })

  it('grey-zone score escalates to the cheap LLM tier', async () => {
    const calls: LlmTier[] = []
    const ports: PipelinePorts = {
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.92, reasonCode: 'crypto_promo', evidence: 'заробляти на криптовалюті', cached: false }
        }
      }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(calls).toEqual(['cheap'])
    expect(v.decidedBy).toBe('llm')
    expect(v.reasonCode).toBe('crypto_promo')
    expect(['mute', 'ban']).toContain(v.action)
  })

  it('uncertain cheap verdict escalates to the strong tier', async () => {
    const calls: LlmTier[] = []
    const ports: PipelinePorts = {
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          if (tier === 'cheap') return { pSpam: 0.5, reasonCode: 'unsure', evidence: null, cached: false }
          return { pSpam: 0.1, reasonCode: 'legit_question', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(calls).toEqual(['cheap', 'strong'])
    expect(v.action).toBe('none')
  })

  it('LLM unavailable in grey zone → never clean (fail-safe: observe or delete+vote)', async () => {
    const ports: PipelinePorts = { llm: { classify: async () => null } }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(v.decidedBy).toBe('score')
    expect(['observe', 'captcha', 'delete']).toContain(v.action)
    if (v.action === 'delete') expect(v.needsVote).toBe(true)
  })

  it('cached LLM verdicts are attributed as llm_cached', async () => {
    const ports: PipelinePorts = {
      llm: { classify: async () => ({ pSpam: 0.95, reasonCode: 'job_scam', evidence: null, cached: true }) }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(v.decidedBy).toBe('llm_cached')
  })
})

describe('evaluateMessage — resilience', () => {
  it('a throwing port never breaks the pipeline', async () => {
    const ports: PipelinePorts = {
      signatures: { match: async () => { throw new Error('mongo down') } },
      vectors: { search: async () => { throw new Error('qdrant down') } },
      velocity: { check: async () => { throw new Error('redis down') } },
      moderation: { check: async () => { throw new Error('api down') } },
      llm: { classify: async () => { throw new Error('llm down') } }
    }
    const v = await evaluateMessage(makeInput({ user: newcomer }), ports)
    expect(v).toBeDefined()
    expect(Number(v.meta['portErrors'])).toBeGreaterThan(0)
  })

  it('verdict always carries calibrated pSpam in [0,1] and collected signals', async () => {
    const v = await evaluateMessage(makeInput(), {})
    expect(v.pSpam).toBeGreaterThanOrEqual(0)
    expect(v.pSpam).toBeLessThanOrEqual(1)
    expect(Array.isArray(v.signals)).toBe(true)
  })
})
