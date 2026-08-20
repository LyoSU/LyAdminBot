/**
 * One spammer's run of messages, treated as one event.
 *
 * The pipeline judges a message. It has no memory of the sender between
 * messages, which is right for a judgement and wrong for everything that
 * follows one: eight messages from an account we banned on the first used to
 * cost eight full evaluations, eight classifier calls, eight cards in the chat
 * and eight decision records — the chat reading our bookkeeping instead of the
 * conversation, at eight times the price.
 *
 * The rule that keeps this safe is a ceiling, not a memory: **an incident may do
 * exactly what the enforcement that opened it already did, and nothing more.**
 *
 *  - The sender was REMOVED (ban/kick/mute). Removal already passed
 *    `SENDER_REMOVAL_MIN_EVIDENCE` — two units of firsthand message evidence,
 *    the bar for taking the chat away from somebody. Their next messages are by
 *    definition unwanted, so they go without being judged. No new judgement is
 *    made, so no new mistake can be made; the mistake, if there was one, was
 *    made once and is corrected once.
 *  - Only the MESSAGE was removed (`delete`). The sender is still a member with
 *    every benefit of the doubt they had a minute ago, and one bad link does not
 *    make their next sentence spam. Their messages keep going through the whole
 *    pipeline; the incident earns only the right to update its own card instead
 *    of posting a second one.
 *  - The verdict was UNSURE (`needsVote`). Never any power over a message: an
 *    open question does not become an answer by being repeated. The run does
 *    share one ballot instead of opening a new one per message — the chat was
 *    asked about this sender, and asking again while the first question is still
 *    open is how a settled text came to be voted on seven times (2026-08-02).
 *
 * Nothing here touches Telegram or the store, so the table above is testable as
 * arithmetic — which is the point, because it is the whole safety argument.
 *
 * Memory-only and deliberately so, unlike the burst window in `@lyadmin/data`:
 * an incident creates no judgement and states no fact worth reproducing, so
 * losing it to a restart costs one thing only — the next messages of that run
 * get evaluated at full price, exactly as they were before this file existed.
 */
import { isEnforcementAction, removesSender, type Verdict, type VerdictAction } from '@lyadmin/core'

/** What an incident is allowed to do to the sender's subsequent messages. */
export type IncidentPower =
  /** Delete them unread — the sender has already been removed from the chat. */
  | 'silence_sender'
  /** Judge them as usual; only the notification or the ballot is shared. */
  | 'card_only'

export interface Incident {
  power: IncidentPower
  action: VerdictAction
  reasonCode: string
  /** The message whose verdict opened this — the decision record to append to. */
  triggerMessageId: number
  /** The compact card in the chat, edited in place as the run grows. */
  cardMessageId: number | null
  /**
   * A community ballot is already open on this run. Further messages join it
   * rather than opening a second one — the ballot asks about the SENDER, and
   * `enforceVoteSpam` acts on the sender when it resolves.
   */
  hasOpenVote: boolean
  /**
   * How many of this sender's messages the incident has cost them, the trigger
   * included. This is the number an override has to be able to report: deleting
   * is the one thing a correction cannot undo, so the least we owe is an honest
   * count of what was destroyed.
   */
  removedCount: number
  openedAt: number
}

/**
 * What, if anything, this verdict may license against the sender's next
 * messages. Null means no incident at all.
 *
 * `applied` is not a detail: a verdict Telegram refused to execute has removed
 * nobody, and treating it as containment would silence a sender who is still
 * there and still allowed to speak.
 */
export const incidentPowerFor = (verdict: Verdict, applied: boolean): IncidentPower | null => {
  if (!applied || !isEnforcementAction(verdict.action)) return null
  // An unsure verdict may never silence, whatever action carried it: the whole
  // of its uncertainty is that we do not know this sender is a spammer.
  if (verdict.needsVote) return 'card_only'
  return removesSender(verdict.action) ? 'silence_sender' : 'card_only'
}

const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`

/** Ten minutes: long enough for a flood, short enough not to be a sentence. */
const INCIDENT_TTL_MS = 10 * 60 * 1000
const MAX_INCIDENTS = 2000

export class IncidentTracker {
  private readonly incidents = new Map<string, Incident>()
  private readonly ttlMs: number
  private readonly maxTracked: number

  constructor(options: { ttlMs?: number; maxTracked?: number } = {}) {
    this.ttlMs = options.ttlMs ?? INCIDENT_TTL_MS
    this.maxTracked = options.maxTracked ?? MAX_INCIDENTS
  }

  open(
    chatId: number,
    userId: number,
    incident: Omit<Incident, 'openedAt' | 'removedCount' | 'hasOpenVote'> &
      { removedCount?: number; hasOpenVote?: boolean },
    now = Date.now()
  ): Incident {
    this.prune(now)
    const opened: Incident = {
      ...incident,
      removedCount: incident.removedCount ?? 1,
      hasOpenVote: incident.hasOpenVote ?? false,
      openedAt: now
    }
    this.incidents.set(keyOf(chatId, userId), opened)
    return opened
  }

  /** The live incident for this sender, or null once it has aged out. */
  live(chatId: number, userId: number, now = Date.now()): Incident | null {
    const key = keyOf(chatId, userId)
    const incident = this.incidents.get(key)
    if (!incident) return null
    if (now - incident.openedAt >= this.ttlMs) {
      this.incidents.delete(key)
      return null
    }
    return incident
  }

  /**
   * The incident only if it may act on a message by itself. Every caller that
   * is about to delete something unread must ask through this and not `live`.
   */
  silencing(chatId: number, userId: number, now = Date.now()): Incident | null {
    const incident = this.live(chatId, userId, now)
    return incident?.power === 'silence_sender' ? incident : null
  }

  /** Note further messages this incident has cost the sender. */
  addRemoved(chatId: number, userId: number, count = 1, now = Date.now()): Incident | null {
    const incident = this.live(chatId, userId, now)
    if (!incident) return null
    incident.removedCount += count
    return incident
  }

  /**
   * Point the incident at a freshly posted card.
   *
   * Needed because the card is ephemeral (90 seconds) and a run is not (ten
   * minutes): when the notice expires mid-run the next enforcement posts a new
   * one, and the incident adopts it rather than starting over — the count of what
   * the run has cost has to survive the notice that announced it.
   */
  attachCard(chatId: number, userId: number, cardMessageId: number, now = Date.now()): void {
    const incident = this.live(chatId, userId, now)
    if (incident) incident.cardMessageId = cardMessageId
  }

  /** The chat has been asked about this run; further messages join that ballot. */
  markVoteOpen(chatId: number, userId: number, now = Date.now()): void {
    const incident = this.live(chatId, userId, now)
    if (incident) incident.hasOpenVote = true
  }

  /**
   * Forget the incident. Called when the verdict behind it is overturned — an
   * incident that outlived its own verdict would keep deleting the messages of
   * somebody the chat has just vouched for.
   */
  close(chatId: number, userId: number): void {
    this.incidents.delete(keyOf(chatId, userId))
  }

  private prune(now: number): void {
    if (this.incidents.size < this.maxTracked) return
    for (const [key, incident] of this.incidents) {
      if (now - incident.openedAt >= this.ttlMs) this.incidents.delete(key)
    }
    // Still full of live incidents: drop the oldest, which is insertion order.
    while (this.incidents.size >= this.maxTracked) {
      const oldest = this.incidents.keys().next().value
      if (oldest === undefined) break
      this.incidents.delete(oldest)
    }
  }
}

interface SeenMessage {
  messageId: number
  pSpam: number
  at: number
}

/** Ten minutes and twenty messages — the same run the incident TTL describes. */
const SEEN_WINDOW_MS = 10 * 60 * 1000
const SEEN_MAX_PER_SENDER = 20
const MAX_LOGGED_SENDERS = 5000

/**
 * What each sender said recently in each chat, and what the pipeline made of it.
 *
 * This exists for one question: when a verdict removes somebody, which of their
 * earlier messages go with them? Spam arrives in runs and the verdict lands on
 * whichever message finally crossed the bar — so without this, banning the
 * sender of the sixth advert left the first five in the chat forever, because
 * `applyVerdict` is given exactly one message id.
 *
 * Scores are kept per message because the answer must be selective. Deleting is
 * irreversible: an override can unban, unmute and give the standing back, but
 * nothing brings a message back, so the blast radius of a false positive is
 * decided here and nowhere else.
 */
export class SenderMessageLog {
  private readonly seen = new Map<string, SeenMessage[]>()
  private readonly windowMs: number
  private readonly maxPerSender: number
  private readonly maxSenders: number

  constructor(options: { windowMs?: number; maxPerSender?: number; maxSenders?: number } = {}) {
    this.windowMs = options.windowMs ?? SEEN_WINDOW_MS
    this.maxPerSender = options.maxPerSender ?? SEEN_MAX_PER_SENDER
    this.maxSenders = options.maxSenders ?? MAX_LOGGED_SENDERS
  }

  /** Remember one judged message. Messages nothing judged do not belong here. */
  note(chatId: number, userId: number, messageId: number, pSpam: number, now = Date.now()): void {
    const key = keyOf(chatId, userId)
    const list = this.seen.get(key) ?? []
    list.push({ messageId, pSpam, at: now })
    // Trim by age first so a burst of twenty does not evict a still-relevant one.
    const floor = now - this.windowMs
    const kept = list.filter((m) => m.at >= floor).slice(-this.maxPerSender)
    this.seen.set(key, kept)
    if (this.seen.size > this.maxSenders) this.prune(now)
  }

  /**
   * The sender's earlier messages that should go when the sender does.
   *
   * `minPSpam` is the bar and the caller owns it: the pipeline's own grey floor,
   * i.e. only messages it had already declined to call clean. An ordinary
   * exchange scores around 0.1 and stays — which is the entire protection for
   * the member who was mid-argument when somebody else's verdict landed.
   *
   * `except` is the triggering message, which the executor deletes itself.
   */
  purgeTargets(
    chatId: number,
    userId: number,
    params: { except: number; minPSpam: number },
    now = Date.now()
  ): number[] {
    const list = this.seen.get(keyOf(chatId, userId))
    if (!list) return []
    const floor = now - this.windowMs
    return list
      .filter((m) => m.at >= floor && m.messageId !== params.except && m.pSpam >= params.minPSpam)
      .map((m) => m.messageId)
  }

  forget(chatId: number, userId: number): void {
    this.seen.delete(keyOf(chatId, userId))
  }

  private prune(now: number): void {
    const floor = now - this.windowMs
    for (const [key, list] of this.seen) {
      const kept = list.filter((m) => m.at >= floor)
      if (kept.length === 0) this.seen.delete(key)
      else this.seen.set(key, kept)
    }
    while (this.seen.size > this.maxSenders) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }
}
