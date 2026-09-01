import { describe, expect, it } from 'vitest'
import type {
  ChannelPreview, ChatPolicy, Enrichment, EvaluationInput, NormalizedChat, NormalizedMessage,
  UserSnapshot, VerdictAction
} from './types.js'
import type { BurstEntry, BurstPort, ModerationResult, PipelinePorts, SessionPort } from './ports.js'
import { evaluateMessage } from './pipeline.js'
import { isEnforcementAction, removesSender, PRESET_THRESHOLDS } from './policy.js'
import { contentEvidence, mayRemoveSender } from './score.js'

// ── fixtures ──────────────────────────────────────────────────────────

const makeMsg = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -100123, messageId: 1, threadId: null, date: 1_780_000_000,
  isEdit: false, editDate: 0, text: 'Звичайне повідомлення в чаті, нічого особливого тут немає',
  urls: [], mentions: [], attachments: [], inlineButtons: [],
  forward: null, replyTo: null, channelComment: null, editDelta: null,
  customEmoji: [], guestBot: null,
  ...overrides
})

const makeUser = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42, username: 'someone', displayName: 'Someone', languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800, predictedAgeBoundsDays: null, localAgeDays: 400,
  // Below the established-regular exempt thresholds (10 in-chat / 50 global) on
  // purpose: the default user must still run the full pipeline so port tests
  // exercise the ports. Established users are tested explicitly below.
  messagesInChat: 8, messagesGlobal: 40, groupsActive: 2,
  spamDetections: 0, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: { count: 2, latestSetDaysAgo: 200 },
  nameChurn24h: 0, usernameChurn24h: 0, restrictionReasons: [], joinedAgoSeconds: null,
  ...overrides
})

const chat: NormalizedChat = { id: -100123, kind: 'group', title: 'Test', topLanguage: 'uk', description: null }

const makePolicy = (overrides: Partial<ChatPolicy> = {}): ChatPolicy => ({
  enabled: true, preset: 'standard', captchaEnabled: true, votingEnabled: true,
  externalBanEnabled: true, customRules: [], trustedUserIds: [],
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

describe('evaluateMessage — the account farm', () => {
  /**
   * The reuse lookup used to live inside `screenProfileMedia` and inherited its
   * first line, `if (!ports.moderation) return`. Nothing about finding one
   * photograph on many accounts needs the moderation port — the hash comes from
   * the app layer and the lookup hits our own store — so a moderation outage
   * silently disabled the only detector in this pipeline that can see an
   * operator rather than a member, and disabled it invisibly.
   */
  it('finds a shared profile photo with no moderation port configured', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Увімкніть людність під час війни' },
      user: newcomer,
      enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), {
      profileMedia: { seen: async () => ({ otherAccounts: 17, sampleUserIds: [11, 22] }) }
    })
    expect(v.signals.map((s) => s.name)).toContain('avatar_shared_with_accounts')
    expect(v.meta['avatarSharedWith']).toBe(17)
  })

  it('one other account is the singular signal, not the network one', async () => {
    // A meme, a film still, two partners with the same holiday photo. The
    // catalogue weighs the two apart (0.8 shape vs 1.8 evidence) precisely
    // because one match is ordinary and a crowd is not.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Увімкніть людність під час війни' },
      user: newcomer,
      enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), {
      profileMedia: { seen: async () => ({ otherAccounts: 1, sampleUserIds: [11] }) }
    })
    const names = v.signals.map((s) => s.name)
    expect(names).toContain('avatar_shared_with_account')
    expect(names).not.toContain('avatar_shared_with_accounts')
  })
})

describe('evaluateMessage — a clean reading does not unfind a farm', () => {
  const farm: PipelinePorts['profileMedia'] = {
    seen: async () => ({ otherAccounts: 17, sampleUserIds: [11, 22] })
  }
  const cleared = {
    classify: async () => ({
      pSpam: 0.02, reasonCode: 'legit_conversation', evidence: null, cached: false
    })
  }

  /**
   * Measured over the fortnight to 2026-08-30: 96 decisions where the
   * classifier cleared a message whose entire case was a profile photo found on
   * 4 to 25 other accounts. `contentEvidence` was 1.8 in every one — the photo
   * and nothing else — while the score ran 0.909 to 0.994. 48 accounts, 34 of
   * them never caught by anything. The corpus was about twenty Ukrainian
   * phrases of ordinary outrage, rotated between accounts and paced 28 to 33
   * hours apart: no reader of the sentence could call it spam, and the velocity
   * window at six hours never saw two copies together.
   *
   * The classifier reads text. It cannot read a photograph off seventeen other
   * accounts, so its verdict is not a refutation of that finding — and its
   * number replaces the score outright, which is how the finding came to be
   * worth nothing at all.
   */
  it('asks the sender to prove they are human instead of falling silent', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Увімкніть людність під час війни' },
      user: newcomer,
      enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), { profileMedia: farm, llm: cleared })
    expect(v.action).toBe('captcha')
    expect(v.reasonCode).toBe('shared_profile_photo')
    expect(v.meta['flooredNetworkFact']).toBe(true)
  })

  it('never enforces on it — the message itself was read and cleared', async () => {
    // `contentEvidence` here is 1.8, one notch under `SENDER_REMOVAL_MIN_EVIDENCE`,
    // and that is deliberate in the catalogue: a shared photo says the accounts
    // are operated together, not that this sentence is an advert. A ceiling that
    // deleted the message would be punishing the text the model just read.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Увімкніть людність під час війни' },
      user: newcomer,
      policy: { captchaEnabled: false },
      enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), { profileMedia: farm, llm: cleared })
    expect(isEnforcementAction(v.action)).toBe(false)
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
  })

  it('leaves a verdict that already acted alone', async () => {
    const v = await evaluateMessage(makeInput({
      msg: spamText, user: newcomer, enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), {
      profileMedia: farm,
      llm: { classify: async () => ({ pSpam: 0.97, reasonCode: 'job_scam', evidence: null, cached: false }) }
    })
    expect(isEnforcementAction(v.action)).toBe(true)
    expect(v.meta['flooredNetworkFact']).toBeUndefined()
  })

  it('does not fire on one shared photo', async () => {
    // The singular signal is a meme or a holiday photo two people both like.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Увімкніть людність під час війни' },
      user: newcomer,
      enrichment: { avatarDhash: 'ff00ff00ff00ff00' }
    }), {
      profileMedia: { seen: async () => ({ otherAccounts: 1, sampleUserIds: [11] }) },
      llm: cleared
    })
    expect(v.action).toBe('none')
  })
})

describe('evaluateMessage — a forwarded advert is not the forwarder\'s', () => {
  /**
   * The forward port was the one knowledge stage returning its verdict with no
   * ceiling on it — the vector port beside it has carried one since 2026-08-02,
   * for the same reason and after the same kind of reversal.
   *
   * It matters more here than anywhere else in the file. Every other stage
   * judges something the sender did; a blacklisted origin is a fact about a
   * channel somebody else runs, and forwarding a scam into a chat to ask "is
   * this real?" is the most ordinary thing a member can do with one. `0.95`
   * lands exactly on the standard ban threshold, so that reading used to hand a
   * newish account a 30-day ban for quoting an advert it did not write.
   */
  it('takes the message down but not the person', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'це справжнє?', forward: { kind: 'channel', title: 'Легкий заробіток', sourceId: -100777 } },
      user: newcomer
    }), { forwards: { check: async () => 'blacklisted' as const } })
    expect(v.ruleId).toBe('forward_blacklist')
    expect(removesSender(v.action)).toBe(false)
    expect(v.action).toBe('delete')
    // The reason stands — the origin really is blacklisted. Only the punishment
    // was too much, so unlike `capUnearnedRemoval` this ceiling keeps the label.
    expect(v.reasonCode).toBe('forward_blacklist')
    expect(v.meta['cappedFrom']).toBe('ban')
  })

  it('still removes the sender when the message itself earned it', async () => {
    // Two independent facts about the message: a private invite (1.8) and a
    // phone number (1.2), which is what `SENDER_REMOVAL_MIN_EVIDENCE` means.
    const v = await evaluateMessage(makeInput({
      msg: {
        text: 'пишіть +380671234567',
        urls: [{ visible: 't.me/+AbCd', target: 'https://t.me/+AbCd123', hidden: false }],
        forward: { kind: 'channel', title: 'Легкий заробіток', sourceId: -100777 }
      },
      user: newcomer
    }), { forwards: { check: async () => 'blacklisted' as const } })
    expect(mayRemoveSender(v.signals)).toBe(true)
    expect(removesSender(v.action)).toBe(true)
  })
})

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
      user: { messagesGlobal: 500 }
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
    let calls = 0
    const ports: PipelinePorts = {
      session: {
        append: async () => ({
          combinedText: 'пиши мені\nв особисті\nзаробіток\nвід 500$\nна день усім хто напише',
          count: 5
        }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.9, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    }
    const input = makeInput({ msg: { text: 'на день усім хто напише' }, user: newcomer })
    const v = await evaluateMessage(input, ports)
    expect(v.decidedBy).toBe('session')
    expect(v.action).toBe('mute')
    // One classifier, one call: the escalation that used to follow every session
    // removal is gone with the tier split.
    expect(calls).toBe(1)
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
    // Keyed by message id, like both real ports: a fake that merely appends is
    // a fake of the defect that made three messages read as five.
    const appended = new Map<number, string>()
    let classified = 0
    const ports: PipelinePorts = {
      session: {
        append: async (_c, _u, messageId, t) => {
          appended.delete(messageId)
          appended.set(messageId, t)
          return { combinedText: [...appended.values()].join('\n'), count: appended.size }
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

    // Distinct message ids, because these are five MESSAGES. This test used to
    // send one id five times and pass anyway, on a buffer that could not tell
    // the difference — the same blindness that let an edit double its own text
    // in production and be read back as flood.
    const nth = (i: number) => makeInput({
      ...solicitation, msg: { ...solicitation.msg, messageId: 500 + i }
    })

    // Nothing is found, so nothing is done — but the message is remembered.
    const first = await evaluateMessage(nth(0), ports)
    expect(classified).toBe(0)
    expect(isEnforcementAction(first.action)).toBe(false)
    expect(appended.size).toBe(1)

    let last = first
    for (let i = 1; i <= 4; i += 1) last = await evaluateMessage(nth(i), ports)
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
        append: async (_c, _u, _m, t) => ({ combinedText: t, count: 1 }),
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
        append: async (_c, _u, _m, t) => {
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

  it('the classifier is asked exactly once, corroborated or not', async () => {
    // Was: "a removal nothing corroborates gets the strong model first". That
    // escalation is gone — across ~25 of them in the 2026-08-05/07 logs the strong
    // tier never returned a usable answer, so it was a safeguard only in the
    // source. Pinned here because the shape it left behind is load-bearing: an LLM
    // verdict reaches the caller having passed no evidence bar, whether or not any
    // other stage found something in the message. See the note at the call site.
    let calls = 0
    const ports = (pSpam: number): PipelinePorts => ({
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    })
    // Long enough not to earn the brevity discount, so the score reaches the
    // grey zone on its own and the classifier is consulted the ordinary way.
    const uncorroborated = await evaluateMessage(makeInput({
      msg: { text: 'Гарного дня всім, підкажіть будь ласка, як тут заведено ставити запитання?' },
      user: newcomer
    }), ports(0.97))
    expect(calls).toBe(1)
    expect(contentEvidence(uncorroborated.signals).strongest).toBe(0)
    expect(removesSender(uncorroborated.action)).toBe(true)

    calls = 0
    const corroborated = await evaluateMessage(makeInput({
      msg: { text: 'Робота вдома, гарний дохід щотижня, телефонуйте +380671234567' },
      user: newcomer
    }), ports(0.97))
    expect(calls).toBe(1)
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
        append: async (_c, _u, _m, t) => ({ combinedText: t, count: 1 }),
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
        append: async (_c, _u, _m, t) => {
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

  it('DOCUMENTS THE GAP: one classifier removes the sender on a blob unaided', async () => {
    // This test asserted the opposite until the tier split came out: the cheap
    // model alone could not exile somebody over concatenated one-liners, because
    // the strong model got a veto. Nothing replaced that veto, so the current
    // behaviour is the one production already had — the strong tier never answered
    // — and it is recorded here rather than left implied.
    //
    // Production 2026-08-07 08:41: "Hey kisi ke pass adult sticker hai ...?" — a
    // question — banned for 30 days at pSpam 0.98, on scorePSpam 0.1192 and
    // contentEvidence 0. Flip this expectation when the band is calibrated.
    let calls = 0
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => {
          calls += 1
          // `job_scam` rather than `flood`: the gap below is about the missing
          // evidence bar and still stands, but `flood` acquired a ceiling of its
          // own on 2026-08-07 (`IMITABLE_REASON_CODES`) and would no longer
          // demonstrate it. That much of the gap is closed; this much is not.
          return { pSpam: 0.98, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'ну от' }, user: newcomer }), ports)
    expect(calls).toBe(1)
    expect(v.pSpam).toBe(0.98)
    expect(contentEvidence(v.signals).total).toBe(0)
    expect(removesSender(v.action)).toBe(true)
  })

  /**
   * The population these two tests separate is the one nothing else sees:
   * `established_user` is earned at 50 messages, while the established-regular
   * exempt additionally wants 7 days of local tenure. Somebody who talks a lot
   * and whom the chat has known briefly sits in that gap — vouched for by one
   * signal worth -1.5 that the session path did not read at all.
   */
  it('a session verdict may not remove the message of somebody the signals vouch for', async () => {
    // Production 2026-08-17/18: 14 session `flood` verdicts, 4 acted on, and of
    // the 3 that were then reviewed, 2 were overturned by the chat 0:3. Eight of
    // the remaining 10 were stopped only by the trusted/admin execution guard,
    // i.e. after the verdict, not by it. The arithmetic had already said
    // innocent — one at scorePSpam 0.0003 against the model's 0.94 — because a
    // session verdict hands its pSpam straight to `policyFor`, which makes the
    // trust weights telemetry. The chat is still asked; the message stays until
    // it answers.
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ага\nтак\nну\nбуло таке\nі шо', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.96, reasonCode: 'flood', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: 'і шо' },
      // Enough volume for `established_user`, too little local tenure for the
      // established-regular exempt — which would otherwise answer first.
      user: { messagesGlobal: 60, messagesInChat: 8, localAgeDays: 3 }
    }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.signals.some((s) => s.name === 'established_user')).toBe(true)
    expect(isEnforcementAction(v.action)).toBe(false)
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
  })

  it('an admin naming the sender vouches for them as much as volume does', async () => {
    /**
     * The same ceiling, reached by the other half of the standing question — and
     * the half it could not see until 2026-08-27.
     *
     * `hasSenderStanding` read `established_user` only, so a sender with no
     * volume at all but named on the chat's own trusted list was a stranger to
     * it. Production that day: an admin cleared a message at 14:35:18, which by
     * the same tap added its sender to that list; at 14:38:15 the session stage
     * judged the same text, asked the ceiling, and deleted it. The admin undid
     * the first one and the second stood.
     *
     * The user here is a newcomer on purpose — no volume, no tenure, nothing but
     * the admin's word. That is the whole population this asserts about.
     */
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ага\nтак\nну\nбуло таке\nі шо', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.96, reasonCode: 'other_spam', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: 'і шо' },
      user: newcomer,
      policy: { trustedUserIds: [makeUser().id] }
    }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.signals.some((s) => s.name === 'trusted_reputation')).toBe(true)
    expect(v.signals.some((s) => s.name === 'established_user')).toBe(false)
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
    expect(v.meta['cappedVouched']).toBe(true)
  })

  /**
   * 2026-08-27: the third discount the window ceiling was written to restore.
   *
   * `is_reply (-1)` is named in that ceiling's own docstring as arithmetic this
   * stage discards, and was left out of the predicate acting on it. Over the
   * fortnight to that date the stage produced 229 enforcements, 23 reversed by
   * an admin, and its largest single producer of them was `flood` — a person
   * answering somebody, judged as a flood of it, while the arithmetic on the
   * same rows read between 0.0003 and 0.06 against the model's 0.89 to 0.98.
   *
   * The sender here has nothing else: no volume, no tenure, no admin's word.
   * A reply and an imitable finding is the whole of it.
   */
  it('a stranger answering somebody is asked about, not deleted', async () => {
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ага\nтак\nну\nбуло таке\nі шо', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        // `channel_promo`, not `flood`: flood is never enforced from a window
        // at all (see `capWindowFlood`), so it could not tell this ceiling from
        // that one.
        classify: async () => ({ pSpam: 0.96, reasonCode: 'channel_promo', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: {
        text: 'і шо',
        replyTo: { authorId: 9, isSelf: false, ageSeconds: 60, textPreview: 'а ти як думаєш' }
      },
      user: newcomer
    }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.signals.some((s) => s.name === 'is_reply')).toBe(true)
    // Nothing else vouched for them — this is the reply branch and only it.
    expect(v.signals.some((s) => s.name === 'established_user')).toBe(false)
    expect(v.signals.some((s) => s.name === 'trusted_reputation')).toBe(false)
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
    expect(v.meta['cappedReplyReason']).toBe('channel_promo')
    // The two reasons are never collapsed: they carry different risks.
    expect(v.meta['cappedVouched']).toBeUndefined()
  })

  /**
   * A reply costs one tap, so it buys the ceiling only where an ordinary member
   * could plausibly have done the thing. Talking fast is imitable; this is not,
   * and the same window with the same reply still enforces.
   */
  it('a reply does not cover a finding an ordinary member would not produce', async () => {
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'привіт\nяк ти\nпиши мені\nось сюди\nтут', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.97, reasonCode: 'adult_promo', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: {
        text: 'тут',
        replyTo: { authorId: 9, isSelf: false, ageSeconds: 60, textPreview: 'а ти як думаєш' }
      },
      user: newcomer
    }), ports)
    expect(v.signals.some((s) => s.name === 'is_reply')).toBe(true)
    expect(v.action).not.toBe('observe')
    expect(v.meta['cappedReplyReason']).toBeUndefined()
  })

  it('...and still removes it for a stranger, who has no standing to read', async () => {
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        // A content finding, deliberately: `flood` is never enforced from a
        // window whoever sent it, so it cannot show what standing does here.
        classify: async () => ({ pSpam: 0.96, reasonCode: 'channel_promo', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'ну от' }, user: newcomer }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.action).toBe('delete')
  })

  /**
   * 2026-08-27. `flood` describes this stage's INPUT, not a finding about it —
   * the pile exists because somebody sent several short messages nothing could
   * read one at a time, so the word hands the premise back as the conclusion.
   *
   * The fortnight to that date: window enforcement on `flood` reversed by an
   * admin 18 times in 66, at 27.3%, against 3.1% for every other reason the
   * same stage gives, and 6.8% for the same word from the per-message
   * classifier. This sender is a stranger with nothing to vouch for them —
   * standing is not what holds it.
   */
  it('a window never enforces on a word that describes its own input', async () => {
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.96, reasonCode: 'flood', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({ msg: { text: 'ну от' }, user: newcomer }), ports)
    expect(v.decidedBy).toBe('session')
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
    expect(v.meta['cappedRestated']).toBe(true)
    // The word stays sayable. Taken out of the vocabulary, a forced choice
    // would relabel the same weak evidence as a content finding and hide the
    // failure inside a code that holds up — so it is kept, and made inert.
    expect(v.reasonCode).toBe('flood')
  })

  it('and being caught before does not make that word actionable either', async () => {
    // Unlike every other ceiling here, this one has no revoker: the objection
    // is to the finding, not to the sender, and a bad account does not make a
    // restated premise into evidence.
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ок\nда\nугу\n+\nну от', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.99, reasonCode: 'flood', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: 'ну от' },
      user: { ...newcomer, spamDetections: 3 }
    }), ports)
    expect(v.signals.some((s) => s.name === 'prior_spam_detections')).toBe(true)
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  it('leaves the same word alone when a stage that read the message says it', async () => {
    // The objection is to this stage answering with this word, not to the word.
    // The per-message classifier read one message and reversed at 6.8%.
    const ports: PipelinePorts = {
      llm: {
        classify: async () => ({ pSpam: 0.96, reasonCode: 'flood', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).toBe('llm')
    expect(isEnforcementAction(v.action)).toBe(true)
    expect(v.meta['cappedRestated']).toBeUndefined()
  })

  it('a session verdict on a NON-imitable code is capped by standing too', async () => {
    // The imitable ceiling shipped 2026-08-07 covers 3 reason codes. The gap the
    // calibration runbook names is the general one: any session verdict at all
    // on somebody the signals vouch for, since none of them pass an evidence bar.
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ага\nтак\nну\nбуло таке\nі шо', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        classify: async () => ({ pSpam: 0.99, reasonCode: 'job_scam', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: 'і шо' },
      user: { messagesGlobal: 60, messagesInChat: 8, localAgeDays: 3 }
    }), ports)
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
  })

  it('standing spent by being caught does not shield a session verdict', async () => {
    // Same revoker as `hasSenderStanding` everywhere else: an account this chat
    // has already caught twice keeps no vouching.
    const ports: PipelinePorts = {
      session: {
        append: async () => ({ combinedText: 'ага\nтак\nну\nбуло таке\nі шо', count: 5 }),
        reset: async () => { /* noop */ }
      },
      llm: {
        // Not `flood`: that one is held from a window regardless of standing,
        // which would hide whether the revoker did anything.
        classify: async () => ({ pSpam: 0.96, reasonCode: 'channel_promo', evidence: null, cached: false })
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: 'і шо' },
      user: { messagesGlobal: 60, messagesInChat: 8, localAgeDays: 3, spamDetections: 2 }
    }), ports)
    expect(v.signals.some((s) => s.name === 'prior_spam_detections')).toBe(true)
    expect(isEnforcementAction(v.action)).toBe(true)
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

  it('velocity reports what it counted and decides nothing', async () => {
    // Retired as a decider 2026-08-07 on its own record: 10 of the 52 known
    // false positives in fourteen days of production, which is 16% of its 61
    // verdicts — the worst precision in the pipeline, for 1.4% of the
    // enforcement. It counts copies and never reads one, and cross-posting is
    // something members do.
    const ports: PipelinePorts = {
      velocity: { check: async () => ({ exceeded: true, evidence: '6 copies in 4 chats' }) }
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), ports)
    expect(v.decidedBy).not.toBe('velocity')
    expect(v.signals.map((s) => s.name)).toContain('velocity_wave')
  })

  /**
   * The stage that DECIDES has to be told what the stage that only counts saw.
   *
   * `velocity`'s own retirement note says repetition "is a reason to look
   * harder" and that "the stages that can READ the message decide what it
   * means" — but the classifier's number replaces the score outright, and until
   * 2026-08-26 it was produced without this fact ever reaching the prompt.
   * Production that day: one text into three chats in four minutes by an account
   * with three confirmed detections, score 0.94, `legit_share` every time.
   */
  it('hands the classifier what the window watched arrive', async () => {
    let seen: string | undefined = 'not called'
    await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, evidence: '6 copies in 4 chats' }) },
      llm: {
        classify: async (_input, observed) => {
          seen = observed?.repetition
          return null
        }
      }
    })
    expect(seen).toBe('6 copies in 4 chats')
  })

  it('says nothing to the classifier when nothing repeated', async () => {
    // An empty observation, not a claim that the window was clean: the window
    // may simply not have been consulted.
    let observedAtAll: unknown = 'not called'
    await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: false }) },
      llm: {
        classify: async (_input, observed) => {
          observedAtAll = observed?.repetition
          return null
        }
      }
    })
    expect(observedAtAll).toBeUndefined()
  })

  it('both branches raise their own signal and neither concludes', async () => {
    // One account repeating itself and several accounts repeating each other are
    // different facts and stay different signals — `velocity_repeats` is
    // firsthand content evidence, `velocity_wave` is what a viral line also
    // looks like. What neither of them is any more is a verdict.
    const blast = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    })
    expect(blast.signals.map((s) => s.name)).toContain('velocity_repeats')
    expect(blast.decidedBy).not.toBe('velocity')

    const wave = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: false }) }
    })
    expect(wave.signals.map((s) => s.name)).toContain('velocity_wave')
    expect(wave.decidedBy).not.toBe('velocity')
  })

  it('repetition still weighs — as evidence the readers get to see', async () => {
    // The observation must not be lost with the verdict. `velocity_repeats` is
    // content evidence (copies we watched arrive), so it has to move the score
    // and, with it, what the sender-removal bar allows.
    const quiet = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {})
    const repeated = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    })
    expect(repeated.meta['scorePSpam'] as number)
      .toBeGreaterThan(quiet.meta['scorePSpam'] as number)
    expect(contentEvidence(repeated.signals).total)
      .toBeGreaterThan(contentEvidence(quiet.signals).total)
  })

  it('REGRESSION: repetition may strengthen a verdict, never weaken it', async () => {
    // Production 2026-08-02, one sender, one text, one chat. The classifier read
    // the text at 04:35 and returned a ban at 1.00; at 04:50 the same text came
    // back from its cache in 7 ms. From 04:55 on, velocity tripped first and
    // every further copy was answered with delete + a question for the chat —
    // seven times, and the chat answered "spam" on six of them.
    //
    // The third copy of a text already judged is more damning than the first,
    // and the pipeline graded it lower. Velocity counts copies and never reads
    // one, so its own verdict is capped for want of evidence it structurally
    // cannot have; short-circuiting on that hedge spends the saving to buy a
    // weaker answer than the stage below already holds.
    const llm: PipelinePorts['llm'] = {
      classify: async () => ({ pSpam: 1, reasonCode: 'crypto_scam', evidence: null, cached: true })
    }
    const first = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), { llm })
    const repeated = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      llm, velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    })
    expect(first.action).toBe('ban')
    expect(repeated.action).toBe('ban')
    expect(repeated.needsVote, 'nobody should be asked twice about a settled text').toBe(false)
  })

  it('a blast still hands the message to whatever can read it', async () => {
    // The other half: falling through must reach the readers, not skip them.
    let read = 0
    await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) },
      moderation: { check: async () => { read += 1; return modClean } }
    })
    expect(read).toBe(1)
  })

  it('REGRESSION: a resemblance does not speak over a reader either', async () => {
    // The same defect as above, in the stage next door — a nearest neighbour
    // recognises a shape and never reads the words. Production 2026-08-02, one
    // campaign in one chat inside twelve minutes: six copies removed by the
    // classifier, the signature store and the ban feed, then a seventh variant
    // matched a neighbour and came back as delete + a question the chat
    // resolved in nine seconds.
    const llm: PipelinePorts['llm'] = {
      classify: async () => ({ pSpam: 1, reasonCode: 'job_scam', evidence: null, cached: false })
    }
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      llm, vectors: { search: async () => ({ similarity: 0.95, status: 'confirmed', vectorId: 'v1' }) }
    })
    expect(v.action).toBe('ban')
    expect(v.needsVote).toBe(false)
  })

  it('a port that cannot tell is read as a wave, never as a blast', async () => {
    // `singleAuthor` absent means the port does not know, and the weaker of the
    // two signals is the honest reading of not knowing.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true }) }
    })
    const names = v.signals.map((s) => s.name)
    expect(names).toContain('velocity_wave')
    expect(names).not.toContain('velocity_repeats')
  })

  it('a confirmed neighbour decides once the removal is already earned', async () => {
    // The stage still decides — but only when its verdict is the real one. With
    // the sender-removal bar already cleared by evidence that read the text,
    // there is nothing for a later stage to add and the short-circuit is free.
    const ports: PipelinePorts = {
      vectors: { search: async () => ({ similarity: 0.95, status: 'confirmed', vectorId: 'v1' }) }
    }
    const earned = { ...spamText, text: 'Потріб​ні люди на склад, оплата щодня, пишіть в особисті' }
    const v = await evaluateMessage(makeInput({ msg: earned, user: newcomer }), ports)
    expect(mayRemoveSender(v.signals)).toBe(true)
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
    //
    // The stage no longer labels this verdict its own (2026-08-02): when the
    // bar bites, the resemblance is handed on as a signal and whatever can read
    // the text decides. With nothing here that can, the score path lands in the
    // same place by weighing the same fact — which is the point. The claim worth
    // pinning was never `decidedBy`, it is that a likeness does not take a
    // person away.
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
    let calls = 0
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Приват, інтим послуги, пиши в лічку' },
      user: { ...newcomer, joinedAgoSeconds: 30 },
      enrichment: { avatarBase64: 'ZmFrZQ==' }
    }), {
      ...avatarPort({ sexual: 0.99 }),
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.97, reasonCode: 'escort_promo', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toBeGreaterThan(0)
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

  it('grey-zone score escalates to the LLM', async () => {
    let calls = 0
    const ports: PipelinePorts = {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.92, reasonCode: 'crypto_promo', evidence: 'заробляти на криптовалюті', cached: false }
        }
      }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(calls).toBe(1)
    expect(v.decidedBy).toBe('llm')
    expect(v.reasonCode).toBe('crypto_promo')
    expect(['mute', 'ban']).toContain(v.action)
  })

  it('an "unsure" verdict is not enforcement: 0.5 lands in the grey band', async () => {
    // Used to be "uncertain cheap verdict escalates to the strong tier". With one
    // classifier there is no second opinion, so what protects the sender is the
    // policy ladder: 0.5 is below the delete threshold in every preset.
    let calls = 0
    const ports: PipelinePorts = {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.5, reasonCode: 'unsure', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(calls).toBe(1)
    expect(isEnforcementAction(v.action)).toBe(false)
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

  it('which model answered is recorded on the verdict', async () => {
    // The model comes from the environment, so it changes with no deploy and
    // left no trace: 226k stored verdicts, not one of which says who judged it
    // (2026-08-07, asked whether a newly routed model was better).
    const ports: PipelinePorts = {
      llm: {
        classify: async () => ({
          pSpam: 0.95, reasonCode: 'job_scam', evidence: null, cached: false, model: 'vendor/some-model'
        })
      }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(v.meta['llmModel']).toBe('vendor/some-model')
  })

  it('a port that does not report its model still produces a verdict', async () => {
    const ports: PipelinePorts = {
      llm: { classify: async () => ({ pSpam: 0.95, reasonCode: 'job_scam', evidence: null, cached: false }) }
    }
    const v = await evaluateMessage(greyZoneInput(), ports)
    expect(v.meta['llmModel']).toBeUndefined()
    expect(v.decidedBy).toBe('llm')
  })
})

describe('evaluateMessage — an act members also perform (2026-08-07 audit)', () => {
  const promoInput = (): EvaluationInput => makeInput({
    msg: { text: 'Народ, я тут групу створила, заходьте хтось, треба людей' },
    user: newcomer
  })

  const llmSaying = (reasonCode: string): PipelinePorts => ({
    llm: { classify: async () => ({ pSpam: 0.98, reasonCode, evidence: null, cached: false }) }
  })

  it('channel_promo alone deletes and asks the chat, never removes the sender', async () => {
    // Production 2026-08-07 16:44:38: a 30-day ban at 0.98 with
    // `contentEvidence: 0`, for a member asking people to join a group they had
    // just made. 12 of the 52 known false positives in the fortnight before it
    // carried this one code.
    const v = await evaluateMessage(promoInput(), llmSaying('channel_promo'))
    expect(removesSender(v.action)).toBe(false)
    expect(v.action).toBe('delete')
    expect(v.needsVote).toBe(true)
    expect(v.banDurationSeconds).toBeNull()
  })

  it('the reason code survives the ceiling', async () => {
    // `capUnearnedRemoval` rewrites the code to `content_unconfirmed`, which is
    // how three of six reversals in the replay lost the name of the stage that
    // produced them. The punishment was too much; the reason still stands.
    const v = await evaluateMessage(promoInput(), llmSaying('channel_promo'))
    expect(v.reasonCode).toBe('channel_promo')
    expect(v.meta['cappedImitable']).toBe('channel_promo')
    expect(v.meta['cappedFrom']).toBe('ban')
  })

  it('no captcha: the question cannot separate anybody here', async () => {
    // A captcha asks whether the sender is human, and these codes name acts
    // humans perform — so the answer is known before it is asked.
    const v = await evaluateMessage(promoInput(), llmSaying('channel_promo'))
    expect(v.requireCaptcha).toBeFalsy()
  })

  it('flood over ordinary chat does not mute either', async () => {
    // Production 2026-08-07 16:42:50: muted for `flood` over five lines of
    // conversation, carrying `established_user` and `is_reply`.
    const v = await evaluateMessage(promoInput(), llmSaying('flood'))
    expect(removesSender(v.action)).toBe(false)
  })

  it('a job scam is NOT held back — the act itself is the finding', async () => {
    const v = await evaluateMessage(promoInput(), llmSaying('job_scam'))
    expect(removesSender(v.action)).toBe(true)
    expect(v.meta['cappedImitable']).toBeUndefined()
  })

  it('corroborating message evidence lifts the ceiling', async () => {
    // The ceiling exists because intent is unobservable on these acts. Firsthand
    // evidence about the message is what turns the guess into a finding, so once
    // `mayRemoveSender` holds (2.0 units) the verdict stands as the classifier
    // gave it. Deliberately assembled from a phone number and copies we watched
    // arrive, not from a private invite link — that one has a deterministic rule
    // of its own and would never reach the classifier.
    const corroborated = makeInput({
      msg: { text: 'Народ, заходьте в групу, пишіть на 067-000-00-00, є що обговорити' },
      user: newcomer
    })
    const v = await evaluateMessage(corroborated, {
      ...llmSaying('channel_promo'),
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    })
    expect(contentEvidence(v.signals).total).toBeGreaterThanOrEqual(2)
    expect(mayRemoveSender(v.signals)).toBe(true)
    expect(removesSender(v.action)).toBe(true)
    expect(v.meta['cappedImitable']).toBeUndefined()
  })

  /**
   * ...unless the chat already knows the sender. Production 2026-08-08 08:58:
   * `private_invite_link` + `promo_in_message_link` = 3.0 units, comfortably over
   * the bar, banned an `established_user`, and an admin undid it in 31 seconds.
   * Over the fortnight, standing tripled the reversal rate on these codes.
   */
  describe('and the sender is not a stranger', () => {
    const corroboratedBy = (user: Partial<UserSnapshot>): EvaluationInput => makeInput({
      msg: { text: 'Народ, заходьте в групу, пишіть на 067-000-00-00, є що обговорити' },
      user
    })
    const withVelocity: PipelinePorts = {
      ...llmSaying('channel_promo'),
      velocity: { check: async () => ({ exceeded: true, singleAuthor: true }) }
    }
    /**
     * Chatty, and known for less than a week — which is the whole population
     * this branch is about. `established_user` is earned by volume alone (50
     * messages), while the established-regular exempt additionally wants 7 days
     * of local tenure, so between the two lies a person who has already talked a
     * lot and whom the exempt does not yet wave through. Both reversals of
     * 2026-08-07/08 sat exactly there: 172 messages first seen 3 days earlier,
     * and 98 messages first seen the same day.
     */
    const established = { messagesInChat: 40, messagesGlobal: 172, localAgeDays: 3 }

    it('standing outranks message evidence on an imitable code', async () => {
      const v = await evaluateMessage(corroboratedBy(established), withVelocity)
      expect(v.signals.some((s) => s.name === 'established_user')).toBe(true)
      // The evidence bar is met — and deliberately not the last word here.
      expect(mayRemoveSender(v.signals)).toBe(true)
      expect(removesSender(v.action)).toBe(false)
      expect(v.action).toBe('delete')
      expect(v.needsVote).toBe(true)
      expect(v.meta['cappedStanding']).toBe(true)
      expect(v.meta['cappedImitable']).toBe('channel_promo')
    })

    it('being caught before spends the standing', async () => {
      // Volume earns standing; being caught twice spends it. Four of every five
      // long-standing accounts punished on an imitable code had already been
      // caught spamming twice (20 of 25 over the fortnight), so an unconditional
      // shield would mostly be shielding repeat offenders — even though, on the
      // stored data, every one of those 20 was below the evidence bar and the
      // ceiling held it anyway. This asserts the guard, not a past outcome.
      const v = await evaluateMessage(
        corroboratedBy({ ...established, spamDetections: 3 }), withVelocity
      )
      expect(v.signals.some((s) => s.name === 'prior_spam_detections')).toBe(true)
      expect(removesSender(v.action)).toBe(true)
      expect(v.meta['cappedStanding']).toBeUndefined()
    })

    it('standing does not shield a code that names the act itself', async () => {
      // The ceiling is about acts with two readings. Nobody recruits for a fake
      // job by accident, however long they have been here.
      const v = await evaluateMessage(corroboratedBy(established), {
        ...withVelocity, ...llmSaying('job_scam')
      })
      expect(removesSender(v.action)).toBe(true)
      expect(v.meta['cappedStanding']).toBeUndefined()
    })

    it('cappedStanding marks only the branch where evidence was sufficient', async () => {
      // A stranger with no corroboration is capped too, by the original rule —
      // and must NOT be counted as a standing cap, or the next audit prices the
      // wrong thing.
      const v = await evaluateMessage(promoInput(), llmSaying('channel_promo'))
      expect(v.meta['cappedImitable']).toBe('channel_promo')
      expect(v.meta['cappedStanding']).toBeUndefined()
    })
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
  const shapeOnlySender = {
    msg: { text: 'Чи я не правий і таке можна зробити? Бо я не розбирався в цьому ще' },
    // messagesInChat kept below the exempt bar (10) so the soft-shape guard —
    // not the established-regular fast path — is what's under test here.
    user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 8 },
    enrichment: { bio: 'Мій канал: t.me/+abcdefghij', personalChannelId: 7777 }
  }
  /** The FP exactly as it happened, website bio and all. */
  const softShapeOver = {
    ...shapeOnlySender,
    enrichment: { ...shapeOnlySender.enrichment, bio: 'Мій сайт: example.com' }
  }

  it('the prod stack no longer reaches the ceiling at all (2026-08-25)', async () => {
    // The FP's own bio was a website, and a website in a bio was re-priced from
    // 1.2 to 0.3 once it was measured: −0.14 log-odds against a bio with no link,
    // 95% CI [−0.72, +0.44]. So one of the four signals that pushed this over the
    // ceiling was being charged for a property carrying no information, and this
    // particular message can no longer be deleted blind for want of a guard.
    //
    // The guard is still needed — this asserts the FP is gone, not the class.
    const v = await evaluateMessage(makeInput(softShapeOver), {})
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['sleeper_awakened', 'new_globally', 'promo_in_bio', 'personal_channel']))
    expect(v.pSpam).toBeLessThan(0.75)
  })

  it('four signals about WHO still score above 0.75 (regression anchor)', async () => {
    // Same four signals, same absence of anything read from the message — with
    // the one bio weight that IS earned (a private invite, 62.5% known-bad over
    // 907 stored bios) standing in for the one that was not. This is the stack
    // the guard exists for.
    const v = await evaluateMessage(makeInput(shapeOnlySender), {})
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['sleeper_awakened', 'new_globally', 'private_invite_in_bio', 'personal_channel']))
    expect(v.pSpam).toBeGreaterThan(0.75)
  })

  it('escalates to the LLM even above the grey ceiling, and the LLM clears it', async () => {
    let calls = 0
    const ports: PipelinePorts = {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.05, reasonCode: 'legit_question', evidence: null, cached: false }
        }
      }
    }
    const v = await evaluateMessage(makeInput(shapeOnlySender), ports)
    expect(calls).toBe(1)
    expect(v.decidedBy).toBe('llm')
    expect(v.action).toBe('none')
  })

  it('without an LLM, soft-shape-only never enforces — observe, not delete', async () => {
    const v = await evaluateMessage(makeInput(shapeOnlySender), {})
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
      ...shapeOnlySender,
      msg: { text: 'подивись обовʼязково тут, пиши +380671234567' }
    }), {})
    expect(['delete', 'mute', 'ban']).toContain(v.action)
  })
})

describe('evaluateMessage — an advertised profile behind an empty message (2026-08-25 FN)', () => {
  // The mirror image of the two suites above, and the class they left open: a
  // new account posts a single heart, which carries nothing to read, while its
  // profile advertises a closed channel. Three separate things conspired to
  // return `none`:
  //
  //   - the heart earned `emoji_only` (−1.5) AND `short_message` (−0.8) for the
  //     one property of being a heart;
  //   - the invite in the bio was priced like an ordinary website (1.2);
  //   - the avatar was not sexual to the moderation provider at all (0.001), so
  //     no NSFW signal was ever going to fire.
  //
  // Nothing here reads the message, so nothing here may remove anybody: the
  // ceiling is a reversible human check, and the suite asserts that too.
  const advertisedProfile = {
    msg: { text: '💗' },
    user: { ...newcomer, joinedAgoSeconds: 3600, avatars: { count: 1, latestSetDaysAgo: 5 } },
    enrichment: { bio: 'Мій каналчик тут t.me/+abcdefghij' }
  }

  it('asks the sender to prove they are human instead of ignoring them', async () => {
    const v = await evaluateMessage(makeInput(advertisedProfile), {})
    expect(v.action).toBe('captcha')
    expect(v.signals.map((s) => s.name)).toEqual(expect.arrayContaining(
      ['emoji_only', 'private_invite_in_bio']))
    // Paid once for holding nothing to read, not twice.
    expect(v.signals.map((s) => s.name)).not.toContain('short_message')
  })

  /**
   * Production shape: the same advertised profile posting AS a channel, which
   * is the delivery method that advertises a channel by construction. The
   * captcha's button carries the sender id and a tap carries a user id, so the
   * question is unanswerable — and the executor's `mute` on a channel is a ban.
   */
  it('does not ask a channel identity to prove it is human', async () => {
    const v = await evaluateMessage(makeInput({
      ...advertisedProfile,
      user: { ...advertisedProfile.user, id: -1001234567890 }
    }), {})
    expect(v.action).toBe('observe')
  })

  it('never removes anyone on a profile alone', async () => {
    const v = await evaluateMessage(makeInput(advertisedProfile), {})
    expect(removesSender(v.action)).toBe(false)
    // The bio is shape by construction, so it cannot reach either evidence bar
    // however heavy it gets.
    expect(contentEvidence(v.signals).strongest).toBe(0)
    expect(mayRemoveSender(v.signals)).toBe(false)
  })

  it('the innocent version of the same profile is left alone', async () => {
    // A website in a bio was measured at −0.14 log-odds against no link at all,
    // so the sender who merely links their homepage keeps meeting nothing. This
    // is the half of the change that REMOVES friction, and it is the half that
    // would break first if the weight were ever tuned to chase a threshold.
    for (const bio of ['Мій сайт example.com', null]) {
      const v = await evaluateMessage(
        makeInput({ ...advertisedProfile, enrichment: { bio } }), {})
      expect(v.action, bio ?? 'no bio').toBe('observe')
    }
  })

  it('reading the destination adds to the case, and only when it says something', async () => {
    // The bio_link wire: `ChannelPreview` has carried this source since it was
    // introduced and nothing produced one until 2026-08-25, so the strongest
    // fact reachable about this class — what the advertised channel says it is
    // — was never asked for. Note the asymmetry, which is deliberate: today
    // this can only accuse. `private_invite_in_bio` is raised on the link's
    // shape whatever is behind it, so an ordinary community changes nothing.
    const withChannel = async (channel: Partial<ChannelPreview> | null) =>
      evaluateMessage(makeInput({
        ...advertisedProfile,
        enrichment: {
          ...advertisedProfile.enrichment,
          linkedChannels: channel === null ? [] : [{
            source: 'bio_link', title: 'Канал', description: null,
            subscribers: null, avatarBase64: null, ...channel
          } as ChannelPreview]
        }
      }), {})

    const bare = await withChannel(null)
    const advert = await withChannel({ description: 'умови wa.me/79991234567' })
    const community = await withChannel({ title: 'Кулінарія', description: 'рецепти щодня' })

    expect(advert.signals.map((s) => s.name)).toContain('promo_in_linked_channel')
    expect(advert.pSpam).toBeGreaterThan(bare.pSpam)
    expect(community.pSpam).toBe(bare.pSpam)

    // Still a question, not a punishment: the destination is the profile's
    // self-description, so it is capped with the rest of `profile_promo` and
    // reaches no evidence bar.
    expect(advert.action).toBe('captcha')
    expect(mayRemoveSender(advert.signals)).toBe(false)
  })

  it('someone the chat already knows is not asked, invite or no invite', async () => {
    const v = await evaluateMessage(makeInput({
      ...advertisedProfile,
      user: { messagesInChat: 60, messagesGlobal: 300, localAgeDays: 400 }
    }), {})
    expect(v.action).toBe('none')
    expect(v.reasonCode).toBe('established_regular')
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
    // The FP's own bio was a website. Re-priced from 1.2 to 0.3 on 2026-08-25
    // once measured (−0.14 log-odds against a bio with no link at all), that
    // stack no longer reaches the ceiling — see the sibling suite, which asserts
    // exactly that. What this suite is for is the crumb of message evidence that
    // let the guard stand down, so the bio here carries the one weight that IS
    // earned (a private invite) and the shape stack keeps its historical height.
    enrichment: { bio: 'Мій канал: t.me/+abcdefghij', personalChannelId: 7777 }
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
    let calls = 0
    const v = await evaluateMessage(makeInput(conversational), {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.03, reasonCode: 'small_talk', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toBe(1)
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
    // The rung it was capped DOWN FROM is what matters, not which rung: the
    // claim is that arithmetic over signals wanted the sender gone and the cap
    // refused. Pinning 'kick' would make this test a hostage of weight tuning.
    expect(removesSender(v.meta['cappedFrom'] as VerdictAction)).toBe(true)
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

  /**
   * 2026-08-27, an experiment with a first reading.
   *
   * This ceiling already concedes the evidence did not reach the bar for taking
   * the PERSON away. On a reply it did not reach the bar for taking the MESSAGE
   * away either, and deleting is the one act a correction cannot undo. Of the
   * 73 deletions the bucket produced over the fortnight, the 4 that were
   * replies were reversed 3 times — 75%, against 2 of the other 69 at 2.9% —
   * and nothing else in it separates: all 73 carry `new_globally`, 65 carry
   * `sleeper_awakened`, and the profile signals leave the rate where they are.
   *
   * The fixture is the production shape: a bare invite link and nothing else,
   * posted in answer to somebody, from an account old enough to have woken up.
   */
  const inviteInAnswer = {
    msg: {
      text: 'https://t.me/+GTNaTfZj9eUwN2Fi',
      urls: [{ visible: 't.me/+GTN', target: 'https://t.me/+GTNaTfZj9eUwN2Fi', hidden: false }],
      replyTo: { authorId: 9, isSelf: false, ageSeconds: 60, textPreview: 'де група?' }
    },
    user: { predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 3, messagesInChat: 2 }
  }

  it('an answer to somebody is gated instead of deleted', async () => {
    const v = await evaluateMessage(makeInput(inviteInAnswer), {})
    expect(v.reasonCode).toBe('content_unconfirmed')
    expect(removesSender(v.meta['cappedFrom'] as VerdictAction) ||
      v.meta['cappedFrom'] === 'mute').toBe(true)
    // The message survives. The sender still answers for themselves, and the
    // chat is still asked — the branch withholds the one act nothing can undo,
    // not the consequence.
    expect(v.action).toBe('captcha')
    expect(v.needsVote).toBe(true)
    expect(v.meta['cappedReplyReason']).toBe('private_invite_new')
  })

  it('and is only observed where no gate could actually reach them', async () => {
    // A prompt nobody can receive is a gate that never closes, so the branch
    // asks `mayAskCaptcha` rather than reading the chat's setting alone.
    const v = await evaluateMessage(
      makeInput({ ...inviteInAnswer, policy: { captchaEnabled: false } }), {})
    expect(v.action).toBe('observe')
    expect(v.needsVote).toBe(true)
    expect(v.reasonCode).toBe('content_unconfirmed')
  })

  it('being caught before spends the answer, as everywhere else', async () => {
    const v = await evaluateMessage(makeInput({
      ...inviteInAnswer,
      user: { ...inviteInAnswer.user, spamDetections: 2 }
    }), {})
    expect(v.signals.some((sig) => sig.name === 'prior_spam_detections')).toBe(true)
    expect(v.action).not.toBe('captcha')
    expect(v.meta['cappedReplyReason']).toBeUndefined()
  })

  it('the same message with nobody to answer is still deleted', async () => {
    // The branch turns on the reply and nothing else: strip it and the bucket
    // behaves exactly as it did before.
    const v = await evaluateMessage(makeInput({
      ...inviteInAnswer,
      msg: { text: inviteInAnswer.msg.text, urls: inviteInAnswer.msg.urls }
    }), {})
    expect(v.signals.some((sig) => sig.name === 'is_reply')).toBe(false)
    expect(v.reasonCode).toBe('content_unconfirmed')
    expect(v.action).toBe('delete')
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

    let calls = 0
    const v = await evaluateMessage(makeInput(jobAd), {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.1, reasonCode: 'legit_share', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toBe(1)
    expect(v.action).toBe('none')
  })

  it('REGRESSION: a resemblance plus one fact is not two facts', async () => {
    // Production, 2026-08-01 13:22: an appeal for help carrying a phone number
    // was BANNED for thirty days by the scoring path, `decidedBy: score`, with
    // no `llm` in the port timings — nothing read it. phone_number 1.2 +
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

    let calls = 0
    const asked = await evaluateMessage(makeInput(appeal), {
      ...nearNeighbour,
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.05, reasonCode: 'legit_share', evidence: null, cached: false }
        }
      }
    })
    expect(calls).toBe(1)
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

  /**
   * The same profile, and the message that class actually sends.
   *
   * Production 2026-08-24, two accounts inside one afternoon: a first message of
   * three words under a channel post ("вот так вот"), an explicit avatar, and a
   * personal channel whose description is a list of services. Every stage did
   * exactly what it was built to do — the abstain gate found nothing to judge
   * and said `observe` at pSpam 0 — and the account went on advertising itself
   * to the chat by being in it. The avatar had already been downloaded and sent
   * to the moderation API by then; the answer arrived after the gate had
   * returned, so it was paid for and discarded.
   *
   * The distinction from the test above is the whole rule: there, somebody with
   * a promotional profile joined the conversation and their sentence is judged
   * like anyone else's. Here there is no sentence. What arrived was the profile.
   */
  /**
   * Cost, which is a correctness property here rather than an optimisation: the
   * profile screen is three paid round-trips, and an account already condemned
   * by a ban database says nothing about a picture. Production runs 35 008
   * deterministic verdicts in three days.
   */
  it('does not pay for a profile screen when a free rule already decided', async () => {
    let calls = 0
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: { ...newcomer, externalBan: { banned: true, bannedAt: new Date(), offenses: 1, sources: ['cas' as const] } },
      enrichment: { avatarBase64: 'AAAA', personalChannelId: 42 }
    }), {
      moderation: { check: async () => { calls += 1; return modResult({ sexual: 0.93 }) } }
    })
    expect(v.ruleId).toBe('external_ban_new')
    expect(calls).toBe(0)
  })

  it('acts on a profile that is the whole advert when the message carries nothing', async () => {
    const filler = {
      msg: { text: 'вот так вот' },
      user: newcomer,
      enrichment: {
        personalChannelId: 4242,
        linkedChannels: [{
          source: 'personal_channel' as const,
          title: 'моя приватка',
          description: 'фетиші, приват, умови в лс',
          subscribers: 2,
          avatarBase64: 'AAAA'
        }]
      }
    }
    const explicit: PipelinePorts = {
      moderation: { check: async () => modResult({ sexual: 0.93 }) }
    }

    const v = await evaluateMessage(makeInput(filler), explicit)
    expect(v.ruleId).toBe('nsfw_promo_profile')
    expect(isEnforcementAction(v.action)).toBe(true)
    // About the account, so the message-evidence bar must not cap it — asking
    // whether these three words earned a removal would always answer no.
    expect(v.meta['cappedFrom']).toBeUndefined()
  })

  /**
   * The tier below the rule, and the reason it exists.
   *
   * Measured 2026-08-24 against the real avatar of a production promo account:
   * `sexual` 0.373, the provider's own `flagged` false — under a profile bar
   * written to ask "is this pornography". The account was one anyway. But honest
   * people also put suggestive pictures on their profiles, alongside self-harm
   * awareness and hunting knives, so this may never be a verdict. A captcha is
   * the shape of "strong, not decisive": nothing is removed, and the sender
   * settles it with one tap that a script cannot make.
   */
  /**
   * The branch still works where it should: one fact that is 1.5 on its own.
   */
  it('still asks when the bio holds a private invite', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: '💗' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { bio: 'мій канал t.me/+AAAAAAAAAAAAAAAA' }
    }), {})
    expect(v.reasonCode).toBe('low_information_profile')
    expect(v.action).toBe('captcha')
  })

  it('asks a suggestive-profile newcomer to prove they are human', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { avatarBase64: 'AAAA', personalChannelId: 42 }
    }), { moderation: { check: async () => modResult({ sexual: 0.42 }, false) } })
    expect(v.signals.map((s) => s.name)).toContain('suggestive_profile_media')
    expect(v.action).toBe('captcha')
    expect(v.reasonCode).toBe('low_information_profile')
  })

  /**
   * A question we cannot deliver is not an answer.
   *
   * Production 2026-09-01: the same shape as the test above — `sexual 0.781`
   * avatar, a linked channel, four minutes old — posting three harmless lines
   * into a discussion group under a channel post. Arithmetic said 0.711 and
   * `profileHasCase` was true, so the branch owed it a question. It could not
   * be delivered: a commenter is frequently not a member of the discussion
   * group and the whisper is the captcha's only delivery, so `mayAskCaptcha`
   * refused. The branch then fell through to `pSpam: 0` / `low_information` /
   * `observe` — the same row a message nobody found anything in produces.
   *
   * Undeliverability changes neither the evidence nor its authority. It cannot
   * turn suspicion into innocence, and it must not turn it into a conviction
   * either: `observe` remains the ceiling. What changes is the record. Measured
   * over the 7 days to 2026-09-01: 20 accounts carrying
   * `suggestive_profile_media` fell into the silent path, 7 of them were later
   * reported BY PEOPLE and 4 eventually banned — not one of them caught by this
   * branch, and none of the 20 distinguishable in the store from a genuinely
   * empty message.
   */
  it('says why it went quiet when the question cannot be delivered', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: { ...newcomer, isParticipant: false },
      policy: { captchaEnabled: true },
      enrichment: { avatarBase64: 'AAAA', personalChannelId: 42 }
    }), { moderation: { check: async () => modResult({ sexual: 0.42 }, false) } })

    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('low_information_profile_unreachable')
    expect(v.meta['captchaBlockedBy']).toBe('sender_not_participant')
    // The score the profile actually earned, not the zero that says "nobody
    // found anything". A pSpam of 0 here is a false statement about evidence.
    expect(v.pSpam).toBeGreaterThan(PRESET_THRESHOLDS.standard.grey)
  })

  /**
   * Deserving a question and being able to ask one are two facts, and they were
   * being read off one variable.
   *
   * `deserved` came from `policyFor(...).action`, and `decideAction` already
   * folds deliverability in: at a grey-band score it returns `captcha` when the
   * gate is open and `observe` when it is shut. So for every profile case that
   * landed IN the band — not above it — an undeliverable captcha silently
   * unmade the finding that the score deserved one. The two questions are now
   * asked separately, and the answer to the first is recorded either way.
   */
  it('a grey-band profile case still deserves the question it cannot be asked', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: { ...newcomer, isParticipant: false },
      policy: { captchaEnabled: true },
      enrichment: { avatarBase64: 'AAAA' }
    }), { moderation: { check: async () => modResult({ sexual: 0.42 }, false) } })

    expect(v.meta['profileQuestionDeserved']).toBe(true)
    expect(v.meta['captchaAllowed']).toBe(false)
    expect(v.action).toBe('observe')
  })

  /**
   * A lookup that failed and a refusal that named the person are different
   * facts, and the audit has to be able to tell them apart: `false` issues
   * nothing and leaves no row anywhere, while an unanswered lookup issues a
   * captcha that dies at delivery and DOES leave one (`undeliverable`, 28 of
   * 74 issued network-wide in the week to 2026-09-01). Recorded as a word
   * rather than as an absent key, because a missing field reads as "we did not
   * look".
   */
  it('records an unanswered membership lookup as unknown, not as a refusal', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: { ...newcomer, isParticipant: null },
      policy: { captchaEnabled: true },
      enrichment: { avatarBase64: 'AAAA', personalChannelId: 42 }
    }), { moderation: { check: async () => modResult({ sexual: 0.42 }, false) } })

    expect(v.action).toBe('captcha')
    expect(v.meta['senderIsParticipant']).toBe('unknown')
  })

  /**
   * The same nothing, six times, is not nothing.
   *
   * Production, 2026-08-25: an account whose bio held a private invite posted
   * one heart emoji into one chat six times across twelve hours. All six were
   * judged as if each were the first — pSpam 0, `observe` — because the gaps
   * are longer than every window this pipeline owns, and the one window long
   * enough refuses to key on a text that normalises to nothing.
   *
   * The repetition does not decide anything here. It removes the excuse: a
   * message that has arrived before is no longer "too little to judge", so the
   * ladder runs and the classifier gets to read it. That is the difference
   * asserted below — not the verdict, but who is allowed to reach one.
   */
  it('stops calling it unjudgeable once the account has sent it before', async () => {
    const repeats: PipelinePorts = {
      moderation: { check: async () => modClean },
      velocity: {
        check: async (_input, options) => (
          options?.countExactWhenTemplateUnusable === true
            ? { exceeded: true, singleAuthor: true, evidence: '6 copies in 1 chats from 1 accounts within window' }
            : { exceeded: false }
        )
      },
      llm: { classify: async () => ({ pSpam: 0.9, reasonCode: 'channel_promo', evidence: null, cached: false }) }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: '💗' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { bio: 'мій канал t.me/+AAAAAAAAAAAAAAAA' }
    }), repeats)
    expect(v.signals.map((s) => s.name)).toContain('velocity_repeats')
    // The gate no longer answers; something that read the message does.
    expect(v.reasonCode).not.toBe('low_information')
    expect(v.decidedBy).not.toBe('abstain')
  })

  /**
   * And the guard that keeps the rule from eating ordinary people: an account
   * whose profile said nothing is never asked about repetition at all, so the
   * member who sends "👍" all afternoon is judged exactly as before.
   */
  it('never counts repetition for a sender whose profile said nothing', async () => {
    let askedExact = false
    const ports: PipelinePorts = {
      moderation: { check: async () => modClean },
      velocity: {
        check: async (_input, options) => {
          if (options?.countExactWhenTemplateUnusable === true) askedExact = true
          return { exceeded: false }
        }
      }
    }
    const v = await evaluateMessage(makeInput({
      msg: { text: '👍' }, user: newcomer, policy: { captchaEnabled: true }
    }), ports)
    expect(askedExact).toBe(false)
    expect(v.signals.map((s) => s.name)).not.toContain('velocity_repeats')
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  /**
   * The first captcha this branch ever issued in production, and why it must
   * not have been issued.
   *
   * 2026-08-25, one word of Ukrainian under a channel post. The entire case
   * against the account was that we had not met it: a dormant account
   * (`sleeper_awakened` 1.2), new to us (0.8), new to the chat (0.4), editing
   * its message (0.2) — no bio, no avatar, no linked channel, nothing the
   * branch is named after. Those stack to exactly the grey band, and the
   * account was then muted and its message deleted for not tapping a button it
   * could never have received.
   *
   * `newness` is a correlated group by design — one fact about an account
   * counted three ways — which is why it has a cap that keeps it from reaching
   * a verdict. This asserts it cannot reach a QUESTION either.
   */
  it('does not ask a stranger to prove themselves for being a stranger', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'Каракіс' },
      user: newcomer,
      policy: { captchaEnabled: true }
    }), { moderation: { check: async () => modClean } })
    const names = v.signals.map((s) => s.name)
    expect(names).toContain('new_globally')
    // Nothing about the profile spoke, so there is nothing to ask about.
    expect(v.action).not.toBe('captcha')
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  /**
   * The case this branch existed for and could not reach.
   *
   * Production, 2026-08-25: an account posted "💗" five times into one chat over
   * ten hours, its bio holding a private invite (it swapped a plain promo link
   * for the invite between the second and third). Every one of the five was
   * `observe`, pSpam 0. Two separate faults had to line up for that:
   * `emoji_only` (-1.5) cancelled the invite (+1.5) exactly, and the branch then
   * compared the policy action to 'captcha' for equality — so once the score DID
   * clear the band, it cleared it into `delete`/`kick` and was dropped.
   */
  it('asks the emoji-poster whose bio advertises, and never more than asks', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: '💗' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { bio: 'мій канал t.me/+AAAAAAAAAAAAAAAA' }
    }), { moderation: { check: async () => modClean } })
    const names = v.signals.map((s) => s.name)
    expect(names).toContain('private_invite_in_bio')
    expect(names).toContain('emoji_only')
    expect(v.action).toBe('captcha')
    expect(v.reasonCode).toBe('low_information_profile')
    // The discount was withheld, and the record says which one — otherwise a
    // captcha earned by this rule is indistinguishable from one the arithmetic
    // reached on its own.
    expect(v.meta['suspendedDiscounts']).toBe('emoji_only')
  })

  /**
   * The ceiling is structural, not a threshold: the score here is well past the
   * removal bar and the outcome is still a question, because no stage in this
   * branch read the message.
   *
   * (An explicit avatar on top of the bio promo is deliberately NOT the case
   * used: that combination is caught by a deterministic rule further up and
   * never reaches this branch at all — which is correct, and is why the rule
   * exists.)
   */
  it('never enforces out of the low-information branch, however high the score', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: '💗' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { bio: 'мій канал t.me/+AAAAAAAAAAAAAAAA' }
    }), { moderation: { check: async () => modClean } })
    expect(isEnforcementAction(v.action)).toBe(false)
    expect(v.action).toBe('captcha')
    // The arithmetic asked for more than a captcha and was held to one.
    expect(Number(v.meta['scorePSpam'])).toBeGreaterThan(PRESET_THRESHOLDS.standard.delete)
  })

  /**
   * The discount is suspended, not deleted. A silent message from a sender whose
   * profile says nothing keeps every bit of the benefit of the doubt — which is
   * what stops this from becoming a tax on everyone who writes one word.
   */
  it('keeps the discount when the profile carries no charge', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: '💗' },
      user: newcomer,
      policy: { captchaEnabled: true }
    }), { moderation: { check: async () => modClean } })
    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('low_information')
    expect(v.meta['suspendedDiscounts']).toBeUndefined()
  })

  /**
   * A weak profile hint is not a charge. `suggestive_profile_media` (0.8) and
   * `personal_channel` (0.5) sit below `DECISIVE_MIN_WEIGHT` deliberately: they
   * are grounds to look closer, and the sender keeps the short-message discount.
   * Measured 2026-08-25 — suspending on those instead produced `delete` and
   * `kick` on "Усьо", "?" and "Привіт :)".
   */
  it('does not suspend the discount for a sub-threshold profile hint', async () => {
    const v = await evaluateMessage(makeInput({
      msg: { text: 'ага' },
      user: newcomer,
      policy: { captchaEnabled: true },
      enrichment: { personalChannelId: 42 }
    }), { moderation: { check: async () => modClean } })
    expect(v.meta['suspendedDiscounts']).toBeUndefined()
  })

  it('does not ask an ordinary newcomer anything', async () => {
    // The gate handles 4696 messages a week in production; a captcha for each
    // would be the bot shouting at its own chats.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: newcomer,
      policy: { captchaEnabled: true }
    }), { moderation: { check: async () => modClean } })
    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('low_information')
  })

  it('never removes anything from the unreadable-message path', async () => {
    // Shape heavy enough that arithmetic alone would delete. Nothing here has
    // read the message, so the strongest thing that may come out is a question.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: { ...newcomer, reputationStatus: 'suspicious' as const },
      policy: { captchaEnabled: false },
      enrichment: { bio: 'заходь t.me/+abcdefgh', avatarBase64: 'AAAA', personalChannelId: 42 }
    }), { moderation: { check: async () => modResult({ sexual: 0.42 }, false) } })
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  it('does not charge twice for one picture', async () => {
    // Explicit already said everything the suggestive tier would have said.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: newcomer,
      enrichment: { avatarBase64: 'AAAA' }
    }), { moderation: { check: async () => modResult({ sexual: 0.93 }) } })
    const names = v.signals.map((s) => s.name)
    expect(names).toContain('nsfw_avatar')
    expect(names).not.toContain('suggestive_profile_media')
  })

  it('leaves the same empty message alone when the profile is ordinary', async () => {
    // The other side of the rule: three words from a newcomer with nothing
    // remarkable about them is the abstain gate's ordinary business.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: newcomer
    }), { moderation: { check: async () => modClean } })
    expect(v.action).toBe('observe')
    expect(v.reasonCode).toBe('low_information')
  })

  it('does not act on an explicit profile that advertises nothing', async () => {
    // NSFW alone is not the rule: an explicit avatar with no channel, no promo
    // bio and nothing to click is somebody's taste in pictures, not a shopfront.
    const v = await evaluateMessage(makeInput({
      msg: { text: 'вот так вот' },
      user: newcomer,
      enrichment: { avatarBase64: 'AAAA' }
    }), { moderation: { check: async () => modResult({ sexual: 0.93 }) } })
    expect(v.ruleId).not.toBe('nsfw_promo_profile')
    expect(isEnforcementAction(v.action)).toBe(false)
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

  it('records the evidence figure on a verdict that returns before the score', async () => {
    /**
     * `contentEvidence` is what the log line calls "the quantity that licenses
     * enforcing without reading the message", and it was written at stage 6 —
     * so every stage that concludes earlier recorded no value for it at all.
     *
     * Production, 2026-08-27: of roughly 400 punitive decisions that day, 184
     * carried no figure — 142 deterministic, 29 signature, 5 forward, 6 at the
     * join screen, 2 on an ignored captcha. Nearly half the enforcement of a
     * day could not be priced against the number that is supposed to price it,
     * and this rule is the extreme case: the one that bans on zero evidence by
     * design, which is exactly the claim a reader would want to check.
     *
     * `finalize` is where it belongs for the reason `portErrors` and `portMs`
     * are already there — every verdict in the file passes through it, `none`
     * included, so a stage cannot be added later that forgets to say.
     */
    const v = await evaluateMessage(makeInput({
      user: { ...newcomer, externalBan: { banned: true, bannedAt: null, offenses: 3, sources: ['lols'] } }
    }), {})
    expect(v.ruleId).toBe('external_ban_new')
    expect(v.meta['contentEvidence']).toBe(contentEvidence(v.signals).total)
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
    // Our own arithmetic, with no third party's verdict behind it.
    const v = await evaluateMessage(makeInput({ msg: spamText, user: newcomer }), {
      velocity: { check: async () => ({ exceeded: true, evidence: '12 identical messages' }) }
    })
    expect(v.decidedBy).toBe('score')
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
    // the table, so the ladder stops at delete. The bio is only scaffolding to
    // reach the grey zone and be asked — it holds an invite rather than a
    // website because a website in a bio was measured at nothing on 2026-08-25.
    const v = await evaluateMessage(
      makeInput({
        msg: spamText,
        user: { messagesInChat: 9, messagesGlobal: 49, localAgeDays: 300 },
        enrichment: { bio: 'Пиши t.me/+abcdefghij' }
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

  it('an unofficial client cancels the exempt though it does not deny standing', async () => {
    // The two bars differ on purpose. `hasHardAccountVerdict` leaves this out —
    // it describes the sender's software, not a verdict on the sender, and a
    // heuristic belongs in the score at its own weight. But this path returns
    // before any signal is raised, so out here "leave it to the score" means
    // leaving it nowhere: the account Telegram's own infrastructure warns about
    // would be waved through unread, and a settled account that has changed
    // hands is the case the flag is most useful for. A discount can be argued
    // with; a bypass cannot.
    const v = await evaluateMessage(
      makeInput({ msg: wouldMatch, user: { messagesInChat: 50, messagesGlobal: 900, unofficialClientRisk: true } }),
      confirmedSignature)
    expect(v.reasonCode).not.toBe('established_regular')
    expect(v.signals.some((s) => s.name === 'unofficial_client_risk')).toBe(true)
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

/**
 * Reported 2026-08-20: a member the chat had known for a long time, removed for
 * advertising. The pipeline had every fact needed to know better and consulted
 * none of them, because standing was defined twice and the two definitions
 * disagreed.
 *
 * The exempt above accepts local standing OR global volume, and its own note
 * calls that OR deliberate. Every stage past it — the trust weight, both
 * ceilings, the clean rules — read `established_user`, which was earned by
 * global volume alone. And the exempt stands down for exactly the messages that
 * can cost somebody the chat, so the local half of the OR was reachable only
 * where nothing was at stake.
 *
 * The second half of the report is the clock. Tenure was measured from the first
 * time WE saw the account, which restarts at zero whenever our own record does.
 * Telegram's answer for this chat (channels.getParticipant.date) was already on
 * the snapshot and was read only to accuse — `just_joined` — so a gap in our
 * data read as a fact about the person, in the direction of a harsher action.
 */
describe('evaluateMessage — a quiet regular of one chat (2026-08-20 report)', () => {
  // A message whose OWN signals clear the sender-removal bar: that is what
  // stands the exempt down, so the exempt is absent from this whole suite by
  // construction. A masked link, an invite and a phone number — the shape of
  // the 2026-08-08 reversal, and the shape of an ordinary "come join us" too,
  // which is the entire difficulty.
  const promoMsg = {
    text: 'Заходьте до нас, там багато цікавого, пишіть на 067-000-00-00',
    urls: [
      { visible: 'наш сайт', target: 'https://example.com/promo', hidden: true },
      { visible: 'https://t.me/+AbCdEfGhIjKl', target: 'https://t.me/+AbCdEfGhIjKl', hidden: false }
    ]
  }
  const llmSaying = (reasonCode: string): PipelinePorts => ({
    llm: { classify: async () => ({ pSpam: 0.97, reasonCode, evidence: null, cached: false }) }
  })

  /** Long known here, barely known anywhere else — 14 messages over a year. */
  const quietRegular = { messagesInChat: 14, messagesGlobal: 20, localAgeDays: 400 }
  /** The same person after our own record of them was lost. */
  const recordWiped = {
    messagesInChat: 14, messagesGlobal: 20, localAgeDays: 0, joinedAgoSeconds: 700 * 86_400
  }

  it('the exempt does stand down here (regression anchor)', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: promoMsg, user: quietRegular }), llmSaying('channel_promo'))
    expect(v.reasonCode).not.toBe('established_regular')
    expect(mayRemoveSender(v.signals)).toBe(true)
  })

  it('REGRESSION: the chat\'s own history is standing, and standing caps an imitable act', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: promoMsg, user: quietRegular }), llmSaying('channel_promo'))
    expect(v.signals.map((s) => s.name)).toContain('established_user')
    expect(removesSender(v.action)).toBe(false)
    expect(v.action).toBe('delete')
    expect(v.needsVote).toBe(true)
    expect(v.meta['cappedStanding']).toBe(true)
    // The reason survives — the punishment was too much, the reason stands.
    expect(v.reasonCode).toBe('channel_promo')
  })

  it('REGRESSION: a lost record does not make a long-time member ban-eligible', async () => {
    // `isNewish` is what strips the ban shield in `decideAction`, and its tenure
    // term used to read our first-seen date alone. A member of two years whose
    // record we had just recreated was therefore "newish", and a 0.97 verdict
    // that would have been a reversible mute became a 30-day ban with no vote.
    //
    // Deliberately too quiet for the exempt AND for standing (5 in chat, 30
    // globally), so the tenure clock is the only thing under test here: no
    // `established_regular`, no `established_user`, and one lighter link so the
    // classifier is the stage that decides. Before the fix: ban, 2592000s, no
    // vote. After: mute, which an admin can undo and which expires by itself.
    const thinRecordWiped = {
      messagesInChat: 5, messagesGlobal: 30, localAgeDays: 0, joinedAgoSeconds: 700 * 86_400
    }
    const oneLink = {
      text: 'Заходьте до нас, там багато цікавого',
      urls: [{ visible: 'https://t.me/+AbCdEfGhIjKl', target: 'https://t.me/+AbCdEfGhIjKl', hidden: false }]
    }
    const v = await evaluateMessage(
      makeInput({ msg: oneLink, user: thinRecordWiped }), llmSaying('job_scam'))
    expect(v.signals.map((s) => s.name)).not.toContain('established_user')
    expect(v.action).not.toBe('ban')
    expect(removesSender(v.action)).toBe(true) // a job scam is still a job scam
  })

  it('REGRESSION: a lost record does not make a long-time member a sleeper either', async () => {
    // Same clock, same shape: `sleeper_awakened` means an old account that has
    // only just become visible HERE. Telegram's join date contradicts that
    // outright, so the signal was asserting a premise the snapshot disproved.
    const v = await evaluateMessage(makeInput({
      msg: promoMsg,
      user: {
        messagesInChat: 5, messagesGlobal: 30, localAgeDays: 0,
        predictedAgeDays: 800, joinedAgoSeconds: 700 * 86_400
      }
    }), llmSaying('channel_promo'))
    expect(v.signals.map((s) => s.name)).not.toContain('sleeper_awakened')
  })

  it('Telegram\'s join date carries the standing our own record lost', async () => {
    const v = await evaluateMessage(
      makeInput({ msg: promoMsg, user: recordWiped }), llmSaying('channel_promo'))
    expect(v.signals.map((s) => s.name)).toContain('established_user')
    expect(removesSender(v.action)).toBe(false)
  })

  it('but an afternoon of chatter still buys nothing', async () => {
    // The tenure bar is the whole reason volume alone cannot earn standing:
    // the counters rise on every message with no rate condition.
    const v = await evaluateMessage(makeInput({
      msg: promoMsg, user: { messagesInChat: 14, messagesGlobal: 20, localAgeDays: 1 }
    }), llmSaying('channel_promo'))
    expect(v.signals.map((s) => s.name)).not.toContain('established_user')
    expect(removesSender(v.action)).toBe(true)
  })

  it('and joining long ago while saying nothing buys nothing either', async () => {
    // The sleeper case, stated as a test: tenure without volume is not standing.
    // Both halves are required, which is what keeps a year-old dormant account
    // from waking up with a shield.
    const v = await evaluateMessage(makeInput({
      msg: promoMsg,
      user: {
        messagesInChat: 2, messagesGlobal: 3, localAgeDays: 0,
        joinedAgoSeconds: 700 * 86_400
      }
    }), llmSaying('channel_promo'))
    expect(v.signals.map((s) => s.name)).not.toContain('established_user')
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
    let calls = 0
    const v = await evaluateMessage(makeInput({ msg: cjk, user: newcomer }), {
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.97, reasonCode: 'other_spam', evidence: null, cached: false }
        }
      }
    })
    // One call. This is the case with the strongest claim on a second opinion —
    // 0.97 removes the sender and every other stage was reading a script it was
    // not built for — and there is no longer one to ask.
    expect(calls).toBe(1)
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

describe('evaluateMessage — a sender mid-burst', () => {
  const burstEntry = (over: Partial<BurstEntry> = {}): BurstEntry => ({
    text: 'є вакансія для всіх бажаючих', template: 'є вакансія для всіх бажаючих',
    pSpam: 0.5, at: Date.now(), ...over
  })

  const fakeBurst = (entries: BurstEntry[]): { port: BurstPort; resets: () => number } => {
    let resets = 0
    return {
      port: {
        read: async () => entries,
        append: async () => { /* the app layer writes; the pipeline only reads */ },
        reset: async () => { resets += 1 }
      },
      resets: () => resets
    }
  }

  it('a run of distinct messages raises the signals and cannot enforce alone', async () => {
    // `shape`, not `evidence`, on purpose: velocity was the repetition-as-verdict
    // stage and the 2026-08-07 audit priced it at 16% false positives, because
    // cross-posting is something members do. A cadence opens the gate to the
    // stage that reads the words; it does not answer in its place.
    const burst = fakeBurst([
      burstEntry({ template: 'перше', pSpam: 0.5 }),
      burstEntry({ template: 'друге', pSpam: 0.6 }),
      burstEntry({ template: 'третє', pSpam: 0.1 })
    ])
    const v = await evaluateMessage(makeInput(), { burst: burst.port })
    expect(v.signals.map((sig) => sig.name)).toEqual(
      expect.arrayContaining(['sender_burst', 'burst_grey_repeat']))
    expect(isEnforcementAction(v.action)).toBe(false)
  })

  it('holds it at the OTHER window stage too, not just the one it was found at', async () => {
    // The rule is about accumulated text, and two stages produce it. Asserted
    // separately because nothing structural forces a third one to remember:
    // the ceiling is applied per call site, so each call site is the test.
    const burst = fakeBurst([
      burstEntry({ text: 'є робота для всіх', template: 'є робота', pSpam: 0.5 }),
      burstEntry({ text: 'умови дуже прості', template: 'умови прості', pSpam: 0.2 })
    ])
    const v = await evaluateMessage(makeInput({ msg: { text: 'пиши мені в особисті' } }), {
      burst: burst.port,
      llm: {
        classify: async () => ({ pSpam: 0.96, reasonCode: 'flood', evidence: null, cached: false })
      }
    })
    expect(v.decidedBy).toBe('burst')
    expect(v.action).toBe('observe')
    expect(v.meta['cappedRestated']).toBe(true)
  })

  it('reads the run together when nothing could be said about the message', async () => {
    // The shape nothing else in the pipeline can see: a pitch with no link, a
    // photo, and "write to me privately" are each unremarkable on their own, and
    // every stage judges them one at a time.
    let classified: string | null = null
    const burst = fakeBurst([
      burstEntry({ text: 'є робота для всіх', template: 'є робота', pSpam: 0.5 }),
      burstEntry({ text: 'умови дуже прості', template: 'умови прості', pSpam: 0.2 })
    ])
    const v = await evaluateMessage(makeInput({ msg: { text: 'пиши мені в особисті' } }), {
      burst: burst.port,
      llm: {
        classify: async (input) => {
          classified = input.message.text
          return { pSpam: 0.93, reasonCode: 'job_scam', evidence: null, cached: false }
        }
      }
    })
    expect(v.decidedBy).toBe('burst')
    expect(classified).toBe('є робота для всіх\nумови дуже прості\nпиши мені в особисті')
    expect(v.meta['judgedCount']).toBe(3)
    // A judged window is spent — the same rule as the session pile. Without it
    // every later message re-rolls substantially the same blob, and any one roll
    // can enforce.
    expect(burst.resets()).toBe(1)
  })

  it('may take the message down and never the person', async () => {
    // The most cautious stage in the file, deliberately. A blob has no single
    // subject and by construction no line that meant anything alone, so a new
    // stage does not get to be the one that removes people on a cadence.
    const burst = fakeBurst([
      burstEntry({ text: 'є робота для всіх', template: 'є робота', pSpam: 0.5 }),
      burstEntry({ text: 'умови дуже прості', template: 'умови прості', pSpam: 0.2 })
    ])
    const v = await evaluateMessage(makeInput({
      msg: { text: 'пиши мені в особисті' }, user: newcomer
    }), {
      burst: burst.port,
      llm: { classify: async () => ({ pSpam: 0.99, reasonCode: 'job_scam', evidence: null, cached: false }) }
    })
    expect(removesSender(v.action)).toBe(false)
    expect(mayRemoveSender(v.signals)).toBe(false)
  })

  it('does not ask about the run when the message itself was decided', async () => {
    // One classifier call per message, still. The blob is the last resort, not a
    // second opinion on a verdict that already exists.
    let calls = 0
    const burst = fakeBurst([
      burstEntry({ template: 'перше' }), burstEntry({ template: 'друге' })
    ])
    const v = await evaluateMessage(makeInput({
      msg: { text: 'заходь сюди t.me/+abcdefghijk, там усе розкажуть', urls: [
        { visible: 't.me/+abcdefghijk', target: 'https://t.me/+abcdefghijk', hidden: false }
      ] },
      user: newcomer
    }), {
      burst: burst.port,
      llm: {
        classify: async () => {
          calls += 1
          return { pSpam: 0.96, reasonCode: 'promo_link', evidence: null, cached: false }
        }
      }
    })
    // A private invite from a newcomer is a deterministic rule, so not even the
    // classifier is asked — which makes the point twice over: the blob is a last
    // resort, never a second opinion on a verdict that already exists.
    expect(isEnforcementAction(v.action)).toBe(true)
    expect(v.decidedBy).not.toBe('burst')
    expect(calls).toBe(0)
    expect(burst.resets()).toBe(0)
  })

  it('a quiet sender pays for nothing', async () => {
    let calls = 0
    const burst = fakeBurst([])
    const v = await evaluateMessage(makeInput(), {
      burst: burst.port,
      llm: { classify: async () => { calls += 1; return null } }
    })
    expect(v.signals.map((sig) => sig.name)).not.toContain('sender_burst')
    expect(calls).toBe(0)
  })

  it('survives a window it cannot read', async () => {
    const v = await evaluateMessage(makeInput(), {
      burst: {
        read: async () => { throw new Error('mongo down') },
        append: async () => { /* noop */ },
        reset: async () => { /* noop */ }
      }
    })
    expect(v.signals.map((sig) => sig.name)).not.toContain('sender_burst')
    expect(v.meta['portError_burst']).toBe(true)
  })
})

/**
 * Production 2026-08-27 16:46 (measured in the 2026-08-28 audit): a municipal
 * announcements account — 23 consecutive clean rows — posted an aid-distribution
 * notice with a formatted link and a phone number. The content stack
 * (hidden_url + external_url + phone_number + long_text + mixed_script_word)
 * cleared the sender-removal evidence bar, so the established-regular exempt
 * stood down, and the score muted an `established_user` at 0.90. Nothing capped
 * it: `capImitableAct` covers three reason codes this is not, and
 * `capVouchedWindow` covers two stages this did not come from.
 *
 * The rule under test: standing caps a SCORE-decided sender-removal at
 * delete + vote. The message evidence is not in dispute — only whether the
 * arithmetic alone may take a vouched member away.
 */
describe('evaluateMessage — standing caps score-decided sender-removal', () => {
  /** The production message shape: heavy content stack from a vouched regular. */
  const announcementFromRegular = () => makeInput({
    msg: {
      text: '📢 До уваги мешканців міста та навколишніх сіл, у тому числі ВПО! ' +
        'Продовжується видача продуктових наборів для зареєстрованих отримувачів. ' +
        'Видача відбувається щодня, крім вихідних, з 10:00 до 16:00. ' +
        'Реєстрація обовʼязкова, кількість наборів обмежена. ' +
        'Довідки за телефоном +380671234567 або за посиланням нижче (проєкт SpivDiя-хаб). ' +
        'Просимо мати при собі документ, що посвідчує особу, та номер справи UNHCR-2026.',
      // The production shape: the visible text is itself a URL that leads
      // somewhere else — which is what `hidden_url` actually measures.
      urls: [{ visible: 'https://bohodukhiv-rada.gov.ua/dopomoga', target: 'https://forms.example.com/aid', hidden: true }]
    },
    user: { messagesInChat: 200, messagesGlobal: 900, localAgeDays: 400 }
  })

  it('an established sender is not muted by arithmetic alone: delete + vote', async () => {
    const v = await evaluateMessage(announcementFromRegular(), {})
    expect(v.signals.map((s) => s.name)).toContain('established_user')
    expect(v.decidedBy).toBe('score')
    expect(removesSender(v.action)).toBe(false)
    if (v.action === 'delete') expect(v.needsVote).toBe(true)
    expect(v.meta['cappedStanding']).toBe(true)
  })

  it('the same stack from a stranger keeps its full reach', async () => {
    // For a newcomer the very same stack is deterministic-rule territory
    // (hidden_url_new); the point is that only standing softens it.
    const v = await evaluateMessage(makeInput({
      msg: announcementFromRegular().message,
      user: newcomer
    }), {})
    expect(removesSender(v.action)).toBe(true)
  })
})

/**
 * The per-chat circuit breaker for a deterministic rule the chat's own admins
 * keep overturning. Production for the fortnight to 2026-08-28: one vacancy
 * chat had 5 `external_ban_new` bans and its admin reversed 4 — all different
 * users, so the per-user trust the override grants never engaged once.
 *
 * `wornRuleIds` is that chat's list of worn-out rules (computed from permanent
 * `pipeline_feedback` by the store): the rule still fires, still deletes, still
 * asks the chat — it just stops removing the sender on its own authority.
 */
describe('evaluateMessage — a worn deterministic rule stops removing senders', () => {
  const listedNewcomer = {
    ...newcomer,
    externalBan: { banned: true, bannedAt: null, offenses: 3, sources: ['lols' as const] }
  }

  it('a worn rule is capped to delete + vote, keeping its attribution', async () => {
    const v = await evaluateMessage(makeInput({
      user: listedNewcomer,
      policy: { wornRuleIds: ['external_ban_new'] }
    }), {})
    expect(v.ruleId).toBe('external_ban_new')
    expect(v.action).toBe('delete')
    expect(v.needsVote).toBe(true)
    expect(v.banDurationSeconds).toBeNull()
    expect(v.meta['cappedWornRule']).toBe(true)
  })

  it('the same listing in a chat that never objected still bans', async () => {
    const v = await evaluateMessage(makeInput({ user: listedNewcomer }), {})
    expect(v.ruleId).toBe('external_ban_new')
    expect(v.action).toBe('ban')
  })

  it('wearing one rule does not soften any other', async () => {
    const v = await evaluateMessage(makeInput({
      user: {
        ...newcomer,
        flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false }
      },
      policy: { wornRuleIds: ['external_ban_new'] }
    }), {})
    expect(v.ruleId).toBe('scam_flag_new')
    expect(v.action).toBe('ban')
  })
})
