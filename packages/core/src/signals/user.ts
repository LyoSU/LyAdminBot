/**
 * User-level signal extraction. Pure function over UserSnapshot.
 *
 * Production-calibration note (2026-06-11 prod-DB review): sleeper_awakened
 * was v1's loudest rule AND its main FP source (lost-pet posts, local venue
 * promos from old quiet accounts). Here it is only a fact; scoring keeps its
 * weight below auto-action threshold so policy routes it through vote.
 */
import type { Signal, UserSnapshot } from '../types.js'

const SLEEPER_GAP_DAYS = 365
const SLEEPER_LOCAL_MAX_DAYS = 30
const FRESH_ACCOUNT_MAX_DAYS = 30
const IDENTITY_CHURN_MIN = 3
const NEW_IN_CHAT_MAX = 3
const NEW_GLOBALLY_MAX = 5
const EXTERNAL_REPEAT_OFFENSES_MIN = 2
const FRESH_EXTERNAL_BAN_MAX_DAYS = 2
const MANY_SHARED_CHATS_MIN = 5
const JUST_JOINED_MAX_SECONDS = 120
const ESTABLISHED_MIN_MESSAGES = 50
const ESTABLISHED_MIN_SCORE = 60
const AVATAR_FRESH_MAX_DAYS = 7

const MS_PER_DAY = 86_400_000

export const extractUserSignals = (user: UserSnapshot, now = Date.now()): Signal[] => {
  const signals: Signal[] = []

  // ── Telegram-level flags (free with every update) ──────────────────

  if (user.flags.scam) signals.push({ name: 'scam_flag' })
  if (user.flags.fake) signals.push({ name: 'fake_flag' })
  if (user.flags.restricted) signals.push({ name: 'restricted_flag' })

  // Telegram's own restriction_reason text — when it names spam/scam it is a
  // labelled verdict, stronger than the bare `restricted` boolean.
  if (user.restrictionReasons.some((r) => /spam|scam/i.test(r))) {
    signals.push({ name: 'restricted_for_spam', evidence: user.restrictionReasons.join(', ').slice(0, 60) })
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
    signals.push({ name: 'external_ban' })

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

  if (
    user.predictedAgeDays !== null &&
    user.localAgeDays !== null &&
    user.predictedAgeDays - user.localAgeDays > SLEEPER_GAP_DAYS &&
    user.localAgeDays <= SLEEPER_LOCAL_MAX_DAYS
  ) {
    signals.push({
      name: 'sleeper_awakened',
      evidence: `~${Math.round(user.predictedAgeDays)}d old account, locally active ${Math.round(user.localAgeDays)}d`
    })
  }

  if (user.predictedAgeDays !== null && user.predictedAgeDays < FRESH_ACCOUNT_MAX_DAYS) {
    signals.push({ name: 'fresh_account', evidence: `~${Math.round(user.predictedAgeDays)}d old` })
  }

  // ── identity & profile churn ───────────────────────────────────────

  if (user.nameChurn24h >= IDENTITY_CHURN_MIN || user.usernameChurn24h >= IDENTITY_CHURN_MIN) {
    signals.push({
      name: 'identity_churn_24h',
      evidence: `${user.nameChurn24h} name / ${user.usernameChurn24h} username changes in 24h`
    })
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

  // Spreader pattern: present in many chats we watch yet barely posting —
  // a freshly-joined account fanning out before a campaign. Guarded by
  // newness so long-time members in many shared groups don't trip it.
  if (user.groupsActive >= MANY_SHARED_CHATS_MIN && user.messagesGlobal <= NEW_GLOBALLY_MAX) {
    signals.push({ name: 'many_shared_chats', evidence: `${user.groupsActive} shared chats` })
  }
  if (user.spamDetections > 0) {
    signals.push({ name: 'prior_spam_detections', evidence: `${user.spamDetections} prior detections` })
  }
  if (user.reputationStatus === 'suspicious' || user.reputationStatus === 'restricted') {
    signals.push({ name: 'low_reputation' })
  }

  // ── trust signals ──────────────────────────────────────────────────
  // Premium is deliberately NOT here: spammers buy premium for visibility.

  if (user.flags.verified) signals.push({ name: 'verified_account', negative: true })
  if (user.reputationStatus === 'trusted') signals.push({ name: 'trusted_reputation', negative: true })
  if (user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES && user.reputationScore >= ESTABLISHED_MIN_SCORE) {
    signals.push({ name: 'established_user', negative: true })
  }

  return signals
}
