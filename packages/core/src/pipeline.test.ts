import { describe, expect, it } from 'vitest'
import type {
  ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage, UserSnapshot
} from './types.js'
import type { LlmTier, ModerationResult, PipelinePorts } from './ports.js'
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
  // Below the established-regular exempt thresholds (10 in-chat / 50 global) on
  // purpose: the default user must still run the full pipeline so port tests
  // exercise the ports. Established users are tested explicitly below.
  messagesInChat: 8, messagesGlobal: 40, groupsActive: 2,
  spamDetections: 0, reputationScore: 65, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: { count: 2, latestSetDaysAgo: 200 },
  nameChurn24h: 0, usernameChurn24h: 0, restrictionReasons: [], joinedAgoSeconds: null,
  ...overrides
})

const chat: NormalizedChat = { id: -100123, kind: 'group', title: 'Test', topLanguage: 'uk' }

const makePolicy = (overrides: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
  reactionModeration: false, externalBanEnabled: true, customRules: [], trustedUserIds: [],
  ...overrides
})

const emptyEnrichment: Enrichment = {
  bio: null, personalChannelId: null, resolvedMentions: [], conversationWindow: [],
  photoBase64: null, avatarBase64: null, storyBase64: []
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

/**
 * A moderation answer. `flagged` defaults to true whenever any score is
 * present, mirroring the provider: its aggregate flag is recall-tuned and
 * fires on categories we deliberately ignore for profile media.
 */
const modResult = (scores: Record<string, number>, flagged = true): ModerationResult => ({
  flagged,
  categories: Object.entries(scores).filter(([, v]) => v >= 0.5).map(([k]) => k),
  scores
})
const modClean: ModerationResult = { flagged: false, categories: [], scores: {} }

/**
 * Promo-shaped text that deliberately avoids deterministic-rule territory (no
 * private invite, no scam flag), so the stage under test is the one that
 * actually decides.
 */
const spamText = {
  text: 'Потрібні люди на склад, оплата щодня, пишіть в особисті',
  urls: [{ visible: 'https://rabota.example', target: 'https://rabota.example', hidden: false }]
}

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
      moderation: { check: async () => modResult({ sexual: 0.9 }) }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'якийсь текст з натяками тут' } }), ports)
    expect(v.signals.some((s) => s.name === 'moderation_flagged')).toBe(true)
  })

  it('weak vector similarity is noise and raises nothing', async () => {
    const ports: PipelinePorts = {
      vectors: { search: async () => ({ similarity: 0.4, status: 'candidate', vectorId: 'v3' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'нейтральний текст про справи і життя' } }), ports)
    expect(v.signals.some((s) => s.name === 'vector_similar_spam')).toBe(false)
  })
})

/**
 * Profile-media NSFW. The 2026-07-27 report: newcomers were permanently banned
 * on their first message because of an anime avatar. Two independent causes,
 * both covered here — the provider's recall-tuned `flagged` boolean spanning
 * violence/self-harm, and the signal being treated as decisive evidence about
 * a message nobody had read.
 */
describe('evaluateMessage — profile NSFW', () => {
  const avatarPort = (scores: Record<string, number>): PipelinePorts => ({
    moderation: {
      // Only the image input is judged; the message text itself is clean.
      check: async (text, image) => (!text && image ? modResult(scores) : modClean)
    }
  })
  const withAvatar = { user: newcomer, enrichment: { avatarBase64: 'ZmFrZQ==' } }

  it('a clearly pornographic avatar raises nsfw_avatar', async () => {
    const v = await evaluateMessage(makeInput(withAvatar), avatarPort({ sexual: 0.96 }))
    expect(v.signals.some((s) => s.name === 'nsfw_avatar')).toBe(true)
  })

  it('no avatar, no signal', async () => {
    const v = await evaluateMessage(makeInput({ user: newcomer }), avatarPort({ sexual: 0.96 }))
    expect(v.signals.some((s) => s.name === 'nsfw_avatar')).toBe(false)
  })

  it.each([
    ['anime with a weapon', { violence: 0.93, sexual: 0.11 }],
    ['stylised gore', { 'violence/graphic': 0.88, sexual: 0.04 }],
    ['a bleak drawing', { 'self-harm': 0.79, sexual: 0.02 }],
    ['merely suggestive art', { sexual: 0.55 }],
    ['just under the bar', { sexual: 0.79 }]
  ])('%s is flagged by the provider but is NOT nsfw_avatar', async (_label, scores) => {
    const ports = avatarPort(scores)
    const v = await evaluateMessage(makeInput(withAvatar), ports)
    expect(v.signals.some((s) => s.name === 'nsfw_avatar')).toBe(false)
  })

  it('REGRESSION: an anime avatar never gets a first-time poster banned', async () => {
    // The exact production shape: joined moments ago, young account, avatar
    // the provider flags on violence. Previously scored 0.97 → permanent ban.
    const v = await evaluateMessage(makeInput({
      user: { ...newcomer, joinedAgoSeconds: 30, predictedAgeDays: 4 },
      enrichment: { avatarBase64: 'ZmFrZQ==' }
    }), avatarPort({ violence: 0.95, sexual: 0.08 }))

    expect(v.action).not.toBe('ban')
    expect(v.action).not.toBe('mute')
    expect(v.action).not.toBe('kick')
  })

  it('REGRESSION: even a real porn avatar cannot enforce without reading the text', async () => {
    // nsfw_avatar is soft-shape: it describes the sender, not the message. With
    // no LLM available the verdict must fall back to observe, never enforcement.
    const v = await evaluateMessage(makeInput({
      user: { ...newcomer, joinedAgoSeconds: 30, predictedAgeDays: 4 },
      enrichment: { avatarBase64: 'ZmFrZQ==' }
    }), avatarPort({ sexual: 0.99 }))

    expect(v.signals.some((s) => s.name === 'nsfw_avatar')).toBe(true)
    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('soft_shape_only')
  })

  it('a porn avatar DOES escalate to the LLM, which may then convict on the text', async () => {
    const calls: LlmTier[] = []
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Приват, інтим послуги, пиши в лічку' },
      user: { ...newcomer, joinedAgoSeconds: 30 },
      enrichment: { avatarBase64: 'ZmFrZQ==' }
    }), {
      ...avatarPort({ sexual: 0.99 }),
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.97, reasonCode: 'escort_promo', evidence: null, cached: false }
        }
      }
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(v.decidedBy).toBe('llm')
    expect(['kick', 'mute', 'ban']).toContain(v.action)
  })

  it('any pornographic story raises nsfw_stories exactly once', async () => {
    const ports: PipelinePorts = {
      moderation: {
        check: async (_text, image) =>
          image === 'bad' ? modResult({ sexual: 0.95 }) : modClean
      }
    }
    const v = await evaluateMessage(
      makeInput({ user: newcomer, enrichment: { storyBase64: ['ok', 'bad', 'ok'] } }), ports)
    const stories = v.signals.filter((s) => s.name === 'nsfw_stories')
    expect(stories).toHaveLength(1)
    expect(stories[0]?.evidence).toContain('sexual')
  })

  it('violent stories are not NSFW stories', async () => {
    const ports: PipelinePorts = {
      moderation: { check: async () => modResult({ violence: 0.97 }) }
    }
    const v = await evaluateMessage(
      makeInput({ user: newcomer, enrichment: { storyBase64: ['a', 'b'] } }), ports)
    expect(v.signals.some((s) => s.name === 'nsfw_stories')).toBe(false)
  })

  it('a provider that returns no scores at all never raises a profile signal', async () => {
    // Defensive: an adapter that forgets to pass scores through must fail
    // closed (no signal), not fall back to the aggregate `flagged` boolean.
    const ports: PipelinePorts = {
      moderation: { check: async () => ({ flagged: true, categories: ['sexual'], scores: {} }) }
    }
    const v = await evaluateMessage(makeInput(withAvatar), ports)
    expect(v.signals.some((s) => s.name === 'nsfw_avatar')).toBe(false)
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

describe('evaluateMessage — forward reputation', () => {
  const spamForward = {
    msg: {
      text: 'Заробіток без вкладень, пиши в особисті прямо зараз!',
      forward: { kind: 'channel' as const, title: 'Промо', sourceId: -100555 }
    },
    user: newcomer
  }

  it('a blacklisted forward source decides', async () => {
    const v = await evaluateMessage(makeInput(spamForward), {
      forwards: { check: async () => 'blacklisted' }
    })
    expect(v.decidedBy).toBe('forward')
    expect(v.reasonCode).toBe('forward_blacklist')
    expect(v.pSpam).toBeGreaterThanOrEqual(0.9)
  })

  it('a suspicious source only contributes a signal', async () => {
    const v = await evaluateMessage(makeInput(spamForward), {
      forwards: { check: async () => 'suspicious' }
    })
    expect(v.decidedBy).not.toBe('forward')
    expect(v.signals.map((s) => s.name)).toContain('forward_source_suspicious')
  })

  it('the port is not consulted for non-forwarded messages', async () => {
    let called = false
    await evaluateMessage(makeInput({ user: newcomer }), {
      forwards: { check: async () => { called = true; return 'blacklisted' } }
    })
    expect(called).toBe(false)
  })
})

describe('evaluateMessage — soft-shape-only guard (2026-06-21 FP)', () => {
  // Faithful reproduction of the production false positive: a benign question
  // deleted on sleeper_awakened + new_globally + promo_in_bio + personal_channel
  // — four signals about WHO sent the message, none about WHAT was sent. The
  // stacked score (0.82) sat above the old LLM ceiling (0.75), so the only
  // content-reading stage was skipped and the score deleted blind.
  const softShapeOver = {
    msg: { text: 'Чи я не правий і таке можна зробити? Бо я не розбирався в цьому ще' },
    // messagesInChat kept below the exempt bar (10) so the soft-shape guard —
    // not the established-regular fast path — is what's under test here.
    user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 8 },
    enrichment: { bio: 'Мій сайт: example.com', personalChannelId: 7777 }
  }

  it('the four prod signals alone score above 0.75 (regression anchor)', async () => {
    const v = await evaluateMessage(makeInput(softShapeOver), {})
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['sleeper_awakened', 'new_globally', 'promo_in_bio', 'personal_channel']))
    expect(v.pSpam).toBeGreaterThan(0.75)
  })

  it('escalates to the LLM even above the grey ceiling, and the LLM clears it', async () => {
    const calls: LlmTier[] = []
    const ports: PipelinePorts = {
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.05, reasonCode: 'legit_question', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(makeInput(softShapeOver), ports)
    expect(calls).toEqual(['cheap'])
    expect(v.decidedBy).toBe('llm')
    expect(v.action).toBe('none')
  })

  it('without an LLM, soft-shape-only never enforces — observe, not delete', async () => {
    const v = await evaluateMessage(makeInput(softShapeOver), {})
    expect(v.action).toBe('observe')
    expect(v.decidedBy).toBe('score')
  })

  it('content evidence alongside soft shape still enforces on score (guard is narrow)', async () => {
    const v = await evaluateMessage(makeInput({
      ...softShapeOver,
      msg: {
        text: 'подивись обовʼязково тут',
        urls: [{ visible: 'https://promo.example', target: 'https://promo.example', hidden: false }]
      }
    }), {})
    expect(['delete', 'mute', 'ban']).toContain(v.action)
  })
})

describe('evaluateMessage — enforcement ladder end to end', () => {
  const scamNewcomer = {
    user: {
      ...newcomer,
      flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false }
    }
  }

  it('a Telegram scam flag is grounds for a PERMANENT ban', async () => {
    const v = await evaluateMessage(makeInput(scamNewcomer), {})
    expect(v.action).toBe('ban')
    expect(v.banDurationSeconds).toBeNull()
  })

  it('an externally-banned newcomer is also permanent', async () => {
    const v = await evaluateMessage(makeInput({
      user: { ...newcomer, externalBan: { banned: true, bannedAt: null, offenses: 3 } }
    }), {})
    expect(v.action).toBe('ban')
    expect(v.banDurationSeconds).toBeNull()
  })

  it('a ban resting only on OUR score is timed, so a mistake expires', async () => {
    // Velocity is our own judgement, not a third party's verdict.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, evidence: '12 identical messages' }) }
    })
    expect(v.decidedBy).toBe('velocity')
    if (v.action === 'ban') expect(v.banDurationSeconds).toBeGreaterThan(0)
  })

  it('property: only a ban verdict ever carries a duration', async () => {
    const cases: Parameters<typeof makeInput>[0][] = [
      {}, { user: newcomer }, scamNewcomer, { msg: spamText, user: newcomer },
      { user: { messagesInChat: 200, messagesGlobal: 5000 } }
    ]
    for (const input of cases) {
      const v = await evaluateMessage(makeInput(input), {})
      if (v.action !== 'ban') expect(v.banDurationSeconds, v.action).toBeNull()
    }
  })

  it('kick is reachable for a newcomer whose score lands between delete and mute', async () => {
    // Driven through the LLM so the score is pinned exactly, independent of
    // future weight tuning.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      llm: { classify: async () => ({ pSpam: 0.8, reasonCode: 'promo', evidence: null, cached: false }) }
    })
    expect(v.action).toBe('kick')
  })

  it('the same score only deletes for someone with local standing', async () => {
    // Same 0.8 verdict, but the sender has been around: kick and ban are off
    // the table, so the ladder stops at delete.
    const v = await evaluateMessage(
      makeInput({
        msg: spamText,
        user: { messagesInChat: 9, messagesGlobal: 49, localAgeDays: 300 },
        enrichment: { bio: 'Пиши https://promo.example' }
      }), {
        llm: { classify: async () => ({ pSpam: 0.8, reasonCode: 'promo', evidence: null, cached: false }) }
      })
    expect(v.decidedBy).toBe('llm')
    expect(v.action).toBe('delete')
  })
})

describe('evaluateMessage — established-regular exempt', () => {
  // A message that any newcomer would lose to a confirmed signature match.
  const wouldMatch = {
    text: 'Потрібні люди на склад, оплата щодня, пишіть в особисті',
    urls: [{ visible: 'https://rabota.example', target: 'https://rabota.example', hidden: false }]
  }
  const confirmedSignature: PipelinePorts = {
    signatures: { match: async () => ({ status: 'confirmed', pSpam: 0.96, signatureId: 'sig1' }) }
  }

  it('a regular in THIS chat (≥10 in-chat) is exempt without touching any port', async () => {
    let sigCalled = false
    const ports: PipelinePorts = {
      signatures: { match: async () => { sigCalled = true; return { status: 'confirmed', pSpam: 0.96, signatureId: 'sig1' } } }
    }
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 10, messagesGlobal: 12 } }), ports)
    expect(v.action).toBe('none')
    expect(v.decidedBy).toBe('deterministic')
    expect(v.reasonCode).toBe('established_regular')
    expect(v.meta['established_regular']).toBe(true)
    expect(sigCalled).toBe(false)
  })

  it('the @syumer case: established globally (≥50) but new in THIS chat is still exempt', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 1, messagesGlobal: 826, reputationStatus: 'trusted' } }),
      confirmedSignature)
    expect(v.action).toBe('none')
    expect(v.reasonCode).toBe('established_regular')
  })

  it('below both thresholds runs the full pipeline (signature decides)', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 9, messagesGlobal: 49 } }),
      confirmedSignature)
    expect(v.decidedBy).toBe('signature')
  })

  it('a hard account verdict cancels the exempt — the pipeline still decides', async () => {
    const guards: Partial<UserSnapshot>[] = [
      { externalBan: { banned: true, bannedAt: null, offenses: 2 } },
      { flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false } },
      { spamDetections: 2 },
      { reputationStatus: 'suspicious' },
      { restrictionReasons: ['spam'] }
    ]
    for (const guard of guards) {
      const v = await evaluateMessage(
        makeInput({ msg: wouldMatch, user: { messagesInChat: 50, messagesGlobal: 900, ...guard } }),
        confirmedSignature)
      expect(v.decidedBy).toBe('signature')
      expect(v.reasonCode).not.toBe('established_regular')
    }
  })

  it('ONE past detection does not cancel the exempt — false positives must not compound', async () => {
    // A single prior detection may itself have been a mistake. Letting it strip
    // a 900-message regular of the exempt made every FP feed the next one.
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 50, messagesGlobal: 900, spamDetections: 1 } }),
      confirmedSignature)
    expect(v.reasonCode).toBe('established_regular')
  })

  it('an external ban does NOT cancel exempt when the chat disabled external bans', async () => {
    const v = await evaluateMessage(
      makeInput({
        msg: wouldMatch,
        user: { messagesInChat: 50, externalBan: { banned: true, bannedAt: null, offenses: 2 } },
        policy: { externalBanEnabled: false }
      }),
      confirmedSignature)
    expect(v.reasonCode).toBe('established_regular')
  })

  it('an admin custom DENY still wins over the exempt', async () => {
    const v = await evaluateMessage(
      makeInput({
        msg: { text: 'Продам казино акаунти дешево' },
        user: { messagesInChat: 200, messagesGlobal: 5000 },
        policy: { customRules: ['DENY: казино'] }
      }), {})
    expect(v.decidedBy).toBe('custom_rule')
    expect(v.action).not.toBe('none')
  })
})
