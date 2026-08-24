/**
 * User-level signal extraction. Pure function over UserSnapshot.
 *
 * Production-calibration note (2026-06-11 prod-DB review): sleeper_awakened
 * was v1's loudest rule AND its main FP source (lost-pet posts, local venue
 * promos from old quiet accounts). Here it is only a fact; scoring keeps its
 * weight below auto-action threshold so policy routes it through vote.
 */
import type { Signal, UserSnapshot } from '../types.js'
import { truncate } from '../text/normalize.js'
import { classifyUrl, URL_TOKEN_REGEX, PROMO_URL_KINDS } from './urls.js'

const SLEEPER_GAP_DAYS = 365
const SLEEPER_LOCAL_MAX_DAYS = 30
const FRESH_ACCOUNT_MAX_DAYS = 30
const IDENTITY_CHURN_MIN = 3
const NEW_IN_CHAT_MAX = 3
const NEW_GLOBALLY_MAX = 5
const EXTERNAL_REPEAT_OFFENSES_MIN = 2
const FRESH_EXTERNAL_BAN_MAX_DAYS = 2
const MANY_SHARED_CHATS_MIN = 5
/**
 * How many confirmed detections make a pattern rather than an accusation.
 *
 * Exported since 2026-08-23 because the right to vote asks the same question at
 * the same bar — an account the system has twice found to be spamming does not
 * get a say in whether the next one is. Since 2026-08-24 `hasHardAccountVerdict`
 * reads it too; the pipeline used to keep a `HARD_VERDICT_MIN_DETECTIONS` of its
 * own beside a list that disagreed with this file's. A second copy of a number
 * is a second place to forget when it moves.
 */
export const PRIOR_DETECTIONS_MIN = 2
const JUST_JOINED_MAX_SECONDS = 120
const AVATAR_FRESH_MAX_DAYS = 7

const MS_PER_DAY = 86_400_000
const SECONDS_PER_DAY = 86_400

/**
 * What earns `established_user` — the one signal every stage reads when it asks
 * whether the sender has standing: the trust weight, both enforcement ceilings
 * (`hasSenderStanding`), and the clean rules.
 *
 * Exported because the pipeline's established-regular exempt is the same
 * decision at the same bar, and it used to keep its own copy of these numbers.
 * One definition, because the two disagreed in the way that matters: the exempt
 * accepted local standing OR global volume and this signal accepted only the
 * global half, so a quiet regular of one chat was a stranger to every stage
 * past the exempt — and the exempt stands down for exactly the messages that
 * can cost somebody the chat (2026-08-20 report).
 */
export const ESTABLISHED_MIN_MESSAGES = 50
export const ESTABLISHED_MIN_IN_CHAT = 10
export const ESTABLISHED_MIN_TENURE_DAYS = 7

/**
 * Already condemned by somebody — Telegram, an external database, or our own
 * confirmed record — and therefore ineligible for any form of standing.
 *
 * ONE definition, because there were two and they disagreed. This file used to
 * hold a private `hasHardVerdict` guarding the `established_user` signal, and
 * the pipeline a private `hasHardAccountVerdict` guarding the established-
 * regular exempt; the pipeline's listed `spamDetections` and
 * `unofficialClientRisk` and this one did not. The gap was not theoretical:
 * 1969 verdicts in the 14 days to 2026-08-24 carried `established_user`
 * *together with* `prior_spam_detections` — accounts the pipeline refused the
 * exempt to, still collecting the −1.5 trust weight and `hasSenderStanding`
 * from the signal, roughly 140 a day.
 *
 * Two lists asking one question is a duplication; two lists asking one question
 * and answering differently is the shield being open on one side.
 *
 * The executor keeps a THIRD, deliberately narrower test
 * (`OVERRIDES_CHAT_TRUST_SIGNALS`) and that one is not a duplicate of this: it
 * governs trust an admin granted by hand, which only somebody else's verdict
 * may override — never our own `spamDetections`, or a misfire would revoke a
 * decision a human made.
 *
 * The merge is not a union of the two lists. They differed on two entries and
 * each is settled on its own merits:
 *
 *  - `spamDetections` JOINS, at `PRIOR_DETECTIONS_MIN`. Two confirmed findings
 *    of our own are a pattern, and the threat model this guard exists for is
 *    precisely the long-time account that has started spamming. One detection
 *    stays harmless, so a single false positive still cannot compound.
 *  - `unofficialClientRisk` does NOT. It reports which software the account
 *    connects with, not a judgement anybody passed on the person, and a
 *    third-party client is not an offence. It already weighs 3.2 as evidence,
 *    which is where a heuristic belongs. The signal file has said so in a test
 *    since it was written; the pipeline's list simply never asked it.
 *
 * No `policy` parameter, unlike the copy this replaces. Whether a chat consults
 * the ban databases is settled once, at the pipeline's door, so that every
 * reader downstream sees one story — see `evaluateMessage`.
 */
export const hasHardAccountVerdict = (user: UserSnapshot): boolean =>
  user.flags.scam ||
  user.flags.fake ||
  user.externalBan?.banned === true ||
  user.spamDetections >= PRIOR_DETECTIONS_MIN ||
  user.reputationStatus === 'suspicious' ||
  user.reputationStatus === 'restricted' ||
  user.restrictionReasons.some((r) => /spam|scam/i.test(r))

/**
 * How long this sender has demonstrably been around, in days — null when
 * nothing says.
 *
 * Two clocks measure it and neither is complete. `localAgeDays` counts from the
 * first time WE saw the account anywhere, so it restarts at zero whenever our
 * own record does: a v1→v2 migration, the 2026-07-06 quota cleanup, a chat the
 * bot only just joined. `joinedAgoSeconds` is Telegram's own answer for THIS
 * chat (channels.getParticipant.date), so it survives anything we do to our
 * database, and says nothing about the rest of the network.
 *
 * Both are lower bounds on real tenure, so the larger is the honest reading and
 * can only be closer to the truth. Until 2026-08-20 only the first was consulted
 * for tenure while the second was read exclusively to accuse (`just_joined`):
 * the bot knew to the second when somebody had joined and spent that fact only
 * against them. A hole in our records thereby counted as a fact about the
 * person, always in the direction of the harsher action.
 */
export const tenureDays = (user: UserSnapshot): number | null =>
  mergeTenureDays(user.localAgeDays, user.joinedAgoSeconds)

/**
 * The same reading, for callers that hold the two clocks without a whole
 * `UserSnapshot` — the ballot check is one (`voteEligibility`).
 *
 * It lives here, and is imported there, so that there is exactly one answer to
 * "how long has this person been around". A second one would drift, which is
 * the failure this file already carries a scar from: until 2026-08-23 the
 * ballot check had its own idea of tenure — our first-seen date alone — and so
 * refused every non-admin in a chat the bot had just been added to, for a week,
 * while `joinedDate` sat unread in a response the same code path had already
 * fetched to test for adminship.
 */
export const mergeTenureDays = (
  localAgeDays: number | null,
  joinedAgoSeconds: number | null
): number | null => {
  const joined = joinedAgoSeconds !== null ? joinedAgoSeconds / SECONDS_PER_DAY : null
  if (localAgeDays === null) return joined
  if (joined === null) return localAgeDays
  return Math.max(localAgeDays, joined)
}

/**
 * Standing earned in THIS chat: enough messages here, and enough time to have
 * said them. The tenure half is not decoration — the counters rise on every
 * message with no rate or quality condition, so without it a spammer's
 * afternoon in a group they control would buy the shield (2026-07-30 review).
 */
const hasLocalStanding = (user: UserSnapshot): boolean => {
  const tenure = tenureDays(user)
  return user.messagesInChat >= ESTABLISHED_MIN_IN_CHAT &&
    tenure !== null && tenure >= ESTABLISHED_MIN_TENURE_DAYS
}

/**
 * Volume in either scope — standing here, or a long history across our chats.
 * Named separately from the verdict half so the age signals can ask "does this
 * person have standing?" without re-deriving the answer a few lines later.
 */
const hasVolumeForStanding = (user: UserSnapshot): boolean =>
  user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES || hasLocalStanding(user)

/**
 * Invisible characters with no legitimate use in a display name. Deliberately
 * narrow: ZWJ/ZWNJ are excluded (real emoji sequences and Persian/Arabic names
 * need them) and so are the LTR/RTL *marks* (legitimate in bidirectional
 * names). What remains is padding and the bidi OVERRIDES, which exist only to
 * make a name render as something other than what it is.
 *
 * Escapes, not literals: invisible characters pasted into source are invisible
 * to reviewers too, and a stray one would silently widen the class.
 */
const INVISIBLE_IN_NAME_REGEX =
  /[\u2060\u200B\u00AD\uFEFF\u202D\u202E\u180E]/

/** A foreign @handle embedded in a display name (not the user's own). */
const HANDLE_IN_NAME_REGEX = /@([a-z0-9_]{5,32})\b/gi

/**
 * Promo carried by the identity itself — "Заробіток 💰 t.me/+abc" as a display
 * name, or a username-shaped advert. Nobody picks a promo URL as their name by
 * accident, so precision is high; it is nonetheless a statement about WHO the
 * sender is, not about the message, so scoring keeps it soft-shape.
 *
 * A handle matching the user's OWN username is ignored: duplicating your
 * handle into your display name is common and harmless.
 */
const findNamePromo = (user: UserSnapshot): string | null => {
  const ownHandle = user.username?.toLowerCase() ?? null
  for (const field of [user.displayName, user.username]) {
    if (!field) continue

    for (const token of field.match(URL_TOKEN_REGEX) ?? []) {
      // t.me/<something> in a NAME is promo even though the same link inside a
      // message is merely "telegram_internal" — a name is not a place to link.
      if (/^(?:https?:\/\/)?(?:t|telegram)\.me\//i.test(token)) return token
      if (!PROMO_URL_KINDS.has(classifyUrl(token).kind)) continue
      // A BARE host is not enough here. Plenty of real names look like one to
      // the URL tokenizer — "user.name" and "anna.co" hit live TLDs — and the
      // cost of that false positive lands on an innocent member. Requiring a
      // scheme, a path, or a known shortener keeps the precision that makes
      // this signal worth having.
      if (/^https?:\/\//i.test(token)) return token
      if (/^[^/]+\/\S/.test(token)) return token
      if (classifyUrl(token).kind === 'shortener') return token
    }

    for (const [, handle] of field.matchAll(HANDLE_IN_NAME_REGEX)) {
      if (handle && handle.toLowerCase() !== ownHandle) return `@${handle}`
    }
  }
  return null
}

export const extractUserSignals = (user: UserSnapshot, now = Date.now()): Signal[] => {
  const signals: Signal[] = []

  // ── Telegram-level flags (free with every update) ──────────────────

  if (user.flags.scam) signals.push({ name: 'scam_flag' })
  if (user.flags.fake) signals.push({ name: 'fake_flag' })
  if (user.flags.restricted) signals.push({ name: 'restricted_flag' })

  // Telegram's own restriction_reason text — when it names spam/scam it is a
  // labelled verdict, stronger than the bare `restricted` boolean.
  if (user.restrictionReasons.some((r) => /spam|scam/i.test(r))) {
    signals.push({ name: 'restricted_for_spam', evidence: truncate(user.restrictionReasons.join(', '), 60) })
  }

  // Server-side detection of a dangerous unofficial client
  // (userFull.unofficial_security_risk). Per product decision this
  // outweighs even scam/fake: it is Telegram's own infrastructure-level
  // signal and spam farms run modified clients almost exclusively.
  if (user.unofficialClientRisk === true) {
    signals.push({ name: 'unofficial_client_risk' })
  }

  // ── external ban databases ─────────────────────────────────────────

  if (user.externalBan?.banned) {
    // Name the accuser and date the accusation. This signal alone carries a
    // 30-day ban through `external_ban_new`, without any stage having read the
    // message, so arriving bare made the one action least able to justify
    // itself also the one hardest to review (2026-07-31).
    const who = user.externalBan.sources.join('+') || 'external'
    const age = user.externalBan.bannedAt !== null
      ? `, ${Math.round((now - user.externalBan.bannedAt.getTime()) / MS_PER_DAY)}d ago`
      : ', date unknown'
    signals.push({ name: 'external_ban', evidence: `listed by ${who}${age}` })

    // Repeat offender: CAS counts prior offences across its network. A second
    // listing is a much stronger signal than a single one (replaces the dead
    // `external_high_spam_factor` — lols dropped the spam_factor field).
    if (user.externalBan.offenses >= EXTERNAL_REPEAT_OFFENSES_MIN) {
      signals.push({
        name: 'external_repeat_offender',
        evidence: `${user.externalBan.offenses} external offences`
      })
    }

    // A freshly-added ban means an actively-spamming live account, not an old
    // rehabilitated one — the known FP class of these databases.
    if (
      user.externalBan.bannedAt !== null &&
      now - user.externalBan.bannedAt.getTime() <= FRESH_EXTERNAL_BAN_MAX_DAYS * MS_PER_DAY
    ) {
      signals.push({ name: 'fresh_external_ban' })
    }
  }

  // ── account age structure ──────────────────────────────────────────

  // Tenure, not the age of our record: a member Telegram says joined two years
  // ago is not "locally new" because our own row for them is a day old.
  const tenure = tenureDays(user)

  /**
   * Whether this account has standing — computed HERE, before the two age
   * signals, because both of them are inferences from the user id and this is a
   * direct observation of the same account. Where they contradict it, it wins.
   *
   * Measured, not assumed. In the 14 days to 2026-08-24 `sleeper_awakened`
   * fired 18863 times, and 6202 of those — a third — were on accounts carrying
   * `established_user` in the very same verdict. Those 6202 led to enforcement
   * 21 times (0.34%); the other 12658 led to it 1910 times (15.09%). A signal
   * that is 44× less predictive on a third of its firings is not one signal.
   *
   * The contradiction is plain once stated: `sleeper_awakened` means "an old
   * account that has only just become visible here", and `established_user`
   * means "we have been watching this person post for a while". Both cannot be
   * true, and the disagreement arose from `tenure` being capped at 30 days
   * while volume has no such ceiling — a regular of three weeks satisfied both.
   */
  const established = hasVolumeForStanding(user) && !hasHardAccountVerdict(user)

  const isLocallyNew =
    (tenure !== null && tenure <= SLEEPER_LOCAL_MAX_DAYS) ||
    user.messagesGlobal <= NEW_GLOBALLY_MAX

  // The age prediction carries an uncertainty interval, and the two signals
  // want OPPOSITE ends of it — see each one below. (2026-08 audit: the tail of
  // the id→age curve was off by up to 137 days, exactly where these thresholds
  // live, which is why neither reads the point estimate.)
  const predictedAgeLo = user.predictedAgeBoundsDays?.lo ?? user.predictedAgeDays

  // A sleeper is an old account that has only just become visible HERE. When
  // Telegram's join date says otherwise the premise is simply false, whatever
  // our own first-seen row happens to hold — and so it is when the account has
  // standing, which is the same objection from the other side.
  //
  // `lo`, the youngest the account could be: claiming somebody woke from a
  // year's sleep requires that a year is the LEAST it could have been asleep.
  if (
    !established &&
    predictedAgeLo !== null &&
    user.predictedAgeDays !== null &&
    tenure !== null &&
    predictedAgeLo - tenure > SLEEPER_GAP_DAYS &&
    tenure <= SLEEPER_LOCAL_MAX_DAYS
  ) {
    signals.push({
      name: 'sleeper_awakened',
      evidence: `~${Math.round(user.predictedAgeDays)}d old account, locally active ${Math.round(tenure)}d`
    })
  }

  /**
   * An id Telegram is handing out right now.
   *
   * This signal had fired ZERO times in the whole life of the database when it
   * was checked on 2026-08-24, and the reason was structural rather than
   * accidental. It used to read `hi` — the OLDEST the account could be — and
   * demand it be under 30 days, i.e. "certainly new". Since 2024-02 Telegram
   * allocates ids randomly inside a block and the block window is all the id
   * discloses, so `hi` is the age of the open block: 104 days when this was
   * written, and growing daily. No account could satisfy the test, and none
   * ever will again while a block stays open longer than a month.
   *
   * `lo` asks the question the model can still answer — "could this account
   * have been registered this month?" — and for an OPEN block the answer is
   * yes by construction, because its window has no upper edge yet. So this
   * reads, exactly, membership of the block currently being allocated. It needs
   * no table of dates and cannot rot: when the block closes, ids in it stop
   * qualifying on their own, and the next block takes over.
   *
   * The fact is worth having. Enforcement rate by id band over the 14 days to
   * 2026-08-24, counted on distinct senders so a single flood cannot skew it:
   *
   *     < 7e9  (sequential, pre-2024)   7783 senders   9.7%
   *     7.0–7.6e9                        530          38.1%
   *     7.6–8.2e9                        645          42.6%
   *     8.2–8.5e9                        447          45.6%
   *     8.5–8.6e9                        201          52.7%
   *     8.6–8.8e9  (previous block)      601          74.4%
   *     8.8–9.0e9  (open block)          851          79.6%
   *
   * Monotone across eight bands and an eightfold spread end to end, from a
   * signal contributing nothing to any of those verdicts. Deliberately NOT
   * widened to the previous block as well, despite its 74.4%: "the block that
   * was open last" is a fact with an expiry date, and a threshold in days would
   * reintroduce exactly the rot this rewrite removes.
   *
   * Suppressed for an established account for the reason given above: a person
   * who registered in June and has posted here since July is a new account and
   * a known member, and the direct observation outranks the inference. `shape`
   * and inside the `newness` cap, so on the ordinary newcomer — who already
   * carries `new_globally` and `new_in_chat` — it adds nothing at all.
   */
  if (!established && predictedAgeLo !== null && predictedAgeLo < FRESH_ACCOUNT_MAX_DAYS) {
    signals.push({
      name: 'fresh_account',
      evidence: `id issued in the current allocation block, may be days old`
    })
  }

  // ── identity & profile churn ───────────────────────────────────────

  if (user.nameChurn24h >= IDENTITY_CHURN_MIN || user.usernameChurn24h >= IDENTITY_CHURN_MIN) {
    signals.push({
      name: 'identity_churn_24h',
      evidence: `${user.nameChurn24h} name / ${user.usernameChurn24h} username changes in 24h`
    })
  }

  // Promo carried in the identity itself. Free (the name arrives with every
  // update) and high-precision, which is exactly the kind of trigger the
  // pipeline was missing: until now the profile was only inspected via the
  // bio, which costs an enrichment call and is often empty.
  const namePromo = findNamePromo(user)
  if (namePromo !== null) {
    signals.push({ name: 'promo_in_name', evidence: truncate(`name: ${namePromo}`, 80) })
  }
  if (INVISIBLE_IN_NAME_REGEX.test(user.displayName)) {
    signals.push({ name: 'invisible_in_name', evidence: 'invisible chars in display name' })
  }

  // A just-set avatar matters only on a locally-new account (spam farms
  // dress up accounts right before a campaign); established users change
  // avatars as part of normal life.
  if (
    user.avatars !== null &&
    user.avatars.latestSetDaysAgo !== null &&
    user.avatars.latestSetDaysAgo <= AVATAR_FRESH_MAX_DAYS &&
    isLocallyNew
  ) {
    signals.push({ name: 'avatar_recently_set' })
  }

  // ── local history ──────────────────────────────────────────────────

  if (user.messagesInChat <= NEW_IN_CHAT_MAX) signals.push({ name: 'new_in_chat' })
  if (user.messagesGlobal <= NEW_GLOBALLY_MAX) signals.push({ name: 'new_globally' })

  // Joined the chat moments before posting — a throwaway fanning into a group
  // to drop one message. Authoritative join time from channels.getParticipant.
  if (user.joinedAgoSeconds !== null && user.joinedAgoSeconds <= JUST_JOINED_MAX_SECONDS) {
    signals.push({ name: 'just_joined', evidence: `joined ${Math.round(user.joinedAgoSeconds)}s ago` })
  }
  if (user.joinedDuringSurge === true) signals.push({ name: 'joined_during_surge' })

  // Spreader pattern: present in many chats we watch yet barely posting —
  // a freshly-joined account fanning out before a campaign. Guarded by
  // newness so long-time members in many shared groups don't trip it.
  if (user.groupsActive >= MANY_SHARED_CHATS_MIN && user.messagesGlobal <= NEW_GLOBALLY_MAX) {
    signals.push({ name: 'many_shared_chats', evidence: `${user.groupsActive} shared chats` })
  }
  // Two, not one, and for the reason the exempt already gives: a single past
  // detection may itself have been a false positive, and a signal that fires on
  // it makes every subsequent evaluation of that person harsher — the FP
  // compounds into the next one. Two independent detections are a pattern.
  //
  // The bar was raised on 2026-08-01, when v2 started writing this counter at
  // all. Until then only accounts v1 had caught could reach it, so a weight of
  // 1.5 firing at one detection had never once been exercised on live data.
  if (user.spamDetections >= PRIOR_DETECTIONS_MIN) {
    signals.push({ name: 'prior_spam_detections', evidence: `${user.spamDetections} prior detections` })
  }
  if (user.reputationStatus === 'suspicious' || user.reputationStatus === 'restricted') {
    signals.push({ name: 'low_reputation' })
  }

  // ── trust signals ──────────────────────────────────────────────────
  // Premium is deliberately NOT here: spammers buy premium for visibility.

  if (user.flags.verified) signals.push({ name: 'verified_account' })
  if (user.reputationStatus === 'trusted') signals.push({ name: 'trusted_reputation' })

  // Standing is earned by volume. The old form also required
  // `reputationScore >= 60`, but v2 never WRITES reputation.score (it defaults
  // to 50 and only v1 documents carry anything else) — so this signal, and
  // with it every clean rule and trust weight that depends on it, was
  // unreachable in practice. That silently deleted the whole negative half of
  // the model and biased the pipeline toward enforcement.
  //
  // Volume now suffices, but ONLY absent a hard verdict. The deterministic
  // rules and the score both treat `established_user` as a shield, so an
  // account Telegram, an external database or our own record has already
  // condemned must never earn it. That is the sold/compromised long-time
  // account from the threat model.
  //
  // Volume in EITHER scope, since 2026-08-20 — the same OR the exempt has
  // always applied, and for the same stated reason: a member with standing here
  // and a member with a long history across our chats both count. See
  // `hasLocalStanding` for why the local half additionally requires tenure and
  // the global half does not.
  //
  // Both halves are named functions rather than expressions inlined here,
  // because the two age signals above ask the same question and used to get a
  // different answer — see `established`.
  if (established) {
    signals.push({ name: 'established_user' })
  }

  return signals
}
