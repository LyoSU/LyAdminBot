import {
  ESTABLISHED_MIN_IN_CHAT, ESTABLISHED_MIN_MESSAGES, ESTABLISHED_MIN_TENURE_DAYS,
  PRIOR_DETECTIONS_MIN, mergeTenureDays
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
  /**
   * Set by the store when this ballot REPLACED an earlier one by the same
   * voter. One ballot per voter is kept (since 2026-09-01), so the roster can
   * no longer see the change by counting entries and has to be told.
   */
  changedMind?: boolean
  /** How many times this voter tapped, all told. */
  taps?: number
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
 * Fifteen minutes was the answer to that, chosen against the feed and offered
 * to be retuned from the expiry log rather than from taste. Retuned here, from
 * that log, 2026-08-30.
 *
 * 147 of 202 questions expired — 72.8%. The reasoning for the short window was
 * that a question scrolled out of sight is not going to be answered at hour six
 * either, and the ballots say otherwise: of 181 votes cast into questions that
 * expired anyway, 114 arrived in the first two minutes but 30 more came at
 * minutes 5 to 10 and another 21 at minutes 10 to 15. Arrival was still flat
 * when the window shut. Six of the 55 that DID close closed in that last third,
 * so the cut was not trimming a dead tail, it was interrupting a live one.
 *
 * And the stated cost was backwards. Nothing deletes the prompt — only the
 * vote-RESULT notice carries a timer — so a short window never took a dead
 * prompt off the screen. It left the prompt there and switched the buttons off
 * underneath it, which is the exact failure this constant was introduced to
 * stop, arriving by the other road.
 *
 * Six hours, because everything this window governs is a CORRECTION: the action
 * has already been applied by the time the question is posted, so a later
 * answer is a later chance to undo something, never a later punishment. Long
 * enough that anybody who reads the chat that day can still answer, short
 * enough that they are answering about a message they remember. The eligibility
 * bar (`voteEligibility`) is what keeps the extra hours from being farmable —
 * standing takes a week, and no burst of arrivals can buy it inside one.
 *
 * Where the tail actually decays is still unmeasured; this window is the first
 * one wide enough to show it. Same log, same instruction: retune from it.
 */
export const VOTE_WINDOW_SECONDS = 6 * 60 * 60

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
      // Either shape: the stored flag on a deduplicated ballot, or two choices
      // seen on a row written before ballots were deduplicated.
      changedMind: ballot.changedMind === true || seen.size > 1
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
  /** Both `null` when the counters could not be read — see `atLeast`. */
  messagesInChat: number | null
  messagesGlobal: number | null
  /**
   * Days since we first saw the account anywhere; null when nothing says.
   *
   * Our own clock, and it restarts whenever our records do — a migration, the
   * quota cleanup, a chat the bot only just joined.
   */
  localAgeDays: number | null
  /**
   * Seconds since Telegram says they joined THIS chat; null when it did not
   * say. Telegram's clock, which survives anything we do to our database.
   */
  joinedAgoSeconds: number | null
  /** Confirmed spam verdicts recorded against them. */
  spamDetections: number
}

export type VoteEligibility = 'eligible' | 'is_target' | 'known_bad' | 'no_standing'

const atLeast = (value: number | null, bar: number): boolean =>
  value !== null && Number.isFinite(value) && value >= bar

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
 *  - A YEAR of tenure is standing on its own. Measured over the week to
 *    2026-09-01: 76 ballots refused for standing, and about half of them came
 *    from members Telegram says joined one to four years ago, with no messages
 *    in our counters — the counters only exist since 2026-06, and a quiet
 *    member is not a newcomer. Meanwhile 35 questions expired at two "spam"
 *    against zero, for want of a third voter. The year is the cost an attacker
 *    cannot shortcut: a farm account that sat in this chat since last summer
 *    without posting is a farm that gave up a year of the chat to cast one vote
 *    among three.
 *
 * Tenure is read from BOTH clocks and the longer wins (`mergeTenureDays`) —
 * again the pipeline's rule rather than a second one. Our own first-seen date
 * alone was the whole reading until 2026-08-23, and it made a hole in our
 * records into a statement about a person: everybody in a chat the bot had just
 * joined was told they had not settled in yet, for a week, however many years
 * they had actually been there.
 *
 * Note what this does NOT do: it never weighs a ballot by reputation. A scored
 * vote invites reputation farming, which this system has already been bitten by
 * once, and "may or may not vote" is a claim we can actually defend to somebody
 * who was refused.
 */
export const VOTE_TENURE_ALONE_DAYS = 365

export const voteEligibility = (voter: VoterStanding): VoteEligibility => {
  if (voter.isTarget) return 'is_target'
  if (voter.isAdmin) return 'eligible'
  if (atLeast(voter.spamDetections, PRIOR_DETECTIONS_MIN)) return 'known_bad'

  const tenure = mergeTenureDays(voter.localAgeDays, voter.joinedAgoSeconds)
  if (tenure !== null && atLeast(tenure, VOTE_TENURE_ALONE_DAYS)) return 'eligible'

  const volume = atLeast(voter.messagesInChat, ESTABLISHED_MIN_IN_CHAT) ||
    atLeast(voter.messagesGlobal, ESTABLISHED_MIN_MESSAGES)
  const tenured = tenure !== null && atLeast(tenure, ESTABLISHED_MIN_TENURE_DAYS)
  return volume && tenured ? 'eligible' : 'no_standing'
}

/**
 * Whether a resolved spam vote may be written down against the ACCOUNT, or
 * only acted on for this message.
 *
 * A message with no words produces a ballot with nothing to quote, and people
 * vote on those anyway: production 2026-08-25 recorded two spam votes on a
 * question whose body was a pair of empty quotes. Naming the medium (see
 * `mediaCategoryOf`) makes the question honest, but it does not make the
 * answer informed — nobody judged any words, because there were none.
 *
 * So the two consequences separate. Deleting the message and muting for a
 * while are about this incident: both expire, and a ham vote reverses them.
 * A detection is neither. It is durable, three mechanisms read it, and two of
 * those — `prior_spam_detections` and the shield that keeps a non-newish
 * account at `mute` instead of `ban` — make the NEXT judgement harsher. A
 * count that raises the price of somebody's next message has to rest on
 * something the record can still show.
 *
 * This is the asymmetry the vote already lives under rather than a new one:
 * since 2026-08-23 a ballot may overturn on its own authority but may only
 * file a candidate, with promotion left to a second independent chat. Undoing
 * needs less than accusing, because the two errors do not cost the same.
 *
 * Takes the learn text, not the display preview: the preview is truncated for
 * a screen and could in principle be empty while the message was not.
 */
/**
 * Two voters saying spam, nobody saying otherwise, and the window ran out.
 *
 * Measured over the week to 2026-09-01: 146 of 244 questions expired, and 35
 * of them stood at two distinct "spam" against zero "not spam" when they did
 * — 24 in one chat that simply never has a third regular awake. The quorum
 * (`DEFAULT_THRESHOLD`) stays where it is for the SENDER: a mute needs three.
 * The message is a different question. Two members with standing called it
 * spam, and over the whole window not one person disagreed; leaving the advert
 * up on that record is the outcome nobody in the chat asked for. So the
 * message goes, the account is untouched and nothing is learned from it —
 * a deletion is the one act here a wrong call costs the least.
 */
export const UNOPPOSED_EXPIRY_MIN_SPAM = 2

export const expiryOutcome = (tally: Pick<VoteTally, 'spam' | 'ham'>): 'delete' | null =>
  tally.ham === 0 && tally.spam >= UNOPPOSED_EXPIRY_MIN_SPAM ? 'delete' : null

export const voteMayRecordDetection = (learnText: string): boolean =>
  learnText.trim().length > 0
