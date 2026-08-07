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
/** Kept equal to the pipeline's `HARD_VERDICT_MIN_DETECTIONS` on purpose. */
const PRIOR_DETECTIONS_MIN = 2
const JUST_JOINED_MAX_SECONDS = 120
const ESTABLISHED_MIN_MESSAGES = 50
const AVATAR_FRESH_MAX_DAYS = 7

const MS_PER_DAY = 86_400_000

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

  const isLocallyNew =
    (user.localAgeDays !== null && user.localAgeDays <= SLEEPER_LOCAL_MAX_DAYS) ||
    user.messagesGlobal <= NEW_GLOBALLY_MAX

  // The age prediction carries an uncertainty interval; both age signals
  // gate on the bound that avoids the false positive, not the point
  // estimate (2026-08 audit: the tail of the id→age curve was off by up to
  // 137 days, exactly where these thresholds live).
  const predictedAgeLo = user.predictedAgeBoundsDays?.lo ?? user.predictedAgeDays
  const predictedAgeHi = user.predictedAgeBoundsDays?.hi ?? user.predictedAgeDays

  if (
    predictedAgeLo !== null &&
    user.predictedAgeDays !== null &&
    user.localAgeDays !== null &&
    predictedAgeLo - user.localAgeDays > SLEEPER_GAP_DAYS &&
    user.localAgeDays <= SLEEPER_LOCAL_MAX_DAYS
  ) {
    signals.push({
      name: 'sleeper_awakened',
      evidence: `~${Math.round(user.predictedAgeDays)}d old account, locally active ${Math.round(user.localAgeDays)}d`
    })
  }

  if (predictedAgeHi !== null && user.predictedAgeDays !== null && predictedAgeHi < FRESH_ACCOUNT_MAX_DAYS) {
    signals.push({ name: 'fresh_account', evidence: `~${Math.round(user.predictedAgeDays)}d old` })
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
  // Volume now suffices, but ONLY absent a hard verdict. This veto is the
  // single place that decision is made: the deterministic rules and the score
  // both treat `established_user` as a shield, so an account Telegram or an
  // external database has already condemned must never earn it. That is the
  // sold/compromised long-time account from the threat model.
  const hasHardVerdict =
    user.flags.scam ||
    user.flags.fake ||
    user.externalBan?.banned === true ||
    user.reputationStatus === 'suspicious' ||
    user.reputationStatus === 'restricted' ||
    user.restrictionReasons.some((r) => /spam|scam/i.test(r))
  if (user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES && !hasHardVerdict) {
    signals.push({ name: 'established_user' })
  }

  return signals
}
