/**
 * An edit-class update is not proof that the message changed.
 *
 * MTProto has one update for "this message object is different now", and
 * reactions live on the message object. A reaction on a supergroup message
 * therefore arrives as `updateEditChannelMessage`, which mtcute maps to
 * `edit_message` exactly like a real edit (core 0.31,
 * highlevel/types/updates/parse-update.js). Pins and TTL changes travel the
 * same way.
 *
 * The stamp is what separates them. Telegram sets `edit_date` when the CONTENT
 * changes and leaves it alone otherwise — which is why the Bot API only emits
 * `edited_message` once that date moves, and why TDLib reports reactions
 * through a different update entirely. A message nobody has ever edited
 * reaches us with no stamp at all.
 *
 * Production 2026-08-27: putting a reaction on a command message ran the
 * command a second time. Re-reading an EDITED message is deliberate — promo
 * gets injected by edit — but commands, hashtag extras and the PM editor are
 * actions, and they fired again for a thumbs-up.
 *
 * Exactly once per message, not once per reaction: the edit dedup key carries
 * `editDate`, so the first reaction claimed `…:0` and every later one looked
 * like its redelivery.
 *
 * A reaction on a message that WAS edited once carries that older stamp and is
 * caught by the same dedup key — for as long as the key lives. Past its hour
 * the message is re-evaluated by the pipeline, which costs a run and, with the
 * arrival-only guards in the app, no action.
 */

import type { EditBaseline } from '@lyadmin/core'

/** Whether an `edit_message` delivery is about the message's content. */
export const isContentEdit = (msg: { editDate: Date | null }): boolean => msg.editDate !== null

/**
 * What an edit-class delivery is, judged against the version already judged.
 *
 * `isContentEdit` above answers a weaker question — "was this message EVER
 * edited" — and that gap convicted somebody (production 2026-08-28). A
 * reaction on a message that carried an edit stamp is an edit-class delivery
 * whose stamp is non-null, so it walked through the gate the moment the
 * one-hour in-memory dedup forgot the original edit. The pipeline then judged
 * the SAME text a second time, two hours later, with the `edited_message`
 * signal attached and a signature/velocity corpus that had kept growing — and
 * flipped `legit_share` into a delete.
 *
 * The baseline of the last judged version carries the two facts that settle
 * it:
 *
 * - `stale_echo` — the stamp has not moved past the judged version's. Every
 *   non-content delivery repeats the stamp verbatim (reactions, pins,
 *   gap-recovery replays), so there is no new version here at all.
 * - `noop_edit` — the stamp moved but the content key did not: a version bump
 *   the sender never typed. Nothing new to judge either, but worth telling
 *   apart in the log: a burst of these is Telegram stamping non-content
 *   changes, not replay traffic.
 * - `run` — a version the pipeline has not seen. Also the answer whenever the
 *   remembered baseline predates these fields, because under-blocking is the
 *   direction that never deletes somebody over a missing field.
 */
export type EditDeliveryClass = 'run' | 'stale_echo' | 'noop_edit'

export const classifyEditDelivery = (
  judged: EditBaseline | null,
  current: Pick<EditBaseline, 'editDate' | 'contentKey'>
): EditDeliveryClass => {
  if (!judged) return 'run'
  const stamp = current.editDate ?? 0
  if (typeof judged.editDate === 'number' && stamp <= judged.editDate) return 'stale_echo'
  if (judged.contentKey !== undefined && judged.contentKey === current.contentKey) return 'noop_edit'
  return 'run'
}
