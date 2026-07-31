/**
 * The signal catalogue: the one place a signal is declared.
 *
 * Until now a signal was declared by being *mentioned*. The site that raised it
 * wrote a bare string; then every table with an opinion about that signal
 * repeated the string — weights, soft-shape membership, correlation groups,
 * promo/high-risk roles for the deterministic rules, third-party-verdict
 * grounds in two separate packages, and a display label in five locale files.
 * Up to nine places, none of them checked against the others, because
 * `Signal.name` was `string`.
 *
 * A name missing from one of those tables was never an error. It was a silent
 * change of behaviour, and it happened four times:
 *
 *  - 2026-07-27: four port signals (`moderation_flagged`,
 *    `signature_candidate_match`, `vector_similar_spam`, `bot_mention`) had no
 *    weight, so `?? 0` erased them — the bot paid for Qdrant, OpenAI and
 *    signature lookups whose answers were discarded, while `hasDecisiveSignal`
 *    still counted them and thereby SUPPRESSED the LLM escalation.
 *  - 2026-07-27: `established_user` required a reputation score v2 never
 *    writes, so the entire negative half of the model was unreachable.
 *  - 2026-07-30: `userHasHardVerdict` had to be threaded through four files by
 *    hand; missing one would have failed only in production.
 *  - 2026-07-31: `foreign_script` shipped with no label in any locale, and
 *    `renderWhy` drops unlabelled signals — so a signal that moved verdicts was
 *    invisible in the one view that explains them.
 *
 * The catalogue below is the fix. Roles are declared *on the signal*, the
 * tables are derived from it, and `SignalName` is a union — so a typo or an
 * omission is a compile error rather than a quiet loss of detection.
 *
 * Weights remain the calibration surface of the whole pipeline: they are data,
 * reviewable as a one-line diff, and every non-obvious one carries the
 * production observation that set it.
 */

/**
 * What kind of fact a signal states — which decides what it is allowed to do,
 * not merely how much it weighs.
 *
 *  - `evidence`: a fact about the MESSAGE, or a third party's hard verdict on
 *    the account. May justify enforcement on its own if heavy enough.
 *  - `shape`: describes WHO sent it. Every one of these is an established
 *    false-positive class by itself, so a verdict resting only on shape has not
 *    established that anything was advertised — it must route through the LLM
 *    (which reads the text) or observe, never enforce blind.
 *  - `trust`: lowers the score. Carries negative weight by definition.
 */
export type SignalKind = 'evidence' | 'shape' | 'trust'

export type SignalGroupName =
  | 'newness' | 'profile_promo' | 'profile_nsfw' | 'external_ban_source' | 'promo_urls'

export interface SignalSpec {
  /**
   * Log-odds contribution to the score. Positive accuses, negative exonerates;
   * zero is not allowed — an unweighted signal is a port we paid for and then
   * ignored (see the 2026-07-27 note above).
   */
  weight: number
  kind: SignalKind
  /**
   * Correlated group this signal belongs to. Members share a ceiling, because a
   * weighted sum assumes independent inputs and restatements of one fact are
   * not independent. See `SIGNAL_GROUPS`.
   */
  group?: SignalGroupName
  /** Carries promo intent — input to the deterministic promo rules. */
  promo?: true
  /** Structural evasion, near-zero FP by shape rather than by content. */
  highRisk?: true
  /**
   * TELEGRAM's own verdict on the account: a scam/fake flag, or a restriction
   * whose stated reason names spam. The platform adjudicated the account itself
   * and offers the owner an appeal — which is what makes this, and only this,
   * grounds for a ban that never expires.
   */
  platformVerdict?: true
  /**
   * A THIRD-PARTY community ban database (CAS/lols). Enough to override chat
   * trust — a listed account deserves the full pipeline even here — but
   * deliberately NOT grounds for a permanent ban (2026-07-31).
   *
   * These two used to be one flag, and the effect was that the single rule which
   * enforces on zero content evidence (`external_ban_new`) was also the only one
   * whose mistakes could never expire. Production: an account was permanently
   * banned over a message about an audiobook, `contentEvidence` 0. The rule
   * itself is deliberate; its permanence was not, and it contradicts the reason
   * the rule states for existing — that the known false-positive class of these
   * databases is the rehabilitated account. That is an error time corrects, and
   * a permanent ban is exactly the response that prevents it from being
   * corrected. `TIMED_BAN_SECONDS` exists for this: a real spam bot does not
   * wait 30 days to come back.
   */
  thirdPartyVerdict?: true
}

/**
 * Correlated signal groups and their ceilings (2026-07-27).
 *
 * A weighted sum assumes its inputs are independent evidence. Several of ours
 * plainly are not: `new_in_chat`, `new_globally`, `fresh_account`, `just_joined`
 * and `avatar_recently_set` are five ways of saying "this account is new".
 * Summed, they contributed 3.8 — more than a Telegram scam flag — so an
 * ordinary first-time poster started at pSpam 0.83 before anyone looked at the
 * message. Every further trigger then landed on an already-condemning base,
 * which is how one soft signal could finish the job.
 *
 * A ceiling keeps the strongest member intact while refusing to pay again for
 * restatements. Chosen conservatively at roughly twice the group's heaviest
 * member: two genuinely distinct aspects still add up, five do not.
 */
export const SIGNAL_GROUPS: Record<SignalGroupName, { cap: number }> = {
  newness: { cap: 2.0 },
  /** One profile, advertised in several places. */
  profile_promo: { cap: 2.0 },
  /** One person posting explicit imagery; avatar and stories are not
   *  independent observations of it. */
  profile_nsfw: { cap: 1.2 },
  /** All three derive from the same listing in the same databases. */
  external_ban_source: { cap: 3.5 },
  /** A single promo link usually trips several URL classes at once. */
  promo_urls: { cap: 3.0 }
}

export const SIGNALS = {
  // ───────────────────── Telegram-level account flags ─────────────────────

  scam_flag: { weight: 3.0, kind: 'evidence', platformVerdict: true },
  fake_flag: { weight: 3.0, kind: 'evidence', platformVerdict: true },
  restricted_flag: { weight: 0.8, kind: 'evidence' },
  /** Telegram-labelled spam/scam restriction — stronger than the bare flag. */
  restricted_for_spam: { weight: 1.5, kind: 'evidence', platformVerdict: true },
  /**
   * Server-side detection of a dangerous unofficial client
   * (`userFull.unofficial_security_risk`). Deliberately the heaviest single
   * account signal (user decision 2026-06-11): spam farms run modified clients,
   * legitimate users on unofficial apps are rare, and the flag comes from
   * Telegram's own abuse infrastructure.
   */
  unofficial_client_risk: { weight: 3.2, kind: 'evidence' },

  // ───────────────────── external ban databases ─────────────────────
  // Shape, not evidence (2026-07-31). `external_ban_new` already bans on these
  // outright, but only for an account with no local history — its comment states
  // why: the known FP class of these databases is the rehabilitated account. The
  // scoring path then undid that guard, because a 2.5-weight listing counted as
  // message evidence and reached `delete` with nothing having read the text.
  // Production: an ordinary question about paperwork deleted three times inside
  // ten minutes, voted ham 3:0 by the chat each time.

  external_ban: {
    weight: 2.5, kind: 'shape', group: 'external_ban_source', thirdPartyVerdict: true
  },
  /**
   * CAS counts prior offences across its network; a second listing is much
   * stronger than a single one. Replaces the dead `external_high_spam_factor`
   * (lols dropped the `spam_factor` field).
   */
  external_repeat_offender: { weight: 2.0, kind: 'shape', group: 'external_ban_source' },
  /** Ban added <48h ago: an actively-spamming live account, not an old one. */
  fresh_external_ban: { weight: 1.0, kind: 'shape', group: 'external_ban_source' },

  // ───────────────────── message structure ─────────────────────

  forward_hidden_user: { weight: 1.5, kind: 'evidence', highRisk: true },
  forward_source_suspicious: { weight: 1.6, kind: 'evidence' },
  many_url_buttons: { weight: 2.0, kind: 'evidence', promo: true, highRisk: true },
  hidden_url: {
    weight: 2.0, kind: 'evidence', group: 'promo_urls', promo: true, highRisk: true
  },
  private_invite_link: { weight: 1.8, kind: 'evidence', group: 'promo_urls', promo: true },
  bot_deeplink: { weight: 1.5, kind: 'evidence', group: 'promo_urls', promo: true },
  url_shortener: { weight: 1.2, kind: 'evidence', group: 'promo_urls', promo: true },
  messenger_contact_link: { weight: 1.5, kind: 'evidence', group: 'promo_urls', promo: true },
  external_url: { weight: 0.8, kind: 'evidence', group: 'promo_urls', promo: true },
  phone_number: { weight: 1.2, kind: 'evidence', promo: true },
  cashtag: { weight: 1.0, kind: 'evidence', promo: true },
  paid_media: { weight: 1.5, kind: 'evidence', promo: true },
  giveaway_media: { weight: 1.0, kind: 'evidence', promo: true },
  story_share: { weight: 0.8, kind: 'evidence' },
  unknown_media: { weight: 0.3, kind: 'evidence' },
  guest_bot_delivery: { weight: 0.8, kind: 'evidence' },
  edited_message: { weight: 0.2, kind: 'evidence' },
  edit_injected_promo: { weight: 2.5, kind: 'evidence' },

  // ───────────────────── message text ─────────────────────

  long_text: { weight: 0.4, kind: 'evidence' },
  invisible_in_word: { weight: 2.0, kind: 'evidence', highRisk: true },
  mixed_script_word: { weight: 1.5, kind: 'evidence' },
  /**
   * Written in a script this chat does not use. Deliberately a nudge: being
   * foreign is not being spam, and the signal's whole job is routing — it says
   * that every heuristic stage here is calibrated on another language and its
   * silence proves nothing, so the LLM must read the message (2026-07-31).
   */
  foreign_script: { weight: 0.6, kind: 'evidence' },
  /**
   * Deliberately a nudge (2026-07-30). Three custom emoji is ordinary Premium
   * decoration, commonplace in gaming and meme chats; at 1.0 it was decisive on
   * its own and supplied half the evidence needed to remove a person. Its real
   * purpose is "the raw text may hide what is rendered", i.e. a reason to
   * classify — and `shouldAbstain` already guarantees such messages are
   * classified rather than abstained on.
   */
  custom_emoji_heavy: { weight: 0.8, kind: 'evidence' },

  // ───────────────────── knowledge ports (sub-decisive matches) ─────────────
  // These four had NO entry in the weight table at all, so `?? 0` silently
  // zeroed them while `hasDecisiveSignal` still counted them — see the header.

  /** Content-level NSFW in the message or its photo. */
  moderation_flagged: { weight: 1.5, kind: 'evidence' },
  /** Self-learned signature matched, but not human-confirmed yet. */
  signature_candidate_match: { weight: 1.2, kind: 'evidence' },
  /** Semantically near known spam (raised only above VECTOR_SIGNAL_SIMILARITY). */
  vector_similar_spam: { weight: 1.0, kind: 'evidence' },
  /** The message mentions a bot — promo-relevant, weak on its own. */
  bot_mention: { weight: 0.5, kind: 'evidence' },

  // ───────────────────── profile / identity (shape) ─────────────────────

  /**
   * Promo link/contact/phone in the bio. Low weight + a confirmed v1 FP class
   * (innocent website bios) → only bites stacked with newness in the score.
   */
  promo_in_bio: { weight: 1.2, kind: 'shape', group: 'profile_promo' },
  /**
   * Promo URL / foreign @handle carried in the display name or username itself.
   * Nobody names themselves after a promo link by accident, so this is the
   * highest-precision profile signal we have — but it is still about WHO, not
   * WHAT, so it stays shape.
   */
  promo_in_name: { weight: 1.8, kind: 'shape', group: 'profile_promo' },
  /** Linked personal channel — weak alone (legit users have them too). */
  personal_channel: { weight: 0.5, kind: 'shape', group: 'profile_promo' },
  /** Invisible/zero-width characters in the display name — no legitimate use. */
  invisible_in_name: { weight: 1.2, kind: 'shape' },
  identity_churn_24h: { weight: 1.5, kind: 'shape' },
  /**
   * NSFW profile media. Deliberately LOW and shape (2026-07-27 review): at
   * weight 2.5 these stacked with ordinary newcomer signals to 0.97 and
   * permanently banned first-time posters over an anime avatar the provider's
   * recall-tuned `flagged` boolean caught on `violence`. They now only nudge the
   * message toward the LLM, which reads what was actually written.
   */
  nsfw_avatar: { weight: 1.0, kind: 'shape', group: 'profile_nsfw' },
  nsfw_stories: { weight: 0.9, kind: 'shape', group: 'profile_nsfw' },

  // ───────────────────── history / age (shape) ─────────────────────

  /**
   * Deliberately LOW. v1's sleeper rule (c=90) was the top action source AND
   * the top confirmed-FP source (lost-pet posts, local venue promos from old
   * quiet accounts). Sleeper+promo must land in the votable band, not auto-mute.
   */
  sleeper_awakened: { weight: 1.2, kind: 'shape', group: 'newness' },
  fresh_account: { weight: 1.0, kind: 'shape', group: 'newness' },
  new_in_chat: { weight: 0.4, kind: 'shape', group: 'newness' },
  new_globally: { weight: 0.8, kind: 'shape', group: 'newness' },
  avatar_recently_set: { weight: 0.6, kind: 'shape', group: 'newness' },
  /** Joined the chat <2min before posting. */
  just_joined: { weight: 1.0, kind: 'shape', group: 'newness' },
  /**
   * Present in many chats we watch while barely posting — spreader pattern.
   * Modest weight; replay should confirm before trusting it further.
   */
  many_shared_chats: { weight: 0.8, kind: 'shape', group: 'newness' },
  /**
   * Sender history (2026-07-30): these two are the heaviest shape signals in the
   * table and together they cleared the sender-removal bar on their own — so a
   * member with a record could be muted with no stage having read the message,
   * and a legitimate appeal for help was. Past behaviour is a strong prior and
   * keeps its full weight in the score; it is not a fact about the text just
   * posted.
   */
  prior_spam_detections: { weight: 1.5, kind: 'shape' },
  low_reputation: { weight: 1.2, kind: 'shape' },

  // ───────────────────── trust ─────────────────────
  // Premium is deliberately absent: spammers buy premium for visibility.

  is_reply: { weight: -1.0, kind: 'trust' },
  recent_reply: { weight: -0.8, kind: 'trust' },
  media_only: { weight: -1.5, kind: 'trust' },
  emoji_only: { weight: -1.5, kind: 'trust' },
  internal_link_only: { weight: -1.0, kind: 'trust' },
  short_message: { weight: -0.8, kind: 'trust' },
  verified_account: { weight: -3.0, kind: 'trust' },
  trusted_reputation: { weight: -2.5, kind: 'trust' },
  established_user: { weight: -1.5, kind: 'trust' }
} as const satisfies Record<string, SignalSpec>

/** Every signal the pipeline can raise. A typo is now a compile error. */
export type SignalName = keyof typeof SIGNALS

type NamesOfKind<K extends SignalKind> = {
  [N in SignalName]: (typeof SIGNALS)[N]['kind'] extends K ? N : never
}[SignalName]

/**
 * Signals that accuse. This is the set the "Why?" view has to be able to name:
 * trust signals are never shown to anybody, so requiring a label for them would
 * be busywork, while a missing label on an accusing signal hides the reason a
 * message was acted on.
 */
export type SuspicionSignalName = NamesOfKind<'evidence' | 'shape'>
export type TrustSignalName = NamesOfKind<'trust'>

const ENTRIES = Object.entries(SIGNALS) as [SignalName, SignalSpec][]

const namesWhere = (predicate: (spec: SignalSpec) => boolean): ReadonlySet<SignalName> =>
  new Set(ENTRIES.filter(([, spec]) => predicate(spec)).map(([name]) => name))

/** Every catalogued name, for exhaustive iteration. */
export const SIGNAL_NAMES: readonly SignalName[] = ENTRIES.map(([name]) => name)

export const SIGNAL_WEIGHTS: Record<SignalName, number> = Object.fromEntries(
  ENTRIES.map(([name, spec]) => [name, spec.weight])
) as Record<SignalName, number>

/**
 * Weight of a signal by name, tolerating names the catalogue does not know.
 *
 * Unknown names are not hypothetical: a verdict rendered from a stored decision
 * can carry a signal that has since been renamed or removed. Such a name must
 * weigh nothing — never crash, and never be treated as evidence.
 */
export const weightOf = (name: string): number =>
  (SIGNALS as Record<string, SignalSpec | undefined>)[name]?.weight ?? 0

/**
 * Signals that describe the sender rather than the message. Kept as the
 * historical name because it is what the guard reads like at the call sites:
 * a stack of these is not proof about what was written.
 */
export const SOFT_SHAPE_SIGNALS = namesWhere((s) => s.kind === 'shape')

/** True for a signal that lowers the score — derived, never re-declared. */
export const isTrustSignal = (name: string): boolean =>
  (SIGNALS as Record<string, SignalSpec | undefined>)[name]?.kind === 'trust'

/**
 * Narrows to a signal that accuses — i.e. one the UI is obliged to be able to
 * name. Sound because the catalogue has exactly three kinds and this excludes
 * one of them.
 *
 * A name the catalogue does not know counts as accusing. That is the safe
 * direction for the only case that produces one (a decision stored before the
 * signal was renamed): it is shown, raw, rather than quietly dropped from the
 * explanation of an action somebody is looking at.
 */
export const isSuspicionSignal = (name: SignalName): name is SuspicionSignalName =>
  !isTrustSignal(name)

/** URL classes and media that carry promo intent, for the deterministic rules. */
export const PROMO_SIGNALS = namesWhere((s) => s.promo === true)

/** Structural evasion markers with near-zero FP by shape. */
export const HIGH_RISK_SIGNALS = namesWhere((s) => s.highRisk === true)

/**
 * Grounds for a ban that never expires: the PLATFORM judged the account. Every
 * other ban is timed, so a mistake of ours heals without an admin noticing.
 */
export const PERMANENT_BAN_SIGNALS = namesWhere((s) => s.platformVerdict === true)

/**
 * Condemned by somebody other than us, at either tier — the only grounds on
 * which a chat-trusted member is still actioned. A listed account deserves the
 * pipeline even here; what it does not deserve is a permanent ban, which is why
 * this set and `PERMANENT_BAN_SIGNALS` are no longer the same set.
 */
export const OVERRIDES_CHAT_TRUST_SIGNALS = namesWhere(
  (s) => s.platformVerdict === true || s.thirdPartyVerdict === true
)

/** Correlated groups with their members, in declaration order. */
export const SIGNAL_GROUP_CAPS: { name: SignalGroupName; cap: number; members: ReadonlySet<SignalName> }[] =
  (Object.keys(SIGNAL_GROUPS) as SignalGroupName[]).map((name) => ({
    name,
    cap: SIGNAL_GROUPS[name].cap,
    members: namesWhere((s) => s.group === name)
  }))
