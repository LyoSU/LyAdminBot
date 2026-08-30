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
  | 'burst' | 'profile_reuse'

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
  /**
   * A trust signal whose whole claim is that there was nothing to read: an
   * emoji, three words, a bare sticker. Marked because such a discount may not
   * be spent on a charge it does not answer.
   *
   * Measured 2026-08-25, over 14 days of production verdicts: conditioned on
   * having seen the account again, `emoji_only` on a quiet verdict predicted a
   * later removal at 5.2x the base rate and `short_message` at 4.0x. Both carry
   * NEGATIVE weight. The sign is inverted because the discount is being read as
   * a statement about the sender when it is only a statement about the message.
   *
   * The concrete case: four identical "💗" from an account whose bio held a
   * private invite scored 0.4502 and were observed four times. Without the
   * `emoji_only` -1.5 the same signals score 0.7858 — removal territory. A
   * discount for "we could not read it" had cancelled an invite link sitting in
   * plain sight on the profile.
   *
   * See `PROFILE_EVIDENCE_SIGNALS` for what suspends these.
   */
  nothingToRead?: true
  /**
   * A fact about the sender's PROFILE — bio, name, avatar, linked channel —
   * as opposed to the message. Read alongside `nothingToRead`: evidence here
   * survives a silent message, because it was never about the message.
   */
  profileEvidence?: true
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
  /**
   * TELEGRAM's own observation about the account's integrity, as opposed to its
   * adjudication of the account's conduct.
   *
   * The distinction earns a third flag rather than reusing either of the two
   * above. It is not `platformVerdict`, because nobody adjudicated anything and
   * there is no appeal — making it grounds for a never-expiring ban would be
   * absurd. And it is not `thirdPartyVerdict`, because the third party here is
   * Telegram itself. But it is emphatically not OUR guess either, which is the
   * only thing chat trust is meant to shield against, so it belongs among the
   * facts that outrank a trust grant.
   */
  accountIntegrity?: true
  /**
   * A match against a rule the pipeline wrote from its OWN verdict and that no
   * human has confirmed. It restates an earlier conclusion about a similar
   * text; it is not a second observation of this one.
   *
   * It may raise the score — recognising a repeat is the whole point of
   * learning — but it may not count toward the bars that license enforcing
   * with no content-reading stage involved, because then an unconfirmed guess
   * corroborates itself. `learning.ts` states the same rule from the writing
   * side: a candidate "may not convict on its own".
   *
   * Production 2026-08-01: a job ad the LLM judged `job_scam` at 0.99 came back
   * 44 minutes later. Its own candidate signature (1.2) plus a vector
   * neighbour (1.0) made 2.2 units of "content evidence" — clearing both bars,
   * so the score passed the grey ceiling and the LLM was never asked. The
   * pipeline acted on a text nothing had read that time, and the echo it acted
   * on was weaker than the reading it displaced.
   *
   * Distinct from the vector neighbour, which stays evidence: that store is
   * fed by confirmed community votes as well as by us, so a hit in it is not
   * purely a memory of our own guess. See `resemblance` for the lesser
   * restriction that one carries.
   */
  priorMatch?: true
  /**
   * The signal says the message LOOKS LIKE something rather than that it
   * CONTAINS something.
   *
   * A resemblance is real evidence — enough to take the message down and every
   * reason to look closer — so unlike `priorMatch` it stays decisive on the
   * lower bar. What it may not do is help clear the higher one: removing the
   * person needs independent facts about the message, and however many things
   * a text resembles, that is one kind of claim, made by us, about similarity.
   *
   * Production 2026-08-01 13:22: an appeal for help carrying a phone number was
   * banned for thirty days by the scoring path. `phone_number` (1.2) plus a
   * neighbour (1.0) came to exactly the 2.0 bar, so the enforcement counted as
   * earned and the gate that would have sent the text to the one stage able to
   * read it never opened. The same sum muted a job ad in a jobs chat two hours
   * earlier. The neighbour fires from 0.85 cosine, on a neighbour that may
   * itself be unconfirmed — a threshold chosen to raise a flag, not to convict.
   */
  resemblance?: true
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
  /**
   * One observation about one photograph. The two tiers are the same finding at
   * different strengths, never two independent facts, so the ceiling is the
   * heavier member alone — the `profile_nsfw` argument applied to re-use.
   */
  profile_reuse: { cap: 1.8 },
  /** One person posting explicit imagery; avatar and stories are not
   *  independent observations of it. */
  profile_nsfw: { cap: 1.2 },
  /** All three derive from the same listing in the same databases. */
  external_ban_source: { cap: 3.5 },
  /**
   * A single promo link usually trips several URL classes at once — and, since
   * 2026-08-01, also gets its destination read. Where a link goes is a second
   * *observation*, but it is not a second link: `promo_in_message_link` belongs
   * in here with the shape classes it comments on, or one URL scores 1.8 + 1.5
   * and clears the sender-removal bar by itself.
   */
  promo_urls: { cap: 3.0 },
  /**
   * Two readings of one behaviour: that the sender is mid-burst, and that the
   * burst has been scoring badly. The second cannot happen without the first,
   * so the ceiling sits at the heavier member rather than at twice it — the
   * `profile_nsfw` argument (an avatar and a story are not two observations of
   * one person posting explicit imagery) applied to conduct.
   */
  burst: { cap: 1.2 }
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
  unofficial_client_risk: { weight: 3.2, kind: 'evidence', accountIntegrity: true },

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
  /**
   * An edit wedged invisible characters into the text.
   *
   * Structural evasion with no innocent reading — the same claim
   * `invisible_in_word` makes, and it sits beside it in the hand-pinned list of
   * signals that alone justify removing the sender. Nobody edits zero-width
   * spaces into their own sentence.
   */
  edit_injected_invisibles: { weight: 2.5, kind: 'evidence' },
  /**
   * An edit added a destination — or an addressee — the message did not carry
   * when it was judged.
   *
   * This half used to share the 2.5 above under the name `edit_injected_promo`,
   * and the name was the argument: "promo" was assumed, never established. The
   * catalogue's own criterion for that weight is evasion with no innocent
   * reading, and adding a link is something members do constantly — "ой, забув
   * посилання" is the same edit as the attack, byte for byte. It became visible
   * the day the delta was first computed at all (2026-08-24): until then the
   * claim had never once been exercised in production, so nothing contradicted
   * it either.
   *
   * Heavy enough to matter and deliberately under the bar that costs somebody
   * the chat: composed with what the link IS (a private invite, a shortener) it
   * reaches removal on the ordinary arithmetic, and composed with nothing it
   * reaches delete-and-ask. Editing a link in after the message passed is a
   * reason to look again, not a verdict — the same position `velocity` was moved
   * to on 2026-08-07.
   */
  edit_injected_link: { weight: 1.2, kind: 'evidence' },

  // ───────────────────── message text ─────────────────────

  long_text: { weight: 0.4, kind: 'evidence' },
  invisible_in_word: { weight: 2.0, kind: 'evidence', highRisk: true },
  mixed_script_word: { weight: 1.5, kind: 'evidence' },
  /**
   * The same act, with the donor alphabet named — and at the weight the act
   * deserves when nobody can claim their keyboard did it.
   *
   * `mixed_script_word` charges 1.5 whether the borrowed letter is a Latin `i`
   * in a Ukrainian word or a Greek rho in a Russian one. Those are not the same
   * event. Measured 2026-08-26 across 3680 unacted decisions and 1182 acted
   * ones: Latin inside Cyrillic appears nine times among the unacted and most
   * are people typing (`пiдкрутка`, `Цитата обрiзана`, `interessно`), while
   * Greek inside Cyrillic appears eleven times among the ACTED, twice among the
   * unacted — both adverts — and zero times among the 1293 unacted messages
   * whose sender the chat already trusted.
   *
   * 2.0 is `SENDER_REMOVAL_MIN_EVIDENCE` exactly, the same number
   * `invisible_in_word` carries, and for the same reason: both are a word built
   * to defeat the layers below rather than to be read, and neither has an
   * innocent version. On the one advert this was measured against it moves the
   * score from 0.7503 to 0.8320 — from the grey band to a deletion in the
   * mildest preset, without reaching the bar for removing the person on its own.
   */
  greek_homoglyph_word: { weight: 2.0, kind: 'evidence' },
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
  signature_candidate_match: { weight: 1.2, kind: 'evidence', priorMatch: true },
  /** Semantically near known spam (raised only above VECTOR_SIGNAL_SIMILARITY). */
  vector_similar_spam: { weight: 1.0, kind: 'evidence', resemblance: true },
  /** The message mentions a bot — promo-relevant, weak on its own. */
  bot_mention: { weight: 0.5, kind: 'evidence' },

  /**
   * The same account posted this same text several times inside the window.
   *
   * Firsthand and about the sender's own conduct — we watched the copies
   * arrive, which is a stronger claim than any match against a stored text.
   * Deliberately just under the sender-removal bar all the same: three copies
   * is a strong reason to take the message down and ask for a captcha, and the
   * catalogue reserves "this alone costs you the chat" for somebody else's
   * verdict on the account and for structural evasion with no innocent reading.
   * Repetition composes — with a signature match or a moderation hit it clears
   * the bar on its own arithmetic, which is the intended route.
   */
  velocity_repeats: { weight: 1.5, kind: 'evidence' },
  /**
   * Several accounts posted the same text. Decisive about THIS message and
   * deliberately short of the bar for removing the person who sent it: the same
   * shape is produced by a coordinated campaign and by a line going round a
   * chat, and only the first is the sender's doing.
   */
  velocity_wave: { weight: 1.2, kind: 'evidence' },

  // ──────────────── conduct across messages (shape) ────────────────
  // Both are about the sender's PATTERN, not about this sentence, which is why
  // neither is `evidence` however clear the pattern looks. `velocity` was the
  // pipeline's one repetition-as-verdict stage and the 2026-08-07 audit priced
  // it: 10 of 52 known false positives, 16% of its own verdicts, because
  // cross-posting is something members do. Repetition opens the gate to the
  // stage that can READ the messages; it does not answer in its place.

  /**
   * Several DIFFERENT messages from this account inside the window.
   *
   * Distinctness is measured on the heavy template, so copies of one text are
   * one message here — `velocity_repeats` (1.5) already charges for those, and
   * counting them twice is the double-billing the group caps exist to stop.
   *
   * Light on its own by design: three messages in a few minutes is what an
   * argument looks like, and the whole value of the signal is opening the
   * classifier's gate for the blob (see `burstBlob`), not the weight.
   */
  sender_burst: { weight: 0.8, kind: 'shape', group: 'burst' },
  /**
   * Two or more of those messages already scored above the grey floor.
   *
   * Heavier than the bare burst because it is no longer only a cadence: the
   * pipeline looked at each of them separately and each time came back unsure
   * rather than clean. A sender who keeps landing at 0.4 is a different fact
   * from a sender who is merely talkative.
   */
  burst_grey_repeat: { weight: 1.0, kind: 'shape', group: 'burst' },

  /**
   * A link in THIS message leads to a channel that is itself an advert.
   *
   * Evidence, unlike its profile-side twin `promo_in_linked_channel`, and the
   * distinction is not a technicality: what an account keeps in its bio is a
   * fact about the account, while what the sender chose to put in this sentence
   * is what the sentence is doing.
   *
   * Below the sender-removal bar all the same. The destination is read from
   * Telegram's public web preview, which is a page anybody can put anything on
   * — good enough to take the message down and ask, not good enough to be the
   * sole reason somebody loses the chat.
   */
  promo_in_message_link: { weight: 1.5, kind: 'evidence', group: 'promo_urls' },

  // ───────────────────── profile / identity (shape) ─────────────────────

  /**
   * A promo URL in the bio — a website, a shortener, a messenger contact, a bot
   * deeplink. Still low, and lower than it was: measured over 3797 stored bios
   * on 2026-08-25, a bio carrying an ordinary URL sat at −0.14 log-odds against
   * a bio carrying none, 95% CI [−0.72, +0.44] on n=68. Zero, in other words,
   * and the old 1.2 fell far outside that interval — the weight was being
   * charged for a property that carries no information, which is the same
   * confirmed v1 FP class (innocent website bios) written down as a number.
   *
   * Not taken to nothing: the interval is wide at n=68, and this branch also
   * covers shorteners and messenger contacts, which the corpus never separated
   * out and which hide their destination by construction.
   */
  promo_in_bio: { weight: 0.3, kind: 'shape', group: 'profile_promo', profileEvidence: true },
  /**
   * A private invite (`t.me/+…`) in the bio — the same corpus, the other end of
   * it: 907 such bios, 62.5% known-bad against a 24.6% baseline for bios with no
   * URL at all. +1.63 log-odds, 95% CI [+1.47, +1.79].
   *
   * `classifyUrl` has always computed this kind and `promoIn` has always thrown
   * it away, so the one URL class that carries information was priced like the
   * one that carries none. That flatness is also why the comparison survives its
   * own circularity: the label counts our past detections, but the old signal
   * fired identically on every URL kind, so it cannot have manufactured a
   * difference BETWEEN kinds — only a common shift in all of them.
   *
   * Weighted at the bottom of the interval rather than at the point estimate:
   * 1.63 is a MARGINAL odds ratio, and a bio like this also tends to belong to a
   * new account that says little, so some of that effect is already being paid
   * to the signals firing beside this one. Still shape, still inside
   * `profile_promo` — it clears no evidence bar, so alone it can only ask.
   */
  private_invite_in_bio: { weight: 1.5, kind: 'shape', group: 'profile_promo', profileEvidence: true },
  /**
   * A phone number or a cashtag in the bio: not a link, but a way to be reached
   * or paid off-platform. Split out of `promo_in_bio` keeping its old weight,
   * precisely BECAUSE the corpus that re-priced the URL branch says nothing
   * about this one — a measurement about websites must not quietly re-price
   * phone numbers.
   */
  contact_in_bio: { weight: 1.2, kind: 'shape', group: 'profile_promo', profileEvidence: true },
  /**
   * Promo URL / foreign @handle carried in the display name or username itself.
   * Nobody names themselves after a promo link by accident, so this is the
   * highest-precision profile signal we have — but it is still about WHO, not
   * WHAT, so it stays shape.
   */
  promo_in_name: { weight: 1.8, kind: 'shape', group: 'profile_promo', profileEvidence: true },
  /** Linked personal channel — weak alone (legit users have them too). */
  personal_channel: { weight: 0.5, kind: 'shape', group: 'profile_promo', profileEvidence: true },
  /**
   * The channel the profile points at turned out to be an advert itself — its
   * title or its own description reads the way a promo bio reads.
   *
   * Heavier than a raw link in a bio because it is a step less ambiguous: a link
   * in a bio may be a second account or a friend's, while a channel whose blurb
   * is a price list has stated its purpose. Still shape, and still
   * capped with the rest of `profile_promo` — one profile advertised in several
   * places is one profile.
   */
  promo_in_linked_channel: { weight: 1.5, kind: 'shape', group: 'profile_promo', profileEvidence: true },
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
  /**
   * This exact photograph is on ONE other account we have seen.
   *
   * Shape, not evidence, and weighted like a hint: people do share pictures.
   * A meme, a film still, a club crest, a national flag, two partners using the
   * same holiday photo — all ordinary, and none of them is a campaign. What
   * makes this worth raising at all is that it is the only thing in the
   * pipeline that can observe two senders being one operator.
   */
  avatar_shared_with_account: { weight: 0.8, kind: 'shape', group: 'profile_reuse', profileEvidence: true },
  /**
   * The same photograph on THREE or more accounts.
   *
   * Evidence, and heavy, because at that point the innocent explanations run
   * out. A batch of accounts dressed from one folder is what an account farm
   * looks like from the outside, and it is a fact about the bytes rather than a
   * reading of anyone's intent — which is exactly the kind of finding this
   * pipeline is otherwise short of.
   *
   * Still not a hard verdict on its own: it says the accounts are operated
   * together, not that this message is an advert. `DECISIVE_MIN_WEIGHT` lets it
   * license acting on the message; `SENDER_REMOVAL_MIN_EVIDENCE` deliberately
   * does not let it remove the person by itself.
   */
  avatar_shared_with_accounts: { weight: 1.8, kind: 'evidence', group: 'profile_reuse', profileEvidence: true },
  nsfw_avatar: { weight: 1.0, kind: 'shape', group: 'profile_nsfw', profileEvidence: true },
  /**
   * Profile media that is suggestive without being explicit — lingerie, a pose,
   * a mirror selfie. The escort-bot norm, and measured: the avatar of a
   * production promo account on 2026-08-24 scored `sexual` 0.373 with the
   * provider's own `flagged` at false, against a profile bar of 0.8 written to
   * ask "is this pornography". The answer was no, and the account was one all
   * the same.
   *
   * Deliberately its own name rather than a lower bar on `nsfw_avatar`: the two
   * are not the same claim. Explicit imagery on a new account's profile is a
   * finding; a suggestive picture is a fact about a photograph, and honest
   * people post those — as they post self-harm awareness, hunting knives and
   * war photography, all of which this provider scores. So this one may add
   * weight and open the classifier's gate, and it may never satisfy the
   * deterministic rule about a profile-as-advert.
   */
  suggestive_profile_media: { weight: 0.8, kind: 'shape', group: 'profile_nsfw', profileEvidence: true },
  nsfw_stories: { weight: 0.9, kind: 'shape', group: 'profile_nsfw', profileEvidence: true },
  /** Explicit imagery on the channel the profile points at — same group, for
   *  the same reason: it is one person's imagery, seen in one more place. */
  nsfw_linked_channel: { weight: 1.0, kind: 'shape', group: 'profile_nsfw', profileEvidence: true },

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
  /**
   * One photo, recent, on a years-old account — the signature of a stolen
   * account that has been re-dressed. See the producer in `user.ts` for why
   * each clause is needed.
   *
   * Deliberately NOT in the `newness` group: it is the opposite claim. The
   * newness signals say "this account has no history"; this one says the
   * account has plenty of history and somebody erased the part that had a face
   * in it. Grouping them would let a ceiling written for restatements of
   * newness swallow an independent observation.
   */
  sole_avatar_replaced: { weight: 1.2, kind: 'shape', profileEvidence: true },
  /** Joined the chat <2min before posting. */
  just_joined: { weight: 1.0, kind: 'shape', group: 'newness' },
  /** Joined inside a high-rate episode; routing context, never message proof. */
  joined_during_surge: { weight: 0.5, kind: 'shape', group: 'newness' },
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

  // ───────────────────── trust ─────────────────────
  // Premium is deliberately absent: spammers buy premium for visibility.

  is_reply: { weight: -1.0, kind: 'trust' },
  recent_reply: { weight: -0.8, kind: 'trust' },
  media_only: { weight: -1.5, kind: 'trust', nothingToRead: true },
  emoji_only: { weight: -1.5, kind: 'trust', nothingToRead: true },
  internal_link_only: { weight: -1.0, kind: 'trust', nothingToRead: true },
  short_message: { weight: -0.8, kind: 'trust', nothingToRead: true },
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

/**
 * Matches against rules we wrote ourselves and nobody confirmed — see
 * `SignalSpec.priorMatch`. They carry weight, but they never license enforcing
 * on a message no stage has read.
 */
export const PRIOR_MATCH_SIGNALS = namesWhere((s) => s.priorMatch === true)

/**
 * Signals asserting that the message looks like something, not that it contains
 * something — see `SignalSpec.resemblance`. They may condemn the message; they
 * never help make up the evidence for removing the person who sent it.
 */
export const RESEMBLANCE_SIGNALS = namesWhere((s) => s.resemblance === true)

/**
 * Trust discounts whose only claim is that the message carried nothing to read
 * — see `SignalSpec.nothingToRead`.
 */
export const NOTHING_TO_READ_SIGNALS = namesWhere((s) => s.nothingToRead === true)

/**
 * Facts about the sender's profile rather than about the message — see
 * `SignalSpec.profileEvidence`.
 */
export const PROFILE_EVIDENCE_SIGNALS = namesWhere((s) => s.profileEvidence === true)

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
 * Stated by somebody other than us — the only grounds on which a chat-trusted
 * member is still actioned. A listed account deserves the pipeline even here;
 * what it does not deserve is a permanent ban, which is why this set and
 * `PERMANENT_BAN_SIGNALS` are no longer the same set.
 *
 * `accountIntegrity` joined on 2026-08-24. The file's own principle is that
 * trust shields against OUR judgement and not against somebody else's finding,
 * and `unofficial_client_risk` is Telegram's finding, not ours — yet it was
 * excluded, so the longest-standing form of the sold-account threat model was
 * the one case nothing could reach. A trusted member whose account had changed
 * hands kept the shield against the single heaviest signal in the catalogue.
 */
export const OVERRIDES_CHAT_TRUST_SIGNALS = namesWhere(
  (s) => s.platformVerdict === true || s.thirdPartyVerdict === true || s.accountIntegrity === true
)

/**
 * Findings a THIRD party made — the external ban databases, lols and CAS.
 *
 * Split out from `OVERRIDES_CHAT_TRUST_SIGNALS` because it is the one family a
 * chat may decline: `externalBanEnabled` says "we do not honour those lists".
 * Telegram's own scam flag is not covered by that setting and neither is an
 * integrity finding, so a set that lumped all three together would let one
 * member's report overrule a chat's stated preference.
 */
export const THIRD_PARTY_VERDICT_SIGNALS = namesWhere((s) => s.thirdPartyVerdict === true)

/** Correlated groups with their members, in declaration order. */
export const SIGNAL_GROUP_CAPS: { name: SignalGroupName; cap: number; members: ReadonlySet<SignalName> }[] =
  (Object.keys(SIGNAL_GROUPS) as SignalGroupName[]).map((name) => ({
    name,
    cap: SIGNAL_GROUPS[name].cap,
    members: namesWhere((s) => s.group === name)
  }))
