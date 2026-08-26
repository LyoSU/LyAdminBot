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

/** Whether an `edit_message` delivery is about the message's content. */
export const isContentEdit = (msg: { editDate: Date | null }): boolean => msg.editDate !== null
