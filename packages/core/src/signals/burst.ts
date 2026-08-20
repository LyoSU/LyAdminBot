/**
 * Reading a sender's recent burst — several messages from one account inside a
 * few minutes — as one thing rather than as N unrelated events.
 *
 * The gap this exists to close is narrow and specific. `velocity` counts the
 * SAME text arriving repeatedly and weighs it as firsthand evidence. The
 * abstain/session window buffers messages too short for anything to classify.
 * Between them sits the shape neither sees: five DIFFERENT messages from one
 * account, each long enough to be judged and each judged alone, so the sixth is
 * read as if it were the first. Spam split across messages — a line, then a
 * photo, then "write to me privately" — lives exactly there, and until this
 * module nothing in the pipeline looked at it.
 *
 * Two rules govern everything below.
 *
 * First: repetition is a reason to look harder, never a reason to conclude
 * more. `velocity` was a decider once and produced 16% false positives on its
 * own verdicts — cross-posting one message to several chats is something
 * ordinary members do (2026-08-07 audit). So both signals here are `shape`:
 * they may raise the score and open the classifier's gate, and they may never
 * be the case for taking the chat away from somebody.
 *
 * Second: a fact may only be charged once. `velocity_repeats` already prices
 * the same text arriving twice, so distinctness is measured on the heavy
 * template — copies collapse into one and the burst signal sees a single
 * message where velocity sees three.
 */
import type { Signal } from '../types.js'
import type { BurstEntry } from '../ports.js'

/**
 * Where "not clean" starts — the same 0.35 as the classifier's grey floor
 * (`LLM_GREY_LOW`), pinned to it by a test rather than by a comment.
 *
 * Exported because the app layer needs the identical bar when it decides which
 * of a removed sender's earlier messages to take down with them: "the pipeline
 * already thought this was not clean" has to mean one thing in both places.
 */
export const BURST_GREY_FLOOR = 0.35

/**
 * Distinct preceding messages before the burst is a burst — three counting the
 * one being judged.
 *
 * Two rather than four because the shape this is for completes in three: a
 * pitch, a picture, and where to write. Deliberately not one — a single earlier
 * message is a conversation, and every chat is full of them.
 */
const BURST_MIN_DISTINCT = 2

/** Preceding messages already scored above the grey floor for the second signal. */
const BURST_MIN_GREY = 2

/**
 * Messages needed before the burst is worth one classifier call, counting the
 * one being judged. Same three: below that the blob says no more than its parts
 * and the call buys nothing.
 */
const BURST_LLM_MIN_MESSAGES = 3

/** How much text a blob must carry before it is worth asking about. */
const BURST_LLM_MIN_CHARS = 20

/** Distinct heavy templates among the entries, ignoring the ones with none. */
const distinctTemplates = (entries: readonly BurstEntry[]): number =>
  new Set(entries.map((e) => e.template).filter((t) => t.length > 0)).size

/**
 * What the sender's preceding messages say about them, as signals.
 *
 * Returns nothing at all for a quiet sender, which is the common case and the
 * only one that must stay free.
 */
export const burstSignals = (entries: readonly BurstEntry[]): Signal[] => {
  if (entries.length === 0) return []
  const signals: Signal[] = []

  const distinct = distinctTemplates(entries)
  if (distinct >= BURST_MIN_DISTINCT) {
    signals.push({
      name: 'sender_burst',
      evidence: `${entries.length} messages, ${distinct} distinct, in the window`
    })
  }

  const grey = entries.filter((e) => e.pSpam >= BURST_GREY_FLOOR).length
  if (grey >= BURST_MIN_GREY) {
    signals.push({
      name: 'burst_grey_repeat',
      evidence: `${grey} of ${entries.length} scored ≥ ${BURST_GREY_FLOOR}`
    })
  }

  return signals
}

/**
 * The blob to classify, or null when the burst is not worth a call.
 *
 * `currentText` is included because the message being judged is part of its own
 * burst — it just has no score yet. The entries carry no score requirement
 * beyond one of them having been grey: a burst of unremarkable messages read
 * together is what the session path is for, and asking about every three-message
 * exchange in every chat is a bill nobody agreed to.
 *
 * Media-only entries contribute their presence (they counted toward the signals
 * above) and never their text. A window of empty strings was sent to the model
 * once, as "\n\n\n\n", and it answered — see `judgeAccumulated`.
 */
export const burstBlob = (
  entries: readonly BurstEntry[],
  currentText: string
): { text: string; count: number } | null => {
  if (entries.length + 1 < BURST_LLM_MIN_MESSAGES) return null
  if (!entries.some((e) => e.pSpam >= BURST_GREY_FLOOR)) return null
  const lines = [...entries.map((e) => e.text), currentText]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const text = lines.join('\n')
  if (text.length < BURST_LLM_MIN_CHARS) return null
  // One line is not a burst however long it is: the blob has to be the thing
  // that carries the meaning, not a single message with empty neighbours.
  if (lines.length < 2) return null
  return { text, count: lines.length }
}
