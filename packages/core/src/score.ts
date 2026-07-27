/**
 * Signal scoring: weighted logistic combination → calibrated pSpam (0..1).
 *
 * Weights are the calibration surface of the whole pipeline. They are data,
 * not code: the replay tool re-fits them against production decisions, and
 * a weight change is reviewable in a one-line diff.
 *
 * Calibration provenance (2026-06-11 prod-DB review):
 *  - sleeper_awakened weight is deliberately LOW. v1's sleeper rule (c=90)
 *    was the top action source AND the top confirmed-FP source (lost-pet
 *    posts, local venue promos from old quiet accounts). Sleeper+promo must
 *    land in the votable band, not auto-mute.
 *  - identity_churn fired on innocent text when paired with any link; its
 *    weight alone cannot cross the action threshold.
 */
import type { Signal } from './types.js'

/** z-offset so that a signal-less message scores ≈ 0.10 (ham prior). */
export const BASE_RATE_BIAS = -2.2

export const SIGNAL_WEIGHTS: Record<string, number> = {
  // ── Telegram-level account flags ──
  scam_flag: 3.0,
  fake_flag: 3.0,
  restricted_flag: 0.8,
  // Server-flagged dangerous unofficial client — deliberately the heaviest
  // single account signal (user decision 2026-06-11): spam farms run
  // modified clients; legitimate users on unofficial apps are rare and
  // the flag comes from Telegram's own abuse infrastructure.
  unofficial_client_risk: 3.2,

  // ── external ban databases ──
  external_ban: 2.5,
  // CAS repeat-offence count — stronger than a single listing. Replaces the
  // dead external_high_spam_factor (lols dropped spam_factor).
  external_repeat_offender: 2.0,
  // Ban added <48h ago: an actively-spamming live account, not an old one.
  fresh_external_ban: 1.0,

  // ── message structure ──
  forward_hidden_user: 1.5,
  forward_source_suspicious: 1.6,
  many_url_buttons: 2.0,
  hidden_url: 2.0,
  private_invite_link: 1.8,
  bot_deeplink: 1.5,
  url_shortener: 1.2,
  messenger_contact_link: 1.5,
  external_url: 0.8,
  phone_number: 1.2,
  cashtag: 1.0,
  long_text: 0.4,
  invisible_in_word: 2.0,
  mixed_script_word: 1.5,
  custom_emoji_heavy: 1.0,
  paid_media: 1.5,
  giveaway_media: 1.0,
  story_share: 0.8,
  unknown_media: 0.3,
  guest_bot_delivery: 0.8,
  edited_message: 0.2,
  edit_injected_promo: 2.5,

  // ── knowledge ports (sub-decisive matches) ──
  // These four used to have NO entry here at all, so `?? 0` silently zeroed
  // them: the pipeline paid for a Qdrant/OpenAI/signature call, attached the
  // signal, and scoring ignored it — while `hasDecisiveSignal` still counted
  // it and thereby SUPPRESSED the LLM escalation. Net effect was negative.
  // Content-level NSFW/violence in the message or its photo.
  moderation_flagged: 1.5,
  // Self-learned signature matched, but not human-confirmed yet.
  signature_candidate_match: 1.2,
  // Semantically near known spam (only raised above VECTOR_SIGNAL_SIMILARITY).
  vector_similar_spam: 1.0,
  // The message mentions a bot — promo-relevant, weak on its own.
  bot_mention: 0.5,

  // ── profile / bio ──
  // Promo link/contact/phone in the bio. Low weight + a confirmed v1 FP class
  // (innocent website bios) → only bites stacked with newness in the score.
  promo_in_bio: 1.2,
  // Promo URL / foreign @handle carried in the display name or username
  // itself ("Заробіток t.me/xxx"). Nobody names themselves after a promo link
  // by accident, so this is the highest-precision profile signal we have —
  // but it is still about WHO, not WHAT, so it stays soft-shape.
  promo_in_name: 1.8,
  // Invisible/zero-width characters inside the display name — evasion of
  // name-based matching, no legitimate use.
  invisible_in_name: 1.2,
  // Linked personal channel — weak alone (legit users have them too).
  personal_channel: 0.5,
  // Telegram-labelled spam/scam restriction — stronger than the bare flag.
  restricted_for_spam: 1.5,
  // Joined the chat <2min before posting.
  just_joined: 1.0,
  // NSFW profile media. Deliberately LOW and soft-shape (2026-07-27 review):
  // at weight 2.5 these stacked with ordinary newcomer signals to 0.97 and
  // permanently banned first-time posters over an anime avatar the provider's
  // recall-tuned `flagged` boolean caught on `violence`. They now only nudge
  // the message toward the LLM, which reads what was actually written.
  nsfw_avatar: 1.0,
  nsfw_stories: 0.9,

  // ── user history / age ──
  sleeper_awakened: 1.2,
  fresh_account: 1.0,
  identity_churn_24h: 1.5,
  avatar_recently_set: 0.6,
  new_in_chat: 0.4,
  new_globally: 0.8,
  // Present in many chats we watch while barely posting — spreader pattern.
  // Modest weight; replay should confirm before trusting it further.
  many_shared_chats: 0.8,
  prior_spam_detections: 1.5,
  low_reputation: 1.2,

  // ── trust (negative) ──
  is_reply: -1.0,
  recent_reply: -0.8,
  media_only: -1.5,
  emoji_only: -1.5,
  internal_link_only: -1.0,
  short_message: -0.8,
  verified_account: -3.0,
  trusted_reputation: -2.5,
  established_user: -1.5
}

/**
 * Account/profile *shape* heuristics. Each describes WHO sent the message —
 * never WHAT was sent — and each is an established FP class on its own (the
 * 2026-06 review: sleeper promos, innocent-website bios, linked channels). The
 * weights keep any one of them below the action threshold, but nothing stops a
 * *stack* of them from crossing it. So a verdict resting solely on these is not
 * evidence of spam content: it must route through the LLM (which reads the
 * text) and, failing that, observe — never enforce blind.
 *
 * Provenance: the 2026-06-21 FP, a benign question deleted on
 * sleeper_awakened + new_globally + promo_in_bio + personal_channel (pSpam 0.82).
 */
export const SOFT_SHAPE_SIGNALS = new Set([
  'sleeper_awakened', 'fresh_account', 'new_in_chat', 'new_globally',
  'avatar_recently_set', 'many_shared_chats', 'just_joined',
  'identity_churn_24h', 'promo_in_bio', 'personal_channel',
  'promo_in_name', 'invisible_in_name',
  // Profile media (2026-07-27): an avatar describes the sender, not the
  // message. Treating it as decisive let the pipeline enforce without ever
  // reading the text — the exact failure the soft-shape guard exists to stop.
  'nsfw_avatar', 'nsfw_stories'
])

/**
 * Whether the signals carry evidence that justifies enforcing *without reading
 * the message text*: any message content/structure signal, or a hard account
 * verdict (scam/fake/restricted/ban/unofficial-client/prior-detections/
 * low-reputation). A score driven purely by soft-shape signals is NOT decisive.
 * Negative (trust) signals never count.
 */
export const hasDecisiveSignal = (signals: Signal[]): boolean =>
  signals.some((s) => !s.negative && !SOFT_SHAPE_SIGNALS.has(s.name))

/**
 * Correlated signal groups, each with a ceiling on what the group as a whole
 * may contribute (2026-07-27).
 *
 * A weighted sum assumes its inputs are independent evidence. Several of ours
 * plainly are not: `new_in_chat`, `new_globally`, `fresh_account`,
 * `just_joined` and `avatar_recently_set` are five different ways of saying
 * "this account is new". Summed, they contributed 3.8 — more than a Telegram
 * scam flag — so an ordinary first-time poster started at pSpam 0.83 before
 * anyone looked at the message. Every additional trigger then landed on top of
 * an already-condemning base, which is how a single soft signal (an avatar)
 * could finish the job.
 *
 * A ceiling keeps the strongest member of a group intact while refusing to pay
 * again for restatements of the same fact. Chosen conservatively: roughly
 * twice the group's heaviest member, so two genuinely distinct aspects still
 * add up, five do not.
 */
export const SIGNAL_GROUP_CAPS: { name: string; cap: number; members: Set<string> }[] = [
  {
    name: 'newness',
    cap: 2.0,
    members: new Set([
      'new_in_chat', 'new_globally', 'fresh_account', 'just_joined',
      'avatar_recently_set', 'sleeper_awakened', 'many_shared_chats'
    ])
  },
  {
    // One profile, advertised in several places.
    name: 'profile_promo',
    cap: 2.0,
    members: new Set(['promo_in_name', 'promo_in_bio', 'personal_channel'])
  },
  {
    // One person posting explicit imagery; avatar and stories are not
    // independent observations of it.
    name: 'profile_nsfw',
    cap: 1.2,
    members: new Set(['nsfw_avatar', 'nsfw_stories'])
  },
  {
    // All three derive from the same listing in the same databases.
    // Named distinctly from the `external_ban` SIGNAL it contains: a group
    // and a signal sharing a name makes both harder to grep and to reason about.
    name: 'external_ban_source',
    cap: 3.5,
    members: new Set(['external_ban', 'external_repeat_offender', 'fresh_external_ban'])
  },
  {
    // A single promo link usually trips several URL classes at once.
    name: 'promo_urls',
    cap: 3.0,
    members: new Set([
      'private_invite_link', 'bot_deeplink', 'url_shortener',
      'messenger_contact_link', 'external_url', 'hidden_url'
    ])
  }
]

export interface ScoreResult {
  pSpam: number
  /** Distinct signals with non-zero weight, sorted by |weight| desc. */
  topContributors: { name: string; weight: number }[]
  /** Groups whose ceiling actually bit, for calibration telemetry. */
  cappedGroups: string[]
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

export const scoreSignals = (signals: Signal[]): ScoreResult => {
  // Dedup: a fact is a fact — repeating it must not double its weight.
  const distinct = new Set(signals.map((s) => s.name))

  const contributors: { name: string; weight: number }[] = []
  const groupTotals = new Map<string, number>()
  let z = BASE_RATE_BIAS

  for (const name of distinct) {
    const weight = SIGNAL_WEIGHTS[name] ?? 0
    if (weight === 0) continue
    contributors.push({ name, weight })

    // Trust signals are never capped: a ceiling on them could only ever make
    // the pipeline harsher, which is the wrong direction to fail in.
    const group = weight > 0
      ? SIGNAL_GROUP_CAPS.find((g) => g.members.has(name))
      : undefined
    if (group) {
      groupTotals.set(group.name, (groupTotals.get(group.name) ?? 0) + weight)
    } else {
      z += weight
    }
  }

  const cappedGroups: string[] = []
  for (const group of SIGNAL_GROUP_CAPS) {
    const total = groupTotals.get(group.name)
    if (total === undefined) continue
    z += Math.min(total, group.cap)
    if (total > group.cap) cappedGroups.push(group.name)
  }

  contributors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))

  return { pSpam: sigmoid(z), topContributors: contributors, cappedGroups }
}
