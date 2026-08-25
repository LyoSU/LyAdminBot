/**
 * Policy: calibrated pSpam → enforcement action. Separated from scoring so
 * that thresholds (a product decision) never leak into signal weights
 * (a statistics decision).
 *
 * Severity ladder: none < observe < captcha < delete < kick < mute < ban.
 *
 * Design rules:
 *  - Discussion groups (channel comments) get a captcha only when it can be
 *    whispered to the commenter alone. A prompt everyone in a comment thread
 *    reads is clutter the commenter will probably bounce off; an ephemeral one
 *    is invisible to the thread.
 *  - Kick (2026-07-27) fills the gap between "delete the message" and
 *    "restrict the person for a day". A drive-by account that dropped one
 *    promo is removed but may rejoin; the punishment expires the moment they
 *    stop, which is the right shape for a mistake we might have made.
 *  - Ban is reserved for newish users. An established account at ban-level
 *    pSpam is more likely compromised than malicious — mute is reversible.
 *  - Ban is TIMED unless there are hard grounds (Telegram scam/fake flag,
 *    external ban database, labelled spam restriction). A real spam bot does
 *    not wait 30 days to come back; a false positive heals itself.
 *  - Trusted users are capped at delete+vote even at pSpam 0.99: a single
 *    pipeline mistake on a regular must never escalate to kick/mute/ban.
 *  - Voting is for the band where we are NOT confident. Above the mute
 *    threshold the pipeline is sure enough that asking the chat only adds
 *    noise; below it, a second opinion is worth the prompt.
 *  - NaN / out-of-range pSpam fails safe to observe (never to action).
 */
import type { StrictnessPreset, Verdict, VerdictAction, ChatKind } from './types.js'

export interface PolicyInput {
  pSpam: number
  preset: StrictnessPreset
  chatKind: ChatKind
  captchaEnabled: boolean
  votingEnabled: boolean
  /** Few local messages / fresh local age — the "could be a drive-by" class. */
  userIsNewish: boolean
  /** Chat-level trusted list or trusted reputation. */
  userIsTrusted: boolean
  /**
   * The account is already known bad — a Telegram scam/fake flag, a ban
   * database, a spam restriction, prior confirmed detections. This is what
   * cancels the standing shield below, on the same grounds it already cancels
   * `established_user` and the established-regular exempt: what looks like
   * standing was built out of the spam we are judging.
   */
  userHasHardVerdict: boolean
  /**
   * The captcha can be delivered as an ephemeral message — visible to the
   * suspect alone (Bot API 10.2). This is what lifts the discussion-group
   * exclusion below: the objection to captcha under a channel post was that it
   * clutters a comment thread everybody reads. A prompt nobody else can see
   * does not.
   */
  ephemeralCaptcha?: boolean
  /**
   * Evidence that this account is known-bad rather than merely suspicious:
   * a Telegram scam/fake flag, an external ban listing, or a spam-labelled
   * restriction. Only these earn a permanent ban; everything else expires.
   */
  hasPermanentBanGrounds?: boolean
}

export interface PolicyDecision {
  action: VerdictAction
  needsVote: boolean
  /**
   * Ban length in seconds; null means permanent. Meaningful only when
   * `action === 'ban'` — other actions carry their own fixed windows.
   */
  banDurationSeconds: number | null
}

export interface PresetThresholds {
  ban: number
  mute: number
  kick: number
  delete: number
  /** Lower edge of the grey zone: observe / captcha territory. */
  grey: number
}

/** A timed ban long enough to outlast any campaign, short enough to heal an FP. */
export const TIMED_BAN_SECONDS = 30 * 24 * 60 * 60

/**
 * Actions that remove the message from the chat and act on the sender.
 *
 * Exported because three separate places used to spell this list out by hand
 * (the soft-shape guard, the conversation-window bookkeeping, the executor).
 * Adding `kick` to the union meant remembering all three; whichever one you
 * forgot failed silently and only in production.
 */
export const ENFORCEMENT_ACTIONS = ['delete', 'kick', 'mute', 'ban'] as const

export const isEnforcementAction = (action: VerdictAction): boolean =>
  (ENFORCEMENT_ACTIONS as readonly VerdictAction[]).includes(action)

/**
 * Actions that act on the *person*, not just the message. The distinction is a
 * policy fact, not a formatting detail: `delete` costs the chat one line and
 * heals by itself, while these three take the chat away from the sender. The
 * pipeline requires strictly more evidence before crossing this line
 * (see `mayRemoveSender`).
 */
export const SENDER_REMOVING_ACTIONS = ['kick', 'mute', 'ban'] as const

export const removesSender = (action: VerdictAction): boolean =>
  (SENDER_REMOVING_ACTIONS as readonly VerdictAction[]).includes(action)

/**
 * The vocabulary the classifier is allowed to answer with.
 *
 * This lives in core rather than beside the port that sends it because two
 * things downstream must agree with it and neither is the port:
 * `IMITABLE_REASON_CODES` below picks three of these codes out for a ceiling,
 * and the UI keeps a translation per code. The list used to be declared inside
 * `llm-port.ts`, one package away from the ceiling that filters it — two string
 * literals with nothing but goodwill holding them level. Retiring a code there
 * would have left the ceiling matching a string the model can no longer emit,
 * and a ceiling that silently stops applying is worse than one that was never
 * written: the tests that cover it keep passing, because they name the code
 * too. Declared here, that same edit fails to compile.
 *
 * `unsure` is deliberately answerable — a model forced to choose a label it
 * does not believe will invent one.
 */
export const LLM_REASON_CODES = [
  'job_scam', 'crypto_scam', 'gambling_promo', 'adult_promo', 'ad_network',
  'flirt_bait', 'phishing', 'channel_promo', 'guest_bot_promo', 'flood',
  'prompt_injection', 'other_spam',
  'legit_question', 'legit_conversation', 'legit_share', 'other_clean', 'unsure'
] as const

export type LlmReasonCode = (typeof LLM_REASON_CODES)[number]

/**
 * Reason codes that name an act ordinary members also perform.
 *
 * Every other spam code names something a member does not do: nobody recruits
 * for a fake job, phishes, or posts an escort ad by accident. Recommending a
 * channel, or promoting a thing they made, is different — the ACT is identical
 * whoever performs it, and only intent separates the two. Intent is what a
 * classifier cannot observe, so on these codes it is guessing, and the audit
 * says exactly that: 2026-08-07, 14 days of production, 12 of 52 known false
 * positives were `channel_promo` — 13% of its 90 verdicts, against 0.34% for
 * `job_scam` over 590. One code, a quarter of all our mistakes.
 *
 * `ad_network` joins it on the same mechanism rather than on its own record
 * (14 verdicts, no complaint): a replay of the reversed calls through the
 * 2026-08-07 model returned `ad_network` at 0.99 for a member advertising
 * something of their own that an admin had cleared. The code inherits the
 * class, so it inherits the ceiling before it inherits the false positives.
 *
 * `flood` belongs here for the same reason and was nearly missed: 2026-08-07
 * 16:42:50, a member with `established_user` (-1.5) and `is_reply` (-1) was
 * muted for `flood` over five lines of ordinary chat. Talking quickly is the
 * most imitable act there is. Note this is NOT the repetition the velocity
 * signals report — those are copies we watched arrive, firsthand and weighed;
 * this is a classifier's opinion about conversational style.
 *
 * The consequence is a ceiling, not an exemption: the message still goes and
 * the chat is still asked. See `capImitableAct` in the pipeline.
 */
const IMITABLE = ['channel_promo', 'ad_network', 'flood'] as const satisfies
  readonly LlmReasonCode[]

/**
 * Kept as `ReadonlySet<string>` on purpose: `Verdict.reasonCode` is a plain
 * string because rule ids share the field with the model's vocabulary, and a
 * narrower set would only force a cast back at every call site. The check that
 * matters is on the literals above, where `satisfies` fails the build if a code
 * here is not one the model can return.
 */
export const IMITABLE_REASON_CODES: ReadonlySet<string> = new Set(IMITABLE)

/**
 * Whether a verdict is firm enough to be remembered AGAINST THE ACCOUNT rather
 * than only against the message.
 *
 * `spamDetections` is the counter three separate mechanisms read: the
 * `prior_spam_detections` signal, the established-regular bypass, and the
 * shield that keeps a non-newish account at `mute` instead of `ban`. Two hits
 * strip all three (`HARD_VERDICT_MIN_DETECTIONS`), so the bar to earn one hit
 * has to be higher than the bar to delete a message.
 *
 * Excluded, and why each exclusion is the whole point:
 *  - a verdict the pipeline itself hedged on. `content_unconfirmed` is the
 *    capped removal — arithmetic wanted the sender gone and the message
 *    evidence did not earn it. Counting that as a hard fact about the account
 *    would let two unconfirmed suspicions add up to a certainty.
 *  - a verdict still out for a vote. The chat has not answered yet; recording
 *    it now would mean the question was rhetorical.
 *
 * Everything else that removed the message counts, including a plain `delete`:
 * the pipeline was sure enough to act without asking.
 */
export const countsAsDetection = (verdict: {
  action: VerdictAction
  needsVote: boolean
  reasonCode: string
}): boolean =>
  isEnforcementAction(verdict.action) &&
  !verdict.needsVote &&
  verdict.reasonCode !== 'content_unconfirmed'

/**
 * Whether a verdict is about the SENDER at all, or only about our own rules.
 *
 * The executor refuses to act on three grounds — the sender is an admin, is us,
 * or is trusted in this chat — and each is a decision we made about who they
 * are, not a finding about what they wrote. Recording it against the account
 * anyway means the exemption quietly erodes the very standing it exists to
 * protect: production to 2026-08-22 shows one admin at 25 `prior_spam_detections`
 * without a single verdict about them ever being applied, and two detections are
 * enough to strip the established-regular bypass and the ban shield.
 *
 * Deliberately NOT a function of whether the action succeeded. Telegram refusing
 * a delete is a fact about our rights in that chat, and a chat where enforcement
 * fails is precisely where unearned standing piles up fastest — so those still
 * count. The distinction this draws is between "we could not" and "we chose not
 * to", which the executor already records and nothing consulted.
 */
export const countsAgainstSender = (skippedReason: string | null): boolean =>
  skippedReason === null

/**
 * Whether there is anything of OURS to give back.
 *
 * Restitution lifts restrictions with `restrictChatMember({})` and
 * `unbanChatMember`, which undo whatever is in place regardless of who put it
 * there. That is right for correcting our own mistake and wrong for anything
 * else, and until 2026-08-23 nothing separated the two: a community vote can be
 * opened by `/report` on ANY message, so three ham ballots about a message the
 * pipeline never touched would quietly lift an admin's own `/banan`.
 *
 * A missing verdict reads as "not ours". With the vote window down to fifteen
 * minutes this cannot mean "the record expired" — decisions are kept for days —
 * so the only thing it can mean is that we never judged this message.
 */
export const needsRestitution = (verdict: Pick<Verdict, 'action'> | null): boolean =>
  verdict !== null && verdict.action !== 'none' && verdict.action !== 'observe'

/**
 * Whether restitution should lift restrictions, or only give standing back.
 *
 * `needsRestitution` asks whether any of this was ours; this asks whether we
 * took away the right to speak. The distinction is not cosmetic, because
 * `restrictChatMember({})` and `unbanChatMember` undo whatever is in place
 * whoever imposed it: after a delete-only verdict there is no restriction of
 * ours to lift, so lifting one can only remove somebody else's — an admin's
 * `/banan` on the same person, still running.
 *
 * `kick` is excluded for the same reason from the other side: it is a ban
 * immediately undone, so by the time anyone votes there is nothing to unban.
 */
export const restitutionLiftsRestrictions = (
  verdict: Pick<Verdict, 'action' | 'requireCaptcha'> | null
): boolean => {
  if (verdict === null) return false
  if (verdict.action === 'captcha' || verdict.action === 'mute' || verdict.action === 'ban') return true
  // The uncertain delete gates the sender for ten minutes on its way out.
  return verdict.action === 'delete' && verdict.requireCaptcha === true
}

export const PRESET_THRESHOLDS: Record<StrictnessPreset, PresetThresholds> = {
  soft: { ban: 0.98, mute: 0.94, kick: 0.86, delete: 0.78, grey: 0.55 },
  standard: { ban: 0.95, mute: 0.88, kick: 0.75, delete: 0.6, grey: 0.4 },
  strict: { ban: 0.92, mute: 0.84, kick: 0.7, delete: 0.55, grey: 0.32 }
}

/**
 * Whether this chat and this sender may be asked a captcha at all.
 *
 * Exported because two places need the identical answer and used to be able to
 * disagree. `decideAction` asks it for the grey band; the low-information branch
 * asks it when the arithmetic came out ABOVE the grey band and has to be pulled
 * back down to a question — that branch has not read the message, so a captcha
 * is its ceiling however high the score climbs. Written twice, the second copy
 * would eventually grant a captcha where the first refused one.
 */
export const mayAskCaptcha = (input: PolicyInput): boolean =>
  input.captchaEnabled && input.userIsNewish &&
  (input.chatKind !== 'discussion' || input.ephemeralCaptcha === true)

export const decideAction = (input: PolicyInput): PolicyDecision => {
  const t = PRESET_THRESHOLDS[input.preset] ?? PRESET_THRESHOLDS.standard
  const p = input.pSpam

  // Fail safe: a broken score must never trigger enforcement. `Number.isFinite`
  // alone let an out-of-range value (a miscalibrated port returning 5.0) sail
  // past every threshold straight to ban, so the range is checked too.
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return { action: 'observe', needsVote: false, banDurationSeconds: null }
  }

  /** Vote only where the pipeline is genuinely unsure (below mute level). */
  const uncertain = input.votingEnabled && p < t.mute
  const decide = (action: VerdictAction, needsVote = false): PolicyDecision =>
    ({ action, needsVote, banDurationSeconds: null })

  // Trusted members are capped at delete regardless of score. This IS the
  // contested case — high confidence against high standing — so it always
  // asks the chat, even above the mute threshold.
  if (input.userIsTrusted && p >= t.delete) {
    return decide('delete', input.votingEnabled)
  }

  // Standing spares an account the two irreversible actions — but standing an
  // account earned by spamming is not standing. Production 2026-07-31: a known
  // repeat offender was muted at pSpam 1.00 twice in half an hour because
  // `userIsNewish` had decayed to false, so the longer it had been spamming the
  // milder its treatment got. Note this only chooses between mute and ban for a
  // message already judged removable; it lowers no threshold.
  const shielded = !input.userIsNewish && !input.userHasHardVerdict

  if (p >= t.ban && !shielded) {
    return {
      action: 'ban',
      needsVote: false,
      banDurationSeconds: input.hasPermanentBanGrounds === true ? null : TIMED_BAN_SECONDS
    }
  }
  if (p >= t.mute) return decide('mute')
  // Kick needs newness: removing an account with local standing over a
  // single grey-band message is worse than deleting it and watching.
  if (p >= t.kick && input.userIsNewish) return decide('kick', uncertain)
  if (p >= t.delete) return decide('delete', uncertain)
  if (p >= t.grey) return decide(mayAskCaptcha(input) ? 'captcha' : 'observe')

  return decide('none')
}
