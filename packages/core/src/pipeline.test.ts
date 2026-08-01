import { describe, expect, it } from 'vitest'
import type {
  ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage, UserSnapshot
} from './types.js'
import type { LlmTier, ModerationResult, PipelinePorts, SessionPort } from './ports.js'
import { evaluateMessage } from './pipeline.js'
import { isEnforcementAction, removesSender } from './policy.js'
import { contentEvidence } from './score.js'

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

const chat: NormalizedChat = { id: -100123, kind: 'group', title: 'Test', topLanguage: 'uk', description: null }

const makePolicy = (overrides: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
  reactionModeration: false, externalBanEnabled: true, customRules: [], trustedUserIds: [],
  ...overrides
})

const emptyEnrichment: Enrichment = {
  bio: null,
  businessTexts: [],
  linkedChannels: [], personalChannelId: null, resolvedMentions: [], conversationWindow: [],
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
        }),
        reset: async () => { /* noop */ }
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
    // The cheap tier may not exile someone on a concatenated blob — removing the
    // sender requires the strong model to agree (see the test below).
    expect(calls).toEqual(['cheap', 'strong'])
  })

  it('REGRESSION: a short message nothing found anything in still gets read eventually', async () => {
    // Production, 2026-08-01 15:26, reported by an admin: a five-word
    // solicitation from a newcomer was never judged by anything. It carried no
    // link, no phone, no mention and no media, so no stage had anything to say
    // about it — and the score, which is what decides whether the LLM is worth
    // asking, therefore sat at 0.27, below the grey floor. `short_message`
    // (-0.8) is most of that gap: being brief was read as reassuring.
    //
    // It fell between the two safety nets. Under 20 informative characters the
    // abstain gate would have buffered it for the session window; over the grey
    // floor the LLM would have read it. At 26 characters and 0.27 it was
    // classifiable by the gate's own reckoning and classified by nobody.
    //
    // A low score with no findings behind it is an absence of evidence, not
    // evidence of absence — the same reasoning that sends an unfamiliar script
    // to the LLM. It goes to the session buffer, which costs one call per five
    // messages instead of one per message.
    const appended: string[] = []
    let classified = 0
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, t) => {
          appended.push(t)
          return { combinedText: appended.join('\n'), count: appended.length }
        },
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => {
          classified += 1
          return { pSpam: 0.98, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    }
    // Past their first message (that one is judged on the spot — see the test
    // below) but nowhere near established: still newish, still unreadable.
    const solicitation = {
      msg: { text: 'Потрібні ГРОШІ ??? Пиши допоможу !!' },
      user: { messagesInChat: 4, messagesGlobal: 6, localAgeDays: 2, predictedAgeDays: 10 }
    }

    // Nothing is found, so nothing is done — but the message is remembered.
    const first = await evaluateMessage(makeInput(solicitation), ports)
    expect(classified).toBe(0)
    expect(isEnforcementAction(first.action)).toBe(false)
    expect(appended).toHaveLength(1)

    let last = first
    for (let i = 0; i < 4; i += 1) last = await evaluateMessage(makeInput(solicitation), ports)
    expect(classified).toBeGreaterThan(0)
    expect(last.decidedBy).toBe('session')
    expect(last.pSpam).toBe(0.98)
  })

  it('REGRESSION: the drive-by never sends a second message, so one is the pile', async () => {
    // The buffer waits for five before it is worth a classification, which is
    // right for somebody chatting in one-liners and useless against the shape
    // the 2026-08-01 15:26 report actually had: join, post once, gone. Waiting
    // for a fifth message from an account that will never send a second one is
    // waiting forever.
    //
    // A first message in a chat is both the likeliest to be a drive-by and the
    // cheapest moment to check — the population is bounded by the join rate.
    // The abstain gate keeps the five: a bare "@someone" as a first message is
    // exactly the noise that gate exists to stop asking about.
    let calls = 0
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, t) => ({ combinedText: t, count: 1 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.97, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    }
    const firstEver = { messagesInChat: 1, messagesGlobal: 2, localAgeDays: 0, predictedAgeDays: 5 }
    const v = await evaluateMessage(
      makeInput({ msg: { text: 'Потрібні ГРОШІ ??? Пиши допоможу !!' }, user: firstEver }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.pSpam).toBe(0.97)
    expect(isEnforcementAction(v.action)).toBe(true)

    // The abstain gate is untouched: a bare mention still waits for the pile.
    calls = 0
    const bare = await evaluateMessage(
      makeInput({ msg: { text: '@someadmin' }, user: firstEver }), ports)
    expect(calls).toBe(0)
    expect(bare.decidedBy).toBe('abstain')
  })

  it('REGRESSION: a lurker replying to a complaint is still somebody nothing has read', async () => {
    // The reply-bait class: sit in a chat for weeks, wait for somebody to say
    // something is broken, answer with a product name in plain text — no @, no
    // link, no phone. There is nothing for any stage to recognise, and the
    // message arrives as a reply, which is worth -1.8 in trust (`is_reply` plus
    // `recent_reply`). That discount is not incidental to the tactic, it IS the
    // tactic: the accusing signals on such an account come to about +1.8, so
    // replying cancels them exactly and the score lands near 0.10 against a
    // reading floor of 0.35.
    //
    // Newness was the wrong condition to gate the buffer on. Anyone reaching
    // this far already failed the established-regular fast path, which is the
    // pipeline's own definition of standing; a sender under it who says
    // something nothing recognises is exactly who the buffer is for, whether
    // they arrived today or lurked for three weeks.
    let judged = 0
    const buffer: string[] = []
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, t) => {
          buffer.push(t)
          return { combinedText: buffer.join('\n'), count: buffer.length }
        },
        reset: async () => { buffer.length = 0 }
      },
      llm: {
        classify: async () => {
          judged += 1
          return { pSpam: 0.95, reasonCode: 'other_spam', evidence: null, cached: false }
        }
      }
    }
    const lurker = {
      msg: {
        text: 'У мене теж таке було, допомогло. Спробуй той віпіен, просто набери назву в пошуку.',
        replyTo: { authorId: 55, isSelf: false, ageSeconds: 60, textPreview: 'у мене нічого не вантажить' }
      },
      // Three weeks in the chat and nine messages: past every newness test,
      // still short of the established-regular bar (10 in chat / 50 global).
      user: { predictedAgeDays: 900, localAgeDays: 21, messagesInChat: 9, messagesGlobal: 30 }
    }

    let last = await evaluateMessage(makeInput(lurker), ports)
    expect(buffer).toHaveLength(1)
    for (let i = 0; i < 4; i += 1) last = await evaluateMessage(makeInput(lurker), ports)
    expect(judged).toBeGreaterThan(0)
    expect(last.decidedBy).toBe('session')
  })

  it('REGRESSION: the exempt is cancelled by a message that would remove anyone', async () => {
    // The established-regular fast path returned at step 1b, before signals were
    // extracted at step 2 — so message evidence could not cancel it, whatever it
    // was. And the account-level guard that CAN cancel it needs two prior spam
    // detections, which cannot accumulate while the account is exempt. A closed
    // loop: a sold or compromised long-time account had a permanent full bypass
    // in every chat.
    //
    // The bar is the one already in use for removing a person. The exempt exists
    // so a regular's link is not deleted on a signature or vector MATCH; it was
    // never meant to wave through evidence that would license removing anybody.
    const evasive = {
      msg: {
        text: 'подивись тут',
        urls: [{ visible: 'ok.com', target: 'https://evil.example/x', hidden: true }],
        inlineButtons: [
          { text: 'a', url: 'https://a.example' },
          { text: 'b', url: 'https://b.example' },
          { text: 'c', url: 'https://c.example' }
        ]
      },
      user: { messagesInChat: 400, messagesGlobal: 900, localAgeDays: 900 }
    }
    const v = await evaluateMessage(makeInput(evasive), {})
    expect(v.reasonCode).not.toBe('established_regular')
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(['many_url_buttons']))

    // An ordinary message from the same regular still skips the whole ladder.
    const ordinary = await evaluateMessage(makeInput({
      msg: { text: 'та отож, я теж так думаю' },
      user: evasive.user
    }), {})
    expect(ordinary.reasonCode).toBe('established_regular')
  })

  it('REGRESSION: a removal nothing corroborates gets the strong model first', async () => {
    // The cheap model was escalated only inside the grey zone — so the verdicts
    // that REMOVE somebody, which by definition sit above it, were the ones the
    // strong model never saw. Meanwhile the session path has done exactly this
    // since 2026-07-30, for the same reason, twenty lines away.
    //
    // The trigger is a removal with nothing corroborating it: `contentEvidence`
    // at zero means every other stage looked at the text and found nothing, so
    // the cheap model's word is the entire case for taking the chat away from
    // somebody.
    const calls: LlmTier[] = []
    const ports = (pSpam: number): PipelinePorts => ({
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    })
    // Long enough not to earn the brevity discount, so the score reaches the
    // grey zone on its own and the cheap model is consulted the ordinary way.
    const bare = {
      msg: { text: 'Гарного дня всім, підкажіть будь ласка, як тут заведено ставити запитання?' },
      user: newcomer
    }

    const removed = await evaluateMessage(makeInput(bare), ports(0.97))
    expect(calls).toEqual(['cheap', 'strong'])
    expect(removesSender(removed.action)).toBe(true)

    // Corroborated, so the cheap tier carries it alone: the phone number is a
    // second stage saying something about the same message, which is exactly
    // what the escalation exists to substitute for when it is missing.
    calls.length = 0
    const corroborated = await evaluateMessage(makeInput({
      msg: { text: 'Робота вдома, гарний дохід щотижня, телефонуйте +380671234567' },
      user: newcomer
    }), ports(0.97))
    expect(calls).toEqual(['cheap'])
    expect(removesSender(corroborated.action)).toBe(true)
  })

  it('the first few messages in a chat are each worth reading on their own', async () => {
    // A pile of five is useless against join-post-once-gone, and the window is
    // thirty minutes of one process — a lurker dropping one line an hour never
    // fills it. The risk is concentrated in the opening messages, and that
    // population is bounded, so those are read one at a time. Three is the same
    // bar `isNewish` already uses for "no standing here yet".
    let judged = 0
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, t) => ({ combinedText: t, count: 1 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => {
          judged += 1
          return { pSpam: 0.2, reasonCode: 'small_talk', evidence: null, cached: false }
        }
      }
    }
    const quiet = { msg: { text: 'Спробуй той сервіс, просто набери назву в пошуку' } }

    for (const messagesInChat of [1, 2, 3]) {
      judged = 0
      await evaluateMessage(makeInput({
        ...quiet, user: { messagesInChat, messagesGlobal: messagesInChat + 1, localAgeDays: 0 }
      }), ports)
      expect(judged, `message ${messagesInChat}`).toBe(1)
    }

    // Past the opening, the pile is five again.
    judged = 0
    await evaluateMessage(makeInput({
      ...quiet, user: { messagesInChat: 4, messagesGlobal: 9, localAgeDays: 2 }
    }), ports)
    expect(judged).toBe(0)
  })

  it('REGRESSION: a message with no text puts nothing in the buffer', async () => {
    // Photos, stickers and voice notes carry no text. Buffering them appended
    // empty strings, and five of those filled the window — so the pipeline
    // asked the model to classify "\n\n\n\n" and enforced on the answer. That
    // is verdict roulette on nothing, the exact failure the abstain gate exists
    // to prevent, reintroduced one level down (2026-08-01, same day as the
    // buffer itself).
    const buffer: string[] = []
    let judged: string | null = null
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, t) => {
          buffer.push(t)
          return { combinedText: buffer.join('\n'), count: buffer.length }
        },
        reset: async () => { buffer.length = 0 }
      },
      llm: {
        classify: async (i) => {
          judged = i.message.text
          return { pSpam: 0.9, reasonCode: 'other_spam', evidence: null, cached: false }
        }
      }
    }
    const photo = {
      msg: { text: '', attachments: [{ kind: 'photo' as const, fileUniqueId: 'x' }] },
      user: { predictedAgeDays: 900, localAgeDays: 30, messagesInChat: 5, messagesGlobal: 20 }
    }

    let last = await evaluateMessage(makeInput(photo), ports)
    for (let i = 0; i < 5; i += 1) last = await evaluateMessage(makeInput(photo), ports)
    expect(buffer).toEqual([])
    expect(judged).toBeNull()
    expect(isEnforcementAction(last.action)).toBe(false)
  })

  it('standing decides who is buffered, and talking is how it is earned', async () => {
    // Who the buffer is for is the same question as who the exempt is for, so
    // it gets the same answer rather than a second one. An established regular
    // never arrives: the fast path returns before any port runs.
    //
    // Tenure alone is not standing. Somebody a year in the chat who has said
    // eight things has not earned the exempt, and is buffered like anybody else
    // — which is right for the threat this covers, since an aged, quiet account
    // is precisely the sleeper shape. It is also self-limiting: reading costs a
    // classification and never punishes, and once they have said enough to
    // graduate they stop being buffered at all.
    const countingSession = (): { port: SessionPort; count: () => number } => {
      let appended = 0
      return {
        count: () => appended,
        port: {
          append: async () => { appended += 1; return { combinedText: '', count: 1 } },
          reset: async () => { /* noop */ }
        }
      }
    }
    const chat = { text: 'та ну, не може бути такого' }

    const regular = countingSession()
    const asRegular = await evaluateMessage(
      makeInput({ msg: chat, user: { messagesInChat: 40, messagesGlobal: 200, localAgeDays: 400 } }),
      { session: regular.port })
    expect(asRegular.reasonCode).toBe('established_regular')
    expect(regular.count()).toBe(0)

    const quiet = countingSession()
    const asQuiet = await evaluateMessage(
      makeInput({ msg: chat, user: { messagesInChat: 8, messagesGlobal: 40, localAgeDays: 400 } }),
      { session: quiet.port })
    expect(asQuiet.action).toBe('none')
    expect(quiet.count()).toBe(1)
  })

  it('a judged window is spent, so the same blob is never re-rolled', async () => {
    // Production, 2026-07-30: a two-word conversational message was banned at
    // 0.98 with `decidedBy: session`, `flood`.
    //
    // Root cause: the window holds up to 10 messages and was re-classified on
    // EVERY subsequent low-information message — and since it saturates at 10,
    // that is an unbounded series of cheap-model rolls over largely the same
    // text. Any single bad roll enforces. The abstain gate exists to stop
    // verdict roulette on unclassifiable messages; this path reintroduced it
    // one level up. A batch that has been judged must not be judged again.
    const resets: [number, number][] = []
    let classified = 0
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nлол\n+\nну таке', count: 5 }),
        reset: async (chatId, userId) => { resets.push([chatId, userId]) }
      },
      llm: {
        classify: async () => {
          classified += 1
          return { pSpam: 0.1, reasonCode: 'clean', evidence: null, cached: false }
        }
      }
    }
    const input = makeInput({ msg: { text: 'ну таке' }, user: newcomer })
    const v = await evaluateMessage(input, ports)
    expect(classified).toBe(1)
    expect(v.decidedBy).toBe('session')
    expect(resets).toEqual([[input.message.chatId, input.user.id]])
  })

  it('an unanswered window is NOT spent — evidence survives an LLM outage', async () => {
    const resets: [number, number][] = []
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'пиши в лс\nє тема\nзаробіток\n+\nдам знати', count: 5 }),
        reset: async (chatId, userId) => { resets.push([chatId, userId]) }
      },
      llm: { classify: async () => { throw new Error('502') } }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'дам знати' }, user: newcomer }), ports)
    expect(v.decidedBy).toBe('abstain')
    expect(v.action).toBe('observe')
    expect(resets).toEqual([])
  })

  it('the cheap tier alone may not remove the sender on a blob', async () => {
    // Same rule as the score path: the weakest input in the pipeline (lines
    // with no individual meaning, concatenated) must not carry the strongest
    // authority. If the strong model disagrees, its answer stands.
    const calls: LlmTier[] = []
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async (_input, tier) => {
          calls.push(tier)
          return tier === 'cheap'
            ? { pSpam: 0.98, reasonCode: 'flood', evidence: null, cached: false }
            : { pSpam: 0.2, reasonCode: 'clean', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'ну от' }, user: newcomer }), ports)
    expect(calls).toEqual(['cheap', 'strong'])
    expect(v.pSpam).toBe(0.2)
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  it('records the judged window, so a session verdict is reviewable from a log line', async () => {
    // The log prints the triggering message; the verdict was about the blob.
    // Without this, a session FP cannot be reviewed at all — the 19:15 ban is
    // undiagnosable from prod logs for exactly this reason.
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.9, reasonCode: 'flood', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'ну от' }, user: newcomer }), ports)
    expect(v.meta['judgedText']).toBe('ок\nда\nугу\n+\nну от')
    expect(v.meta['judgedCount']).toBe(5)
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

  /**
   * Production, 2026-08-01. The same job ad was classified by the LLM at 05:37
   * (`job_scam`, 0.99) and auto-learn wrote a candidate signature for it. At
   * 06:21 that candidate, plus a candidate vector, was the whole case: the LLM
   * was never called, and the pipeline acted on an unread message.
   *
   * The stage that produced the original verdict must not be silenced by an
   * unconfirmed echo of it — least of all when the echo is quantised to 2.2
   * units and the original said 0.99. Repeats are cheap to re-ask: the port
   * caches by text, so the second sighting is served from the first answer.
   */
  it('unconfirmed matches never close the LLM gate on their own', async () => {
    let asked = 0
    const ports: PipelinePorts = {
      signatures: { match: async () => ({ status: 'candidate', pSpam: 0.99, signatureId: 'sig3' }) },
      vectors: { search: async () => ({ similarity: 0.9, status: 'candidate', vectorId: 'v3' }) },
      llm: {
        classify: async () => {
          asked += 1
          return { pSpam: 0.99, reasonCode: 'job_scam', evidence: null, cached: true }
        }
      }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(asked).toBe(1)
    expect(v.decidedBy).toBe('llm_cached')
    expect(v.pSpam).toBe(0.99)
  })

  it('with no LLM to ask, an echo alone may not enforce', async () => {
    // The candidate signature is the only match, and there is no LLM. Acting
    // would mean removing a message on the strength of a guess nobody
    // confirmed and nobody re-read.
    const ports: PipelinePorts = {
      signatures: { match: async () => ({ status: 'candidate', pSpam: 0.99, signatureId: 'sig3' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.pSpam).toBeGreaterThan(0.75)
    expect(isEnforcementAction(v.action)).toBe(false)
    expect(v.reasonCode).toBe('soft_shape_only')
  })

  it('velocity exceeded decides delete+vote territory or stronger', async () => {
    const ports: PipelinePorts = {
      velocity: { check: async () => ({ exceeded: true, evidence: '6 copies in 4 chats' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('velocity')
    expect(['delete', 'mute', 'ban']).toContain(v.action)
  })

  it('one account blasting scores higher; several accounts get a vote', async () => {
    // A blast has no innocent explanation. The same line from several accounts
    // is either a multi-account campaign or something that went viral, and the
    // pipeline must not silently mute the third person to repeat a news line
    // (2026-07-30 review — `userIds` was computed and then ignored).
    //
    // The blast still does not silently remove anybody. That expectation was
    // written on 2026-07-30 against a window of ten minutes, and it was never
    // once exercised in production: the Mongo port — the only one the bot runs
    // — never reported `singleAuthor` at all, so every velocity hit for a year
    // took the wave branch. Switching the branch on came with a window widened
    // to six hours to match the cadence spam actually arrives at, and over six
    // hours "no innocent explanation" stops being true. So the score is the
    // high one, the message goes, the sender is asked for a captcha a bot
    // cannot pass — and the removal itself waits for evidence that reads the
    // text, exactly as every other stage's does.
    const blast = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    })
    expect(blast.pSpam).toBeGreaterThan(0.88)
    expect(blast.action).toBe('delete')
    expect(blast.requireCaptcha).toBe(true)

    const wave = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: false }) }
    })
    expect(wave.action).toBe('delete')
    expect(wave.needsVote).toBe(true)
  })

  it('a port that cannot tell is read as a wave, never as a blast', async () => {
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true }) }
    })
    expect(v.needsVote).toBe(true)
  })

  it('confirmed vector match above threshold decides', async () => {
    const ports: PipelinePorts = {
      vectors: { search: async () => ({ similarity: 0.95, status: 'confirmed', vectorId: 'v1' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('vector')
  })

  it('a resemblance takes the message, never the person', async () => {
    // This branch was the last one still crossing the sender-removal line
    // without answering to it. `vector_similar_spam` is marked a `resemblance`
    // exactly because a nearest neighbour says the text LOOKS LIKE something,
    // not that the sender did something — yet at 0.92 this path muted for
    // twenty-four hours on that same fact. The pipeline held two positions on
    // one piece of evidence, and which applied depended only on whether the
    // similarity happened to clear 0.93.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      vectors: { search: async () => ({ similarity: 0.97, status: 'confirmed', vectorId: 'v1' }) }
    })
    expect(v.decidedBy).toBe('vector')
    expect(v.action).toBe('delete')
    expect(removesSender(v.action)).toBe(false)
    expect(v.signals.some((s) => s.name === 'vector_similar_spam')).toBe(true)
  })

  it('the neighbour itself never counts toward removing anybody', async () => {
    // Worth pinning separately, because the arithmetic is easy to misread. The
    // vector stage runs before moderation, so nothing downstream can rescue
    // this verdict — and `vector_similar_spam` is excluded from the summed
    // evidence outright. Whatever removal happens here has to be earned by
    // signals that were already on the table when the neighbour was found.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      vectors: { search: async () => ({ similarity: 0.97, status: 'confirmed', vectorId: 'v1' }) }
    })
    expect(contentEvidence(v.signals).total).toBe(0)
    expect(contentEvidence(v.signals).strongest).toBeGreaterThan(0)
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

  it('REGRESSION: discussing violence is not evidence of advertising', async () => {
    // Production, 2026-07-30 11:36: a member was KICKED mid-conversation for a
    // comment about a rocket strike. The provider's `violence` category fired,
    // `moderation_flagged` counted as content evidence, and the chat voted the
    // verdict ham. Whether a message breaks a chat's rules on violence is for
    // its admins; this pipeline only answers whether it is an advertisement.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Правильно, якщо не була мішенню, то і фіг з нею, ракета залетіла в огород' },
      user: newcomer
    }), { moderation: { check: async () => modResult({ violence: 0.97, harassment: 0.6 }) } })
    expect(v.signals.some((s) => s.name === 'moderation_flagged')).toBe(false)
    expect(['kick', 'mute', 'ban']).not.toContain(v.action)
  })

  it('sexual content in a message still raises the signal', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'приватні відео 18+ пиши мені в особисті' }, user: newcomer
    }), { moderation: { check: async () => modResult({ sexual: 0.88, violence: 0.1 }) } })
    const signal = v.signals.find((s) => s.name === 'moderation_flagged')
    expect(signal?.evidence).toContain('sexual')
  })

  it('a provider that exposes only its boolean is read narrowly', async () => {
    // No per-category scores: fall back to the named categories, still limited
    // to the spam-relevant ones.
    const violent = await evaluateMessage(makeInput({ msg: { text: 'текст про війну і смерть тут' } }), {
      moderation: { check: async () => ({ flagged: true, categories: ['violence'], scores: {} }) }
    })
    expect(violent.signals.some((s) => s.name === 'moderation_flagged')).toBe(false)

    const sexual = await evaluateMessage(makeInput({ msg: { text: 'текст із натяками на 18+ тут' } }), {
      moderation: { check: async () => ({ flagged: true, categories: ['sexual'], scores: {} }) }
    })
    expect(sexual.signals.some((s) => s.name === 'moderation_flagged')).toBe(true)
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
    // Cheap first, then strong: 0.92 removes the sender and nothing in the
    // message corroborates it, which is the one case the cheap tier may not
    // carry alone (2026-08-01). The verdict itself is unchanged.
    expect(calls).toEqual(['cheap', 'strong'])
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
    // A phone number is a fact about the message, not about the sender, and it
    // is weighted like one. Note what is NOT used here any more: a bare
    // external link (weight 0.8) stopped counting as decisive on 2026-07-30 —
    // it is the commonest ham content in a group chat, so on its own it now
    // buys an LLM look, not an enforcement. See the content-confirmation suite.
    const v = await evaluateMessage(makeInput({
      ...softShapeOver,
      msg: { text: 'подивись обовʼязково тут, пиши +380671234567' }
    }), {})
    expect(['delete', 'mute', 'ban']).toContain(v.action)
  })
})

describe('evaluateMessage — content-confirmation cap (2026-07-30 FP)', () => {
  // Faithful reproduction of the production false positive. A sleeper account
  // in a chat it had lurked in wrote an ordinary thank-you addressed to another
  // member. The sender-shape stack scored 0.845 — above the standard kick
  // threshold (0.75) and, fatally, above the LLM ceiling, which is the SAME
  // number. `edited_message` (weight 0.2) was enough to pass for "evidence
  // about the message", so the soft-shape guard stood down and the score
  // kicked. The chat voted ham 1:0 within five seconds.
  const conversational = {
    msg: {
      text: '@lyubchak , це розйоб. Дякую за цей скарб',
      isEdit: true,
      mentions: ['lyubchak']
    },
    user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 8 },
    enrichment: { bio: 'Мій сайт: example.com', personalChannelId: 7777 }
  }

  it('the stack still scores into kick territory (regression anchor)', async () => {
    const v = await evaluateMessage(makeInput(conversational), {})
    expect(v.pSpam).toBeGreaterThan(0.75)
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['sleeper_awakened', 'edited_message']))
  })

  it('REGRESSION: nobody is kicked over a score no stage could justify', async () => {
    const v = await evaluateMessage(makeInput(conversational), {})
    expect(['kick', 'mute', 'ban']).not.toContain(v.action)
  })

  it('a 0.2-weight edit marker no longer passes for message evidence', async () => {
    // With the crumb discounted, the whole stack is sender-shape again and the
    // soft-shape guard — which this FP had walked straight past — catches it.
    const v = await evaluateMessage(makeInput(conversational), {})
    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('soft_shape_only')
  })

  it('the LLM is consulted above the grey ceiling when the score wants the sender gone', async () => {
    const calls: LlmTier[] = []
    const v = await evaluateMessage(makeInput(conversational), {
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.03, reasonCode: 'small_talk', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toEqual(['cheap'])
    expect(v.decidedBy).toBe('llm')
    expect(v.action).toBe('none')
  })

  // One real but thin piece of message evidence: enough to act on the message
  // (the soft-shape guard stands down), nowhere near enough to remove a person.
  // A sub-threshold vector neighbour is the everyday version of this.
  const thinEvidence = {
    ...conversational,
    msg: { text: conversational.msg.text, mentions: conversational.msg.mentions }
  }
  const weakVector: PipelinePorts = {
    vectors: { search: async () => ({ vectorId: 'v1', similarity: 0.86, status: 'candidate' }) }
  }

  it('thin evidence caps the punishment at delete + community vote', async () => {
    const v = await evaluateMessage(makeInput(thinEvidence), weakVector)
    expect(v.pSpam).toBeGreaterThan(0.75)
    expect(v.action).toBe('delete')
    expect(v.needsVote).toBe(true)
    expect(v.reasonCode).toBe('content_unconfirmed')
    expect(v.meta['cappedFrom']).toBe('kick')
    // Zero, though a 1.0 signal was raised: the logged figure is the evidence
    // that would license removing the SENDER, and a resemblance is not part of
    // it (2026-08-01). The signal list beside it in the log still shows the
    // neighbour and its weight; this number answers whether the removal was
    // earned, and here it was not — which is why the verdict is capped.
    expect(v.meta['contentEvidence']).toBe(0)
    expect(v.signals.map((s) => s.name)).toContain('vector_similar_spam')
  })

  it('the sender is asked to prove they are human instead of being removed', async () => {
    const v = await evaluateMessage(makeInput(thinEvidence), weakVector)
    expect(v.requireCaptcha).toBe(true)
  })

  it('no captcha is demanded where the chat turned it off', async () => {
    const v = await evaluateMessage(
      makeInput({ ...thinEvidence, policy: { captchaEnabled: false } }), weakVector)
    expect(v.action).toBe('delete')
    expect(v.requireCaptcha).toBe(false)
  })

  it('REGRESSION: a news repost with an invite link is deleted, not kicked', async () => {
    // Production, 2026-07-30 11:52: a sleeper account reposting a news item was
    // KICKED at 0.77 on private_invite_link=1.8 + sleeper_awakened=1.2 +
    // long_text=0.4. One real content signal plus a soft stack plus a crumb: the
    // message may well deserve deleting, the person does not deserve removing.
    const v = await evaluateMessage(makeInput({
      msg: {
        text: `🇵🇱 Польща не була мішенню російської ракети, – прем'єр країни Туск. ${'За його словами, наразі немає жодних підстав вважати, що ракета була спрямована по території. '.repeat(2)}`,
        urls: [{ visible: 't.me/+abc', target: 'https://t.me/+abcdefghijklmno', hidden: false }]
      },
      user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 40, messagesInChat: 8 }
    }), {})
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['private_invite_link', 'sleeper_awakened', 'long_text']))
    expect(['kick', 'mute', 'ban']).not.toContain(v.action)
  })

  it('REGRESSION: thin evidence is not enforced unread in the DELETE band either', async () => {
    // Production, 2026-07-30 12:34, a `soft`-preset chat: a job ad scored 0.80
    // on phone_number 1.2 + newness stacking. Soft puts delete at 0.78 and kick
    // at 0.86, so the prospective action was not a REMOVAL — the LLM gate stayed
    // shut on a technicality and the message was deleted with nobody having read
    // it. The gate follows "enforcement on thin evidence", not "removal".
    const jobAd = {
      msg: {
        text: 'Запрошуємо в команду продавців-консультантів у магазини взуття та одягу. Графік роботи позмінний, повна зайнятість. Локація: вулиця Городоцька, торговий центр. Офіційне оформлення, стабільна оплата двічі на місяць, навчання за наш рахунок. Телефон +380671234567'
      },
      user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 1 },
      policy: { preset: 'soft' as const }
    }

    const scoreOnly = await evaluateMessage(makeInput(jobAd), {})
    expect(scoreOnly.pSpam).toBeGreaterThan(0.78)
    expect(scoreOnly.pSpam).toBeLessThan(0.86)

    const calls: LlmTier[] = []
    const v = await evaluateMessage(makeInput(jobAd), {
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.1, reasonCode: 'legit_share', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toEqual(['cheap'])
    expect(v.action).toBe('none')
  })

  it('REGRESSION: a resemblance plus one fact is not two facts', async () => {
    // Production, 2026-08-01 13:22: an appeal for help carrying a phone number
    // was BANNED for thirty days by the scoring path, `decidedBy: score`, with
    // no `llm_cheap` in the port timings — nothing read it. phone_number 1.2 +
    // vector_similar_spam 1.0 met the sender-removal bar exactly, which is what
    // `unearnedEnforcement` tests, so the LLM gate never opened. The same sum
    // muted a job ad in a jobs chat two hours earlier.
    const appeal = {
      msg: {
        text: 'Люди, прошу максимальної уваги! Звертаюсь із проханням про допомогу — ' +
          'якщо маєте можливість, допоможіть фінансово або поширте оголошення далі. ' +
          'Телефон для зв\'язку +380671234567'
      },
      user: newcomer
    }
    const nearNeighbour: PipelinePorts = {
      vectors: { search: async () => ({ vectorId: 'v9', similarity: 0.88, status: 'candidate' }) }
    }

    const calls: LlmTier[] = []
    const asked = await evaluateMessage(makeInput(appeal), {
      ...nearNeighbour,
      llm: {
        classify: async (_i, tier) => {
          calls.push(tier)
          return { pSpam: 0.05, reasonCode: 'legit_share', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toEqual(['cheap'])
    expect(asked.action).toBe('none')

    // With no LLM to ask: the message may still go, the person may not.
    const blind = await evaluateMessage(makeInput(appeal), nearNeighbour)
    expect(removesSender(blind.action)).toBe(false)
  })

  it('REGRESSION: a deterministic rule may not remove a sender the evidence cannot', async () => {
    // Production, 2026-08-01 15:47: a member answering somebody — a reply, with
    // `is_reply` on it — pasted a private invite and "you can ask here". Muted
    // by `private_invite_new` at 0.93.
    //
    // The scoring path is not allowed to do that. `private_invite_link` weighs
    // 1.8 against a sender-removal bar of 2.0, and a 2026-07-30 regression above
    // pins exactly this combination to `delete`. The deterministic branch
    // returns before either guard runs, so the pipeline held two incompatible
    // positions on the same evidence and which one applied depended only on
    // which stage spoke first.
    //
    // Rules resting on somebody else's verdict about the ACCOUNT — a Telegram
    // scam flag, a ban-database listing — are a different claim and keep their
    // reach. This one rests on one thing in the message.
    const invite = {
      msg: {
        text: 'Можеш спитати тут',
        urls: [{ visible: 't.me/+abcdefghij', target: 'https://t.me/+abcdefghijklmno', hidden: false }],
        replyTo: { authorId: 99, isSelf: false, ageSeconds: 30, textPreview: 'а де можна спитати?' }
      },
      user: { predictedAgeDays: 1500, localAgeDays: 2, messagesGlobal: 3, messagesInChat: 2 }
    }
    const v = await evaluateMessage(makeInput(invite), {})
    expect(v.ruleId).toBe('private_invite_new')
    expect(removesSender(v.action)).toBe(false)
    expect(v.needsVote).toBe(true)
    expect(v.reasonCode).toBe('content_unconfirmed')
  })

  it('an account verdict keeps its reach — the cap is about message evidence', async () => {
    // A ban-database listing says nothing about the message and is not supposed
    // to: capping it on message evidence would silently disable the rule.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Привіт усім, як справи?' },
      user: {
        predictedAgeDays: 5, localAgeDays: 0, messagesGlobal: 1, messagesInChat: 1,
        externalBan: { banned: true, bannedAt: new Date(), offenses: 1, sources: ['lols' as const] }
      }
    }), {})
    expect(v.ruleId).toBe('external_ban_new')
    expect(removesSender(v.action)).toBe(true)
  })

  it('what the profile advertises gets the message read, and decides nothing itself', async () => {
    // The escort-bot shape: a neutral, on-topic remark from an account whose
    // picture is explicit and whose linked channel is a price list. Everything
    // known here is about the ACCOUNT, so `contentEvidence` stays at zero and
    // the arithmetic may not act — the profile's whole job is to make sure the
    // one stage that reads text is asked.
    const escort = {
      msg: { text: 'Так, я теж це читала сьогодні вранці, дуже сумна новина' },
      user: newcomer,
      enrichment: {
        linkedChannels: [{
          source: 'personal_channel' as const,
          title: 'Приват 18+',
          description: 'Прайс і умови — t.me/+abcdefghij',
          subscribers: 340,
          avatarBase64: 'AAAA'
        }]
      }
    }
    const explicit: PipelinePorts = {
      moderation: {
        check: async (text) => text === ''
          ? modResult({ sexual: 0.93 })
          : modClean
      }
    }

    const blind = await evaluateMessage(makeInput(escort), explicit)
    expect(blind.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['promo_in_linked_channel', 'nsfw_linked_channel']))
    expect(blind.meta['contentEvidence']).toBe(0)
    expect(isEnforcementAction(blind.action)).toBe(false)
    expect(blind.reasonCode).toBe('soft_shape_only')

    // With a reader, the profile is context and the model still judges the text.
    let sawChannel: string | null = null
    const read = await evaluateMessage(makeInput(escort), {
      ...explicit,
      llm: {
        classify: async (i) => {
          sawChannel = i.enrichment.linkedChannels[0]?.title ?? null
          return { pSpam: 0.02, reasonCode: 'small_talk', evidence: null, cached: false }
        }
      }
    })
    expect(sawChannel).toBe('Приват 18+')
    expect(read.action).toBe('none')
  })

  it('an ordinary delete quizzes nobody — the gate belongs to the capped band', async () => {
    // Only a verdict that WANTED the sender gone trades the removal for a
    // question. A plain delete in the delete band is not an uncertain removal.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'подивись обовʼязково тут, пиши +380671234567' },
      user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 8 }
    }), {})
    expect(v.action).toBe('delete')
    expect(v.reasonCode).not.toBe('content_unconfirmed')
    expect(v.requireCaptcha ?? false).toBe(false)
  })

  it('an LLM that errors out cannot re-open the sender-removal path', async () => {
    const v = await evaluateMessage(makeInput(thinEvidence), {
      ...weakVector,
      llm: { classify: async () => { throw new Error('rate limited') } }
    })
    expect(v.action).toBe('delete')
    expect(v.decidedBy).toBe('score')
  })

  it('real message evidence still removes the sender without an LLM', async () => {
    // The cap is about thin evidence, not about the LLM being mandatory: three
    // URL buttons and a phone number are the message convicting itself.
    const v = await evaluateMessage(makeInput({
      msg: {
        text: 'Робота вдома, пиши +380671234567',
        inlineButtons: [
          { text: 'a', url: 'https://a.example' },
          { text: 'b', url: 'https://b.example' },
          { text: 'c', url: 'https://c.example' }
        ]
      },
      user: newcomer
    }), {})
    expect(['kick', 'mute', 'ban']).toContain(v.action)
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

  it('an externally-banned newcomer is banned, but the ban EXPIRES', async () => {
    // Reversed on 2026-07-31, and it had been asserted the other way round.
    //
    // `external_ban_new` is the one rule that bans with zero content evidence:
    // `contentEvidence` was 0 in production when it permanently banned an
    // account for a message about an audiobook. That is a deliberate policy —
    // an account a ban database lists, new to us, is removed before it acts —
    // but it cannot be a PERMANENT one, for the reason the rule's own comment
    // gives: the known false-positive class of these databases is the
    // rehabilitated account. That error is one that time fixes, and a permanent
    // ban is precisely the response that denies it the chance.
    //
    // Telegram's own flags stay permanent: the platform adjudicated the account
    // itself and offers an appeal. A crowd-sourced list is a different tier of
    // authority, and conflating the two is what produced the outcome above.
    const v = await evaluateMessage(makeInput({
      user: { ...newcomer, externalBan: { banned: true, bannedAt: null, offenses: 3, sources: ['lols'] } }
    }), {})
    expect(v.action).toBe('ban')
    expect(v.ruleId).toBe('external_ban_new')
    expect(v.banDurationSeconds).toBeGreaterThan(0)
  })

  it('a scam flag alongside an external listing is still permanent', async () => {
    // The platform verdict is what grants permanence; a third-party listing
    // neither grants nor removes it.
    const v = await evaluateMessage(makeInput({
      user: {
        ...newcomer,
        flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false },
        externalBan: { banned: true, bannedAt: null, offenses: 3, sources: ['lols'] }
      }
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

  it('REGRESSION: volume alone cannot buy the exempt — standing takes time', async () => {
    // The counters rise on every message in every chat the bot watches, with no
    // rate or quality condition, so 50 messages of "ок" in a group the spammer
    // controls used to buy a total bypass of the pipeline in all 52 chats
    // (2026-07-30 review). A regular is someone who has been around.
    const farmed = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 60, messagesGlobal: 900, localAgeDays: 1 } }),
      confirmedSignature)
    expect(farmed.reasonCode).not.toBe('established_regular')
    expect(farmed.decidedBy).toBe('signature')

    // An unknown first-seen is not evidence of tenure either.
    const unknown = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 60, messagesGlobal: 900, localAgeDays: null } }),
      confirmedSignature)
    expect(unknown.reasonCode).not.toBe('established_regular')

    // The same volume with real tenure is exempt, as before.
    const tenured = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 60, messagesGlobal: 900, localAgeDays: 30 } }),
      confirmedSignature)
    expect(tenured.reasonCode).toBe('established_regular')
  })

  it('below both thresholds runs the full pipeline (signature decides)', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 9, messagesGlobal: 49 } }),
      confirmedSignature)
    expect(v.decidedBy).toBe('signature')
  })

  it('a hard account verdict cancels the exempt — the pipeline still decides', async () => {
    const guards: Partial<UserSnapshot>[] = [
      { externalBan: { banned: true, bannedAt: null, offenses: 2, sources: ['lols'] } },
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
        user: { messagesInChat: 50, externalBan: { banned: true, bannedAt: null, offenses: 2, sources: ['lols'] } },
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

describe('evaluateMessage — a script the chat does not use', () => {
  const cjk = {
    // Ten logographic characters plus a handle: a complete sentence whose
    // codepoint count is that of a two-word greeting.
    text: '会洗mi的来 日入上w @mlstii',
    mentions: ['mlstii']
  }

  it('is classified rather than abstained on', async () => {
    const v = await evaluateMessage(makeInput({ msg: cjk, user: newcomer }), {})
    expect(v.decidedBy).not.toBe('abstain')
    expect(v.reasonCode).not.toBe('low_information')
  })

  it('reaches the LLM even though arithmetic puts it nowhere near the grey zone', async () => {
    // REGRESSION (2026-07-31): two independent barriers stood between this
    // message and any stage able to read it. The gate called it too short, and
    // once that was fixed the score landed at 0.27 — below LLM_GREY_LOW — so
    // the only multilingual reader in the pipeline was never asked. In
    // production the class was caught solely when the account already sat in an
    // external ban database.
    const tiers: LlmTier[] = []
    const v = await evaluateMessage(makeInput({ msg: cjk, user: newcomer }), {
      llm: {
        classify: async (_i, tier) => {
          tiers.push(tier)
          return { pSpam: 0.97, reasonCode: 'other_spam', evidence: null, cached: false }
        }
      }
    })
    // Both tiers: 0.97 removes the sender and no other stage found anything —
    // least of all here, where every one of them was reading a script it was
    // not built for. If there is a case for a second opinion, it is this one.
    expect(tiers).toEqual(['cheap', 'strong'])
    expect(v.decidedBy).toBe('llm')
    expect(isEnforcementAction(v.action)).toBe(true)
  })

  it('does not fire in a chat that writes that script', async () => {
    let llmCalled = false
    const window = [
      { authorId: 7, authorKind: 'user' as const, textPreview: '酒店的房间很好我明天过来看看' },
      { authorId: 8, authorKind: 'user' as const, textPreview: '好的没问题谢谢你明天见面' }
    ]
    const v = await evaluateMessage(
      makeInput({ msg: cjk, user: newcomer, enrichment: { conversationWindow: window } }),
      { llm: { classify: async () => { llmCalled = true; return null } } })
    expect(v.signals.map((s) => s.name)).not.toContain('foreign_script')
    // Back to an ordinary short message in its own chat: newcomer signals only,
    // well under every threshold, and no reason to spend an LLM call.
    expect(v.action).toBe('none')
    expect(llmCalled).toBe(false)
  })

  it('being foreign is never itself grounds to act', async () => {
    // The signal is a routing device. With no LLM configured it must leave the
    // verdict where it would have been, not nudge it into enforcement.
    const v = await evaluateMessage(makeInput({ msg: cjk, user: newcomer }), {})
    expect(isEnforcementAction(v.action)).toBe(false)
  })
})

describe('evaluateMessage — an external listing is not evidence about the message', () => {
  const banned: Partial<UserSnapshot> = {
    externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] },
    // Local history, so `external_ban_new` deliberately does not apply: its own
    // comment names the rehabilitated account as this database's FP class.
    messagesInChat: 6, messagesGlobal: 30, localAgeDays: 200, predictedAgeDays: 1500
  }
  const ordinaryQuestion = {
    text: 'Доброго дня, підкажіть будь ласка, чи можна відновити довідку якщо оригінал віддали'
  }

  it('does not enforce on the listing alone when nothing read the text', async () => {
    // REGRESSION (2026-07-31): scored 0.82 on `external_ban` + `sleeper_awakened`
    // and deleted an ordinary question three times inside ten minutes; the chat
    // voted ham 3:0 on every one of them.
    const v = await evaluateMessage(makeInput({ msg: ordinaryQuestion, user: banned }), {})
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  it('lets the LLM clear it, and the listing does not override the reading', async () => {
    const v = await evaluateMessage(makeInput({ msg: ordinaryQuestion, user: banned }), {
      llm: {
        classify: async () => ({ pSpam: 0.05, reasonCode: 'ham', evidence: null, cached: false })
      }
    })
    expect(v.decidedBy).toBe('llm')
    expect(v.action).toBe('none')
  })

  it('still bans an externally-banned account with no local history', async () => {
    // The workhorse rule must be untouched: nearly every applied ban in
    // production comes through it.
    const v = await evaluateMessage(makeInput({
      msg: ordinaryQuestion,
      user: { ...newcomer, externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] } }
    }), {})
    expect(v.decidedBy).toBe('deterministic')
    expect(v.ruleId).toBe('external_ban_new')
    expect(v.action).toBe('ban')
  })
})
