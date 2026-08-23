import {
  ESTABLISHED_MIN_IN_CHAT, ESTABLISHED_MIN_MESSAGES, ESTABLISHED_MIN_TENURE_DAYS,
  PRIOR_DETECTIONS_MIN
} from './signals/user.js'

/**
 * Community voting tally — pure. A vote resolves when the net difference
 * reaches the threshold, or instantly when an admin casts a ballot
 * (the latest admin ballot wins, mirroring the override button's authority).
 */
export type VoteChoice = 'spam' | 'ham'

export interface VoteBallot {
  userId: number
  isAdmin: boolean
  choice: VoteChoice
  /**
   * Display name captured at the moment of the tap. Stored rather than resolved
   * later: the name is free here (it rides on the callback query) and a lookup
   * at read time would cost a Telegram call per voter and return whatever they
   * are called today, not who the chat saw voting.
   */
  label?: string
  /** Mongo hands this back as a Date; older rows may have nothing. */
  at?: Date
}

export interface VoteTally {
  spam: number
  ham: number
  outcome: VoteChoice | 'pending'
  /**
   * What settled it: an admin's single ballot, or the chat reaching the
   * threshold. Null while pending.
   *
   * Recorded because the two are different events and the log could not tell
   * them apart — every resolution reached through the button path was written
   * down as "community", including a 2:0 spam outcome, which a net-3 threshold
   * makes arithmetically impossible without an admin.
   */
  decidedBy: 'admin' | 'quorum' | null
}

const DEFAULT_THRESHOLD = 3

/**
 * How long a question stays askable.
 *
 * The prompt used to be the one notice this bot posts with no timer at all, so
 * an unanswered vote sat in the chat forever while its document expired after
 * seven days underneath it — buttons that answered "already closed" about
 * something that never closed.
 *
 * Fifteen minutes is chosen against the feed, not against the chat's patience:
 * a question that has scrolled out of sight is not going to be answered at hour
 * six either, and leaving it up only keeps a dead prompt on screen. The cost is
 * real and worth naming — a quiet chat at 03:00 will let corrections expire
 * unseen — so expiry is logged (`vote_expired`) rather than silent, and the
 * number is meant to be retuned from that log rather than from taste.
 */
export const VOTE_WINDOW_SECONDS = 15 * 60

/**
 * Ballots that count, in arrival order. Shared so the tally and the roster can
 * never disagree about who voted — they are shown side by side, and a roster
 * naming four people under a count of three reads as a bug in the count.
 */
const validBallots = (ballots: VoteBallot[]): VoteBallot[] =>
  (Array.isArray(ballots) ? ballots : []).filter((ballot) =>
    Number.isFinite(ballot?.userId) && (ballot.choice === 'spam' || ballot.choice === 'ham'))

export const tallyVotes = (ballots: VoteBallot[], threshold = DEFAULT_THRESHOLD): VoteTally => {
  // Last ballot per user wins; garbage ballots are dropped, never thrown on.
  const latest = new Map<number, VoteBallot>()
  let adminChoice: VoteChoice | null = null
  for (const ballot of validBallots(ballots)) {
    latest.set(ballot.userId, ballot)
    if (ballot.isAdmin) adminChoice = ballot.choice
  }

  let spam = 0
  let ham = 0
  for (const ballot of latest.values()) {
    if (ballot.choice === 'spam') spam += 1
    else ham += 1
  }

  if (adminChoice) return { spam, ham, outcome: adminChoice, decidedBy: 'admin' }
  if (spam - ham >= threshold) return { spam, ham, outcome: 'spam', decidedBy: 'quorum' }
  if (ham - spam >= threshold) return { spam, ham, outcome: 'ham', decidedBy: 'quorum' }
  return { spam, ham, outcome: 'pending', decidedBy: null }
}

export interface VoterEntry {
  userId: number
  /** Null for ballots cast before names were stored — render the id instead. */
  label: string | null
  isAdmin: boolean
  choice: VoteChoice
  /** They voted more than one way; only the last one counted. */
  changedMind: boolean
}

export interface VoterRoster {
  spam: VoterEntry[]
  ham: VoterEntry[]
  /**
   * Seconds from the first ballot to the last, superseded ones included.
   * Null when no two ballots carry a usable timestamp.
   *
   * This is the number that answers "was this a real vote": three taps four
   * minutes apart is a chat reacting, three taps in two seconds is a crew.
   * The counts alone cannot tell those apart.
   */
  spanSeconds: number | null
}

const timestampMs = (at: unknown): number | null => {
  if (at === undefined || at === null) return null
  if (typeof at !== 'string' && typeof at !== 'number' && !(at instanceof Date)) return null
  const ms = new Date(at).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * Who voted which way — the same set `tallyVotes` counted, named.
 *
 * Order within a group is first-appearance, which is arrival order because the
 * store appends. A re-voter therefore keeps their original position rather than
 * jumping to the end: the roster reads as the sequence the chat lived through.
 */
export const voterRoster = (ballots: VoteBallot[]): VoterRoster => {
  const valid = validBallots(ballots)
  const entries = new Map<number, VoterEntry>()
  const choicesSeen = new Map<number, Set<VoteChoice>>()

  for (const ballot of valid) {
    const seen = choicesSeen.get(ballot.userId) ?? new Set<VoteChoice>()
    seen.add(ballot.choice)
    choicesSeen.set(ballot.userId, seen)

    const existing = entries.get(ballot.userId)
    const entry: VoterEntry = {
      userId: ballot.userId,
      // A later ballot with no label must not erase a name we already had.
      label: (typeof ballot.label === 'string' && ballot.label !== '')
        ? ballot.label
        : existing?.label ?? null,
      isAdmin: ballot.isAdmin === true,
      choice: ballot.choice,
      changedMind: seen.size > 1
    }
    // Map.set keeps the original insertion position for an existing key.
    entries.set(ballot.userId, entry)
  }

  // Folded rather than spread: nothing rate-limits taps and nothing caps the
  // array, so `Math.max(...times)` over a long-running question was one
  // determined account away from a RangeError that takes the whole roster down.
  let earliest: number | null = null
  let latest: number | null = null
  let timed = 0
  for (const ballot of valid) {
    const ms = timestampMs(ballot.at)
    if (ms === null) continue
    timed += 1
    if (earliest === null || ms < earliest) earliest = ms
    if (latest === null || ms > latest) latest = ms
  }
  const spanSeconds = timed >= 2 && earliest !== null && latest !== null
    ? Math.round((latest - earliest) / 1000)
    : null

  const all = [...entries.values()]
  return {
    spam: all.filter((e) => e.choice === 'spam'),
    ham: all.filter((e) => e.choice === 'ham'),
    spanSeconds
  }
}

/** What the chat knows about someone reaching for a ballot. */
export interface VoterStanding {
  isAdmin: boolean
  /** They are the person this question is about. */
  isTarget: boolean
  messagesInChat: number
  messagesGlobal: number
  /** Days since we first saw the account anywhere; null when nothing says. */
  tenureDays: number | null
  /** Confirmed spam verdicts recorded against them. */
  spamDetections: number
}

export type VoteEligibility = 'eligible' | 'is_target' | 'known_bad' | 'no_standing'

const atLeast = (value: number, bar: number): boolean =>
  Number.isFinite(value) && value >= bar

/**
 * Whether this person's ballot counts, and if not, why.
 *
 * The bar is deliberately the SAME one that grants the established-regular
 * exempt — volume in either scope AND a week of tenure — rather than a second
 * number chosen for voting. The two would drift, and a differently-calibrated
 * idea of "regular" is exactly the duplicate source of truth that made the
 * exempt and `established_user` disagree until 2026-08-20.
 *
 * Order matters, and each step is a different question:
 *
 *  - The target never votes, admin or not. Nothing else is checked first,
 *    because a ballot on your own case is not a weak vote, it is not a vote.
 *  - An admin always votes. Their authority does not come from message count,
 *    and a chat whose admins are quiet must not lose its moderation.
 *  - Two detections take the vote away, on the same grounds they already strip
 *    the exempt and the ban shield.
 *  - Volume alone is not standing. Three accounts can each post ten messages in
 *    five minutes; they cannot make themselves a week old. Tenure is the half
 *    of this bar that an attacker actually has to pay for.
 *
 * Note what this does NOT do: it never weighs a ballot by reputation. A scored
 * vote invites reputation farming, which this system has already been bitten by
 * once, and "may or may not vote" is a claim we can actually defend to somebody
 * who was refused.
 */
export const voteEligibility = (voter: VoterStanding): VoteEligibility => {
  if (voter.isTarget) return 'is_target'
  if (voter.isAdmin) return 'eligible'
  if (atLeast(voter.spamDetections, PRIOR_DETECTIONS_MIN)) return 'known_bad'

  const volume = atLeast(voter.messagesInChat, ESTABLISHED_MIN_IN_CHAT) ||
    atLeast(voter.messagesGlobal, ESTABLISHED_MIN_MESSAGES)
  const tenured = voter.tenureDays !== null &&
    atLeast(voter.tenureDays, ESTABLISHED_MIN_TENURE_DAYS)
  return volume && tenured ? 'eligible' : 'no_standing'
}
