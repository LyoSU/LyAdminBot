/**
 * What a Telegram service line says about who joined.
 *
 * Extracted 2026-08-26 because two places were answering this question and only
 * one of them was right. `extractJoiners` had it: a join arrives three ways, and
 * for `users_added` the people who joined are named in the action while the
 * SENDER is whoever added them. `handleReport`'s service-message branch, written
 * later, read `replied.sender` — so `/report` on an "X added Y" line screened X.
 *
 * The classification is the whole of the mistake, so it is the whole of what is
 * pulled out here: no gateway, no `getUsers`, nothing to stub. Both callers now
 * ask the same function, which is the only arrangement in which they cannot
 * disagree again.
 *
 * `none` covers every other service line — a pin, a departure, a title change, a
 * video chat. Those name nobody who just arrived, and treating them as joins is
 * how a report on a pin notice ended up aimed at the admin who pinned it.
 */
export type JoinerSource =
  /** `users_added`: these ids joined. Never the sender. */
  | { kind: 'ids'; ids: number[] }
  /** Joined by invite link, or approved: the sender is the joiner. */
  | { kind: 'sender' }
  /** Not a join. */
  | { kind: 'none' }

/** The shape this needs from mtcute's `Message.action`, and nothing more. */
export interface JoinActionLike {
  type: string
  users?: readonly number[] | undefined
}

export const joinerSource = (action: JoinActionLike | null | undefined): JoinerSource => {
  if (!action) return { kind: 'none' }
  if (action.type === 'users_added') {
    // Defended rather than assumed: this is the one branch that reads a field
    // off the action, and a service line whose `users` did not arrive must read
    // as "nobody named" — never as "fall back to the sender", which is the very
    // substitution being fixed.
    return { kind: 'ids', ids: Array.isArray(action.users) ? [...action.users] : [] }
  }
  if (action.type === 'user_joined_link' || action.type === 'user_joined_approved') {
    return { kind: 'sender' }
  }
  return { kind: 'none' }
}
