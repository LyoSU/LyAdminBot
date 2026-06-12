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
}

export interface VoteTally {
  spam: number
  ham: number
  outcome: VoteChoice | 'pending'
}

const DEFAULT_THRESHOLD = 3

export const tallyVotes = (ballots: VoteBallot[], threshold = DEFAULT_THRESHOLD): VoteTally => {
  // Last ballot per user wins; garbage ballots are dropped, never thrown on.
  const latest = new Map<number, VoteBallot>()
  let adminChoice: VoteChoice | null = null
  for (const ballot of Array.isArray(ballots) ? ballots : []) {
    if (!Number.isFinite(ballot?.userId)) continue
    if (ballot.choice !== 'spam' && ballot.choice !== 'ham') continue
    latest.set(ballot.userId, ballot)
    if (ballot.isAdmin) adminChoice = ballot.choice
  }

  let spam = 0
  let ham = 0
  for (const ballot of latest.values()) {
    if (ballot.choice === 'spam') spam += 1
    else ham += 1
  }

  if (adminChoice) return { spam, ham, outcome: adminChoice }
  if (spam - ham >= threshold) return { spam, ham, outcome: 'spam' }
  if (ham - spam >= threshold) return { spam, ham, outcome: 'ham' }
  return { spam, ham, outcome: 'pending' }
}
