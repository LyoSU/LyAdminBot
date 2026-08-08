import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Signal } from './types.js'
import {
  scoreSignals, hasDecisiveSignal, mayRemoveSender, hasSenderStanding, contentEvidence,
  BASE_RATE_BIAS, DECISIVE_MIN_WEIGHT, SENDER_REMOVAL_MIN_EVIDENCE
} from './score.js'
import {
  SIGNAL_GROUP_CAPS, SIGNAL_GROUPS, SIGNAL_WEIGHTS, SIGNAL_NAMES, SOFT_SHAPE_SIGNALS,
  type SignalName
} from './signals/registry.js'

describe('scoreSignals', () => {
  it('returns the base rate for an empty signal list', () => {
    const { pSpam } = scoreSignals([])
    expect(pSpam).toBeGreaterThan(0.05)
    expect(pSpam).toBeLessThan(0.15)
  })

  it('strong suspicious combinations push pSpam high', () => {
    const signals: Signal[] = [
      { name: 'scam_flag' },
      { name: 'external_ban' },
      { name: 'private_invite_link' },
      { name: 'new_globally' }
    ]
    expect(scoreSignals(signals).pSpam).toBeGreaterThan(0.9)
  })

  it('trust signals push pSpam below the base rate', () => {
    const signals: Signal[] = [
      { name: 'trusted_reputation' },
      { name: 'established_user' },
      { name: 'is_reply' }
    ]
    expect(scoreSignals(signals).pSpam).toBeLessThan(0.02)
  })

  it('sleeper_awakened alone stays below auto-action territory (prod FP class)', () => {
    // Lost-pet posts from old quiet accounts must not be auto-muted:
    // sleeper + external_url + new_in_chat must stay in the votable band.
    const signals: Signal[] = [
      { name: 'sleeper_awakened' },
      { name: 'external_url' },
      { name: 'new_in_chat' }
    ]
    const { pSpam } = scoreSignals(signals)
    expect(pSpam).toBeLessThan(0.85)
  })

  // Tolerating an unknown name keeps a typo from crashing moderation. The
  // danger is the opposite direction — a signal the pipeline really produces
  // being silently worth nothing — and that is guarded by signal-registry.test.ts.
  it('unknown signal names contribute zero weight', () => {
    const base = scoreSignals([{ name: 'external_url' }]).pSpam
    const withUnknown = scoreSignals([{ name: 'external_url' }, { name: 'totally_unknown_signal' as SignalName }]).pSpam
    expect(withUnknown).toBeCloseTo(base, 10)
  })

  it('knowledge-port matches actually move the score', () => {
    // These four were weightless until 2026-07-27: the bot paid for the
    // lookups and then discarded the answers.
    const base = scoreSignals([]).pSpam
    for (const name of [
      'moderation_flagged', 'signature_candidate_match', 'vector_similar_spam', 'bot_mention'
    ] satisfies SignalName[]) {
      expect(scoreSignals([{ name }]).pSpam, name).toBeGreaterThan(base)
    }
  })
})

describe('scoreSignals — NSFW calibration (2026-07-27)', () => {
  // Standard preset acts at delete 0.60 / kick 0.75 / mute 0.88 / ban 0.95.
  const KICK_BAR = 0.75
  const MUTE_BAR = 0.88

  const newcomerStack: Signal[] = [
    { name: 'new_in_chat' }, { name: 'new_globally' }, { name: 'just_joined' },
    { name: 'fresh_account' }, { name: 'avatar_recently_set' }
  ]

  it('an NSFW avatar alone is nowhere near an action', () => {
    expect(scoreSignals([{ name: 'nsfw_avatar' }]).pSpam).toBeLessThan(0.35)
  })

  it('REGRESSION: avatar + every newcomer signal cannot reach kick, let alone ban', () => {
    // The exact stack that produced permanent bans: a first-time poster who
    // joined seconds ago, on a young account, with a flagged avatar. At the
    // old weight of 2.5, and with newness uncapped, this reached 0.98 — a
    // ban. It must now land in LLM territory, and since every one of these
    // signals is soft-shape the pipeline cannot enforce on it at all.
    const { pSpam } = scoreSignals([{ name: 'nsfw_avatar' }, ...newcomerStack])
    expect(pSpam).toBeLessThan(KICK_BAR)
    expect(hasDecisiveSignal([{ name: 'nsfw_avatar' }, ...newcomerStack])).toBe(false)
  })

  it('REGRESSION: being new is not itself an offence', () => {
    // Five correlated restatements of "this account is new" used to sum to
    // 3.8 — heavier than a Telegram scam flag — putting an ordinary first
    // post at 0.83 before any content was considered.
    const { pSpam, cappedGroups } = scoreSignals(newcomerStack)
    expect(pSpam).toBeLessThan(0.6)
    expect(cappedGroups).toContain('newness')
  })

  it('adding a porn avatar to a newcomer does not double the punishment', () => {
    const plain = scoreSignals(newcomerStack).pSpam
    const withAvatar = scoreSignals([{ name: 'nsfw_avatar' }, ...newcomerStack]).pSpam
    expect(withAvatar).toBeGreaterThan(plain)
    expect(withAvatar).toBeLessThan(MUTE_BAR)
  })

  it('profile media never outweighs actual message evidence', () => {
    const profile = scoreSignals([{ name: 'nsfw_avatar' }, { name: 'nsfw_stories' }]).pSpam
    const content = scoreSignals([{ name: 'hidden_url' }]).pSpam
    expect(content).toBeGreaterThan(profile)
  })

  it('name promo is weighted above bio promo — it is far harder to do by accident', () => {
    expect(SIGNAL_WEIGHTS['promo_in_name'] ?? 0).toBeGreaterThan(SIGNAL_WEIGHTS['promo_in_bio'] ?? 0)
  })
})

describe('content evidence (2026-07-30 FP)', () => {
  // Production: a conversational thank-you from a sleeper account was KICKED at
  // pSpam 0.77 on `signals:sleeper_awakened`, and the chat voted it ham within
  // five seconds. `hasDecisiveSignal` was weight-blind, so a 0.2-weight crumb
  // about the message counted as licence to enforce without reading it.
  const shapeStack: Signal[] = [
    { name: 'sleeper_awakened' }, { name: 'new_globally' },
    { name: 'promo_in_bio' }, { name: 'personal_channel' }
  ]

  it('shape alone carries no content evidence at all', () => {
    expect(contentEvidence(shapeStack)).toEqual({ strongest: 0, total: 0 })
    expect(hasDecisiveSignal(shapeStack)).toBe(false)
    expect(mayRemoveSender(shapeStack)).toBe(false)
  })

  it('REGRESSION: a trivially-weighted crumb is not licence to enforce blind', () => {
    for (const crumb of ['edited_message', 'unknown_media', 'bot_mention', 'long_text'] satisfies SignalName[]) {
      const signals: Signal[] = [...shapeStack, { name: crumb }]
      expect(hasDecisiveSignal(signals), crumb).toBe(false)
      expect(mayRemoveSender(signals), crumb).toBe(false)
    }
  })

  it('a bare external link is not evidence to enforce on', () => {
    // The commonest ham content in a group chat. It may raise the score and
    // pull in the LLM; it may not, by itself, delete anybody's message — and it
    // may not help clear the bar for removing a person either.
    const signals: Signal[] = [...shapeStack, { name: 'external_url' }]
    expect(contentEvidence(signals).total).toBe(0)
    expect(hasDecisiveSignal(signals)).toBe(false)
  })

  it('REGRESSION: nudges do not add up to grounds for removing a person', () => {
    // Production, 2026-07-30 11:36: a political comment kicked on
    // moderation_flagged 1.5 + long_text 0.4 + edited_message 0.2 = 2.1, voted
    // ham by the chat. Being long and having been edited is not evidence.
    const signals: Signal[] = [
      { name: 'moderation_flagged' }, { name: 'long_text' }, { name: 'edited_message' },
      { name: 'new_globally' }, { name: 'new_in_chat' }
    ]
    expect(hasDecisiveSignal(signals)).toBe(true)
    expect(contentEvidence(signals).total).toBe(SIGNAL_WEIGHTS['moderation_flagged'])
    expect(mayRemoveSender(signals)).toBe(false)
  })

  it('REGRESSION: the sender\'s past is not evidence about this message', () => {
    // Production, 2026-07-30: a legitimate appeal for help (a missing relative,
    // with a contact number) was muted at 0.89 by `score` — nothing read it.
    // The evidence was prior_spam_detections 1.5 +
    // low_reputation 1.2 + phone_number 1.2 = 3.9, comfortably over the bar.
    //
    // But two of those three are the sender's history, not this message: a
    // record of past detections is a reason to LOOK harder, not a fact about
    // what was just posted. The only message-level fact was a phone number —
    // which such an appeal legitimately contains.
    const signals: Signal[] = [
      { name: 'prior_spam_detections' }, { name: 'low_reputation' },
      { name: 'phone_number' }, { name: 'long_text' }
    ]
    expect(contentEvidence(signals).total).toBe(SIGNAL_WEIGHTS['phone_number'])
    expect(hasDecisiveSignal(signals)).toBe(true)
    expect(mayRemoveSender(signals)).toBe(false)
  })

  it('a known repeat spammer still may not be removed on reputation alone', () => {
    // The heaviest possible history stack, and no fact about the message.
    const signals: Signal[] = [
      { name: 'prior_spam_detections' }, { name: 'low_reputation' }, ...shapeStack
    ]
    expect(contentEvidence(signals).total).toBe(0)
    expect(hasDecisiveSignal(signals)).toBe(false)
  })

  it('REGRESSION: a third party\'s ban list says nothing about this message', () => {
    // Production, 2026-07-31: `external_ban` 2.5 + `sleeper_awakened` 1.2 scored
    // 0.82 and deleted an ordinary question about paperwork — three times in ten
    // minutes, voted ham 3:0 by the chat each time.
    //
    // A listing is someone else's verdict on the ACCOUNT, and the rehabilitated
    // account is the acknowledged FP class of these databases — which is exactly
    // why `external_ban_new` requires the account to have no local history. The
    // scoring path undid that guard by treating the listing as message evidence.
    const signals: Signal[] = [
      { name: 'external_ban' }, { name: 'external_repeat_offender' },
      { name: 'fresh_external_ban' }, { name: 'sleeper_awakened' }
    ]
    expect(contentEvidence(signals).total).toBe(0)
    expect(hasDecisiveSignal(signals)).toBe(false)
    // The score still says "very likely spam" — the listing keeps its full
    // weight. What it may no longer do is enforce without anything reading it.
    expect(scoreSignals(signals).pSpam).toBeGreaterThan(0.9)
  })

  it('REGRESSION: our own unconfirmed verdict is not a second reading of the message', () => {
    // Production, 2026-08-01 06:21. A job ad was read by the LLM at 05:37 and
    // judged spam at 0.99, so auto-learn wrote a candidate signature and a
    // candidate vector for it. On the next sighting those two echoes were the
    // ENTIRE case: 1.2 + 1.0 = 2.2 units of "content evidence", clearing both
    // bars, so the score rose above the grey ceiling and the LLM gate stayed
    // shut. The pipeline enforced on a message no stage had read that time —
    // on nothing but its own recollection of having judged one like it.
    //
    // A match against a self-learned store is not an observation about this
    // message; it is a pointer back to an earlier verdict. Counting it as
    // evidence lets an unconfirmed guess become its own corroboration, and
    // `learning.ts` is explicit that a candidate may not convict on its own.
    const echo: Signal[] = [{ name: 'signature_candidate_match' }]
    expect(contentEvidence(echo)).toEqual({ strongest: 0, total: 0 })
    expect(hasDecisiveSignal(echo)).toBe(false)
    // The score keeps its full weight — what it may no longer do is stand in
    // for somebody having read the text.
    expect(scoreSignals(echo).pSpam).toBeGreaterThan(scoreSignals([]).pSpam)

    // The vector neighbour is NOT in the same class and keeps its rung on the
    // lower bar: that store is fed by confirmed community votes too, so a hit in
    // it is not purely a memory of our own guess. What it may not do is help
    // remove a person — see the resemblance test below.
    expect(hasDecisiveSignal([{ name: 'vector_similar_spam' }])).toBe(true)
  })

  it('an echo cannot top up real evidence to the sender-removal bar', () => {
    // Exactly the 2026-08-01 sum: 1.2 + 1.0 read as two independent facts and
    // cleared the bar for removing a person. One of them was a memory.
    expect(mayRemoveSender([
      { name: 'signature_candidate_match' }, { name: 'vector_similar_spam' }
    ])).toBe(false)
  })

  it('REGRESSION: a resemblance may convict the message but never the person', () => {
    // Production, 2026-08-01 13:22. An appeal for help carrying a phone number
    // drew a 30-day ban decided by arithmetic alone, with no stage having read
    // it: phone_number 1.2 + vector_similar_spam 1.0 came to exactly the 2.0
    // bar, so the enforcement counted as earned and the LLM gate stayed shut.
    // Twice more the same hour, on a job ad and on a fundraising post.
    //
    // A neighbour is not a second fact about the message. It fires at 0.85
    // cosine, the neighbour may itself be unconfirmed, and what it asserts is
    // that the text RESEMBLES something — not that it CONTAINS something. Good
    // grounds to take the message down and to look closer; not grounds to take
    // the chat away from whoever posted it.
    const appeal: Signal[] = [{ name: 'phone_number' }, { name: 'vector_similar_spam' }]
    expect(hasDecisiveSignal(appeal)).toBe(true)
    expect(mayRemoveSender(appeal)).toBe(false)
    expect(contentEvidence(appeal).total).toBe(SIGNAL_WEIGHTS['phone_number'])

    // Two neighbours are still one kind of claim, however many of them agree.
    expect(mayRemoveSender([
      { name: 'vector_similar_spam' }, { name: 'signature_candidate_match' },
      { name: 'moderation_flagged' }
    ])).toBe(false)

    // And two real observations remove the sender exactly as before.
    expect(mayRemoveSender([{ name: 'phone_number' }, { name: 'moderation_flagged' }])).toBe(true)
  })

  it('one real content signal licenses enforcement on the message', () => {
    const signals: Signal[] = [...shapeStack, { name: 'moderation_flagged' }]
    expect(hasDecisiveSignal(signals)).toBe(true)
  })

  it('removing the SENDER needs more evidence than removing the message', () => {
    // A single mid-weight hit is grounds to delete, not to remove a person.
    expect(hasDecisiveSignal([{ name: 'moderation_flagged' }])).toBe(true)
    expect(mayRemoveSender([{ name: 'moderation_flagged' }])).toBe(false)

    // Two independent facts that are each evidence in their own right do.
    expect(mayRemoveSender([{ name: 'phone_number' }, { name: 'moderation_flagged' }])).toBe(true)
    expect(mayRemoveSender([{ name: 'many_url_buttons' }])).toBe(true)

    // A link riding along with one of them adds nothing: it is a nudge.
    expect(mayRemoveSender([{ name: 'phone_number' }, { name: 'external_url' }])).toBe(false)
  })

  it('trust signals never count as evidence for enforcing', () => {
    const signals: Signal[] = [
      { name: 'moderation_flagged' },
      { name: 'is_reply' },
      { name: 'established_user' }
    ]
    expect(contentEvidence(signals).total).toBe(SIGNAL_WEIGHTS['moderation_flagged'])
  })

  it('the two bars are ordered — enforcing is always cheaper than removing', () => {
    expect(DECISIVE_MIN_WEIGHT).toBeLessThan(SENDER_REMOVAL_MIN_EVIDENCE)
  })

  it('every soft-shape signal is a real signal, and none of them is content', () => {
    for (const name of SOFT_SHAPE_SIGNALS) {
      expect(SIGNAL_WEIGHTS[name], name).toBeDefined()
      expect(contentEvidence([{ name }]).total, name).toBe(0)
    }
  })

  it('property: content evidence is monotone and never negative', () => {
    const names = SIGNAL_NAMES
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...names).map((name): Signal => ({ name })), { maxLength: 12 }),
        fc.constantFrom(...names),
        (signals, extra) => {
          const before = contentEvidence(signals)
          const after = contentEvidence([...signals, { name: extra }])
          return before.total >= 0 && after.total >= before.total &&
            after.strongest >= before.strongest
        }
      )
    )
  })
})

describe('scoreSignals — group ceilings', () => {
  it('restating the same fact stops paying after the ceiling', () => {
    const { cappedGroups } = scoreSignals([
      { name: 'external_ban' }, { name: 'external_repeat_offender' }, { name: 'fresh_external_ban' }
    ])
    expect(cappedGroups).toContain('external_ban_source')
  })

  it('one strong signal is never weakened by its own group', () => {
    // The ceiling must clamp a stack, never a lone member.
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const member of group.members) {
        const weight = SIGNAL_WEIGHTS[member] ?? 0
        expect(weight, `${member} exceeds its own group ceiling`).toBeLessThanOrEqual(group.cap)
        expect(scoreSignals([{ name: member }]).cappedGroups).toEqual([])
      }
    }
  })

  it('groups do not overlap — a signal capped twice would be double-discounted', () => {
    const seen = new Set<SignalName>()
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const member of group.members) {
        expect(seen.has(member), `${member} is in two groups`).toBe(false)
        seen.add(member)
      }
    }
  })

  it('every group member is a real, positively-weighted signal', () => {
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const member of group.members) {
        expect(SIGNAL_WEIGHTS[member], `${member} in group ${group.name}`).toBeDefined()
        expect(SIGNAL_WEIGHTS[member] ?? 0).toBeGreaterThan(0)
      }
    }
  })

  it('trust signals are never capped (a ceiling could only make us harsher)', () => {
    const trustNames = SIGNAL_NAMES.filter((n) => SIGNAL_WEIGHTS[n] < 0)
    const grouped = new Set(SIGNAL_GROUP_CAPS.flatMap((g) => [...g.members]))
    for (const name of trustNames) expect(grouped.has(name), name).toBe(false)
  })

  it('capping never turns a spam stack clean', () => {
    const hard = scoreSignals([
      { name: 'scam_flag' }, { name: 'external_ban' }, { name: 'private_invite_link' }
    ])
    expect(hard.pSpam).toBeGreaterThan(0.9)
  })
})

describe('scoreSignals — algebra', () => {
  it('duplicate signals are counted once', () => {
    const once = scoreSignals([{ name: 'phone_number' }]).pSpam
    const twice = scoreSignals([{ name: 'phone_number' }, { name: 'phone_number' }]).pSpam
    expect(twice).toBeCloseTo(once, 10)
  })

  it('reports top contributors sorted by absolute weight', () => {
    const { topContributors } = scoreSignals([
      { name: 'long_text' },
      { name: 'scam_flag' },
      { name: 'is_reply' }
    ])
    expect(topContributors[0]?.name).toBe('scam_flag')
  })

  const knownNames = SIGNAL_NAMES
  const signalArb = fc.array(
    fc.constantFrom(...knownNames).map((name): Signal => ({ name })),
    { maxLength: 15 }
  )

  it('property: pSpam is always within [0, 1]', () => {
    fc.assert(
      fc.property(signalArb, (signals) => {
        const { pSpam } = scoreSignals(signals)
        return pSpam >= 0 && pSpam <= 1 && Number.isFinite(pSpam)
      })
    )
  })

  it('property: adding a positive-weight signal never lowers pSpam', () => {
    const positives = knownNames.filter((n) => SIGNAL_WEIGHTS[n] > 0)
    fc.assert(
      fc.property(signalArb, fc.constantFrom(...positives), (signals, extra) => {
        const before = scoreSignals(signals).pSpam
        const after = scoreSignals([...signals, { name: extra }]).pSpam
        return after >= before - 1e-12
      })
    )
  })

  it('property: adding a trust signal never raises pSpam', () => {
    const negatives = knownNames.filter((n) => SIGNAL_WEIGHTS[n] < 0)
    fc.assert(
      fc.property(signalArb, fc.constantFrom(...negatives), (signals, extra) => {
        const before = scoreSignals(signals).pSpam
        const after = scoreSignals([...signals, { name: extra }]).pSpam
        return after <= before + 1e-12
      })
    )
  })

  it('exposes a sane base-rate bias for replay calibration', () => {
    expect(BASE_RATE_BIAS).toBeLessThan(0)
  })
})

describe('contentEvidence and the correlation ceilings', () => {
  it('one link tripping several URL classes counts once, up to the group cap', () => {
    // `SENDER_REMOVAL_MIN_EVIDENCE` means roughly two independent facts about
    // the message. The catalogue already declares that the URL classes are not
    // independent; this bar used to sum them anyway.
    const oneLink: Signal[] = [
      { name: 'private_invite_link' },
      { name: 'url_shortener' },
      { name: 'messenger_contact_link' }
    ]
    const cap = SIGNAL_GROUPS['promo_urls'].cap
    const uncapped = SIGNAL_WEIGHTS['private_invite_link'] +
      SIGNAL_WEIGHTS['url_shortener'] + SIGNAL_WEIGHTS['messenger_contact_link']
    expect(uncapped).toBeGreaterThan(cap)
    expect(contentEvidence(oneLink).total).toBe(cap)
  })

  it('reading where a link goes is an observation, not a second link', () => {
    // 2026-08-01 added the destination read; until 2026-08-03 it sat outside the
    // URL group, so a single t.me invite scored 1.8 + 1.5 and cleared the
    // sender-removal bar on its own.
    const oneLink: Signal[] = [
      { name: 'private_invite_link' },
      { name: 'promo_in_message_link' }
    ]
    expect(contentEvidence(oneLink).total).toBe(SIGNAL_GROUPS['promo_urls'].cap)
    expect(contentEvidence(oneLink).total).toBeLessThan(
      SIGNAL_WEIGHTS['private_invite_link'] + SIGNAL_WEIGHTS['promo_in_message_link']
    )
  })

  it('two genuinely independent facts still add up in full', () => {
    const two: Signal[] = [{ name: 'private_invite_link' }, { name: 'phone_number' }]
    expect(contentEvidence(two).total).toBe(
      SIGNAL_WEIGHTS['private_invite_link'] + SIGNAL_WEIGHTS['phone_number']
    )
  })

  it('a group never caps the strongest single signal below its own weight', () => {
    // `strongest` licenses acting on the MESSAGE and must stay a per-signal fact:
    // a ceiling on a sum has no business lowering it.
    for (const group of SIGNAL_GROUP_CAPS) {
      for (const name of group.members) {
        const weight = SIGNAL_WEIGHTS[name]
        // Soft shape and prior matches are excluded from evidence entirely, so
        // they have no `strongest` to preserve.
        if (weight < DECISIVE_MIN_WEIGHT || SOFT_SHAPE_SIGNALS.has(name)) continue
        expect(contentEvidence([{ name }]).strongest, name).toBe(weight)
      }
    }
  })
})

describe('hasSenderStanding (2026-08-08)', () => {
  it('standing is the chat history, not the message', () => {
    expect(hasSenderStanding([{ name: 'established_user' }])).toBe(true)
    expect(hasSenderStanding([])).toBe(false)
    expect(hasSenderStanding([{ name: 'private_invite_link' }])).toBe(false)
  })

  it('being caught before revokes it', () => {
    // 20 of the 25 imitable sender-removals carrying `established_user` over the
    // fortnight to 2026-08-08 also carried this. A guard, not a measured effect
    // — see `hasSenderStanding` for why it is kept anyway.
    const caught: Signal[] = [
      { name: 'established_user' },
      { name: 'prior_spam_detections', evidence: '2 prior detections' }
    ]
    expect(hasSenderStanding(caught)).toBe(false)
  })

  it('is independent of how much evidence the message carries', () => {
    // The whole point: these two predicates answer different questions, so one
    // must not move when the other does.
    const heavy: Signal[] = [
      { name: 'established_user' },
      { name: 'private_invite_link' },
      { name: 'promo_in_message_link' }
    ]
    expect(mayRemoveSender(heavy)).toBe(true)
    expect(hasSenderStanding(heavy)).toBe(true)
  })

  it('trust signals other than standing do not stand in for it', () => {
    // `verified_account` is Telegram vouching for an identity and `is_reply` is
    // a shape; neither is a history in this chat. Keeping the set at one signal
    // is what keeps the measured blast radius the measured one.
    for (const name of ['verified_account', 'trusted_reputation', 'is_reply'] satisfies SignalName[]) {
      expect(hasSenderStanding([{ name }]), name).toBe(false)
    }
  })

  it('duplicate signals do not change the answer', () => {
    const twice: Signal[] = [{ name: 'established_user' }, { name: 'established_user' }]
    expect(hasSenderStanding(twice)).toBe(true)
  })
})
