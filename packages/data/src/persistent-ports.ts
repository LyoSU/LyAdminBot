/**
 * Mongo-backed velocity and session ports. These two states drive decisive
 * verdicts (cross-chat flood detection; abstain-window accumulation), so
 * per-process memory meant every deploy reset the flood window and made
 * waves invisible across instances. Persisting them in Mongo (already the
 * primary store, TTL-expired) fixes restart loss and cross-instance blindness
 * without new infrastructure.
 *
 * The conversation window stays memory-only on purpose (see
 * conversation-window.ts) — it only feeds LLM context and must not add a
 * round-trip to the hot path.
 *
 * The Mongo plumbing lives behind these narrow backends so the port logic
 * (guards, thresholds, evidence) stays unit-testable; MongoStore implements
 * them. Both ports degrade safely: a backend error returns null (velocity)
 * or a single-message window (session) and never throws into moderation.
 */
import type {
  BurstEntry, BurstPort, EvaluationInput, SessionPort, SessionWindow, VelocityPort, VelocityResult
} from '@lyadmin/core'
import { truncate } from '@lyadmin/core'
import { normalizeHeavy, sha256 } from './hashing.js'
import type { VelocityOptions, SessionOptions } from './index.js'

/**
 * Both windows are enforced by a Mongo TTL index on the document, not by a
 * query bound — the aggregate IS the surviving document. The backends
 * therefore take no `windowMs`: they used to, and `MongoStore` simply declared
 * three parameters and let the fourth fall on the floor, so the constant here
 * could be edited to any value at all and change nothing. The store builds its
 * TTL indexes from the two constants below, which makes the window a single
 * fact with a single owner.
 */
export const VELOCITY_WINDOW_MS = 6 * 60 * 60 * 1000
export const SESSION_WINDOW_MS = 30 * 60 * 1000
/**
 * How long a sender's run of messages stays one run: ten minutes from its FIRST
 * message, not from its last.
 *
 * Expiring from the start is what makes the window a window rather than a
 * rolling record of everything a chatty member ever said — somebody talking for
 * half an hour is three separate runs here, which is the honest reading. It is
 * also how the session window already behaves, and the TTL index is on the same
 * field for the same reason.
 *
 * Shorter than the velocity window (six hours) on purpose: velocity asks whether
 * a TEXT is going round, which unfolds over hours, while this asks whether a
 * PERSON is mid-burst, which does not.
 */
export const BURST_WINDOW_MS = 10 * 60 * 1000

export interface VelocityBackend {
  /** Record one sighting of `hash` and return the windowed aggregates. */
  bumpVelocity(hash: string, chatId: number, userId: number):
    Promise<{ count: number; chatCount: number; userCount: number }>
}

export interface SessionBackend {
  /** Append `text` (if any) to the window, trim to maxMessages, return it. */
  appendSession(key: string, text: string, maxMessages: number): Promise<string[]>
  resetSession(key: string): Promise<void>
}

export interface BurstBackend {
  /** Append one judged message, keeping at most `maxEntries` newest. */
  appendBurst(key: string, entry: BurstEntry, maxEntries: number): Promise<void>
  readBurst(key: string): Promise<BurstEntry[]>
  resetBurst(key: string): Promise<void>
}

/**
 * Thresholds, and why the solo bar is lower than the crowd bar.
 *
 * The window used to be ten minutes, which is shorter than the cadence spam
 * actually arrives at: production 2026-08-01 had one account post the identical
 * advert six times over a hundred minutes, roughly a quarter-hour apart, and
 * velocity saw a fresh document every time. Six hours covers that shape without
 * pretending to cover a campaign that runs for days — signatures own that.
 *
 * A wider window would be reckless at a flat threshold, so the legs split. One
 * account repeating itself is the sender's own behaviour, observed directly,
 * and three copies of one text is already a pattern nobody produces by
 * accident. Several accounts posting the same line is what a campaign looks
 * like AND what a joke going round a chat looks like, so that leg keeps the
 * higher bar and the votable score.
 */
const VELOCITY_DEFAULTS: Required<Omit<VelocityOptions, 'maxTrackedTexts' | 'windowMs'>> = {
  chatThreshold: 3,
  countThreshold: 5,
  soloThreshold: 3
}

export class PersistentVelocityPort implements VelocityPort {
  private readonly opts: Required<Omit<VelocityOptions, 'maxTrackedTexts' | 'windowMs'>>
  constructor(private readonly backend: VelocityBackend, options: VelocityOptions = {}) {
    this.opts = { ...VELOCITY_DEFAULTS, ...options }
  }

  async check(input: EvaluationInput): Promise<VelocityResult | null> {
    const text = input.message.text
    if (!text) return null
    const template = normalizeHeavy(text)
    if (template.length < 5) return null

    try {
      const { count, chatCount, userCount } =
        await this.backend.bumpVelocity(sha256(template), input.message.chatId, input.user.id)
      // Computed since the counter existed and thrown away until 2026-08-01,
      // which left `singleAuthor` permanently absent — read conservatively as a
      // wave, so the one-account branch of the verdict had never once run.
      const singleAuthor = userCount === 1
      const spread = chatCount >= this.opts.chatThreshold
      // `min`, not a branch: the solo bar may only ever make the window MORE
      // sensitive. Reading it as a replacement would let a caller lower
      // `countThreshold` and silently have it ignored for the very case the
      // window is best at seeing.
      const bar = singleAuthor
        ? Math.min(this.opts.soloThreshold, this.opts.countThreshold)
        : this.opts.countThreshold
      const repeats = count >= bar
      if (!spread && !repeats) return { exceeded: false }
      return {
        exceeded: true,
        singleAuthor,
        evidence: `${count} copies in ${chatCount} chats from ${userCount} accounts within window`
      }
    } catch {
      return null // backend unavailable → stage unavailable, pipeline continues
    }
  }
}

const SESSION_DEFAULTS: Required<Omit<SessionOptions, 'maxTrackedSessions' | 'windowMs'>> = {
  maxMessages: 10
}

export class PersistentSessionPort implements SessionPort {
  private readonly opts: Required<Omit<SessionOptions, 'maxTrackedSessions' | 'windowMs'>>
  constructor(private readonly backend: SessionBackend, options: SessionOptions = {}) {
    this.opts = { ...SESSION_DEFAULTS, ...options }
  }

  async append(chatId: number, userId: number, text: string): Promise<SessionWindow> {
    try {
      const texts = await this.backend.appendSession(`${chatId}:${userId}`, text, this.opts.maxMessages)
      return { combinedText: texts.join('\n'), count: texts.length }
    } catch {
      return { combinedText: text, count: text ? 1 : 0 }
    }
  }

  async reset(chatId: number, userId: number): Promise<void> {
    await this.backend.resetSession(`${chatId}:${userId}`).catch(() => { /* best-effort */ })
  }
}

/** At most this many messages of one run are remembered. */
const BURST_MAX_ENTRIES = 10
/**
 * Per-message text kept in the window. Enough for a solicitation to read as one
 * in the blob, and small enough that ten of them are a document nobody notices —
 * the store has hit its size quota once already (2026-07-06).
 */
const BURST_MAX_TEXT = 500

/**
 * The sender's recent messages in one chat, with what the pipeline made of each.
 *
 * In Mongo rather than in process memory, unlike the conversation window: these
 * entries feed SIGNALS and can open a classifier call, so a verdict has to be
 * reproducible from stored state — `tools/replay` and every calibration argument
 * depend on that. The incident memo in the app layer is the opposite case (it
 * creates no judgement) and stays in memory deliberately.
 */
export class PersistentBurstPort implements BurstPort {
  constructor(private readonly backend: BurstBackend) {}

  private key(chatId: number, userId: number): string { return `${chatId}:${userId}` }

  async read(chatId: number, userId: number): Promise<BurstEntry[]> {
    try {
      const entries = await this.backend.readBurst(this.key(chatId, userId))
      // The TTL index bounds the DOCUMENT, and Mongo sweeps it on its own
      // schedule — up to a minute late, and later still on a shared tier. The
      // window is a claim about the last ten minutes, so it is enforced here too.
      const floor = Date.now() - BURST_WINDOW_MS
      return entries.filter((e) => e.at >= floor)
    } catch {
      // A window we cannot read is a window with nothing in it: the signals
      // simply do not fire. Never an exception into moderation.
      return []
    }
  }

  async append(chatId: number, userId: number, entry: Omit<BurstEntry, 'template'>): Promise<void> {
    // `truncate`, not `slice`: cutting between the halves of a surrogate pair
    // yields a string Mongo stores as U+FFFD and the LLM request cannot encode
    // at all (2026-08-07). The template is computed from the FULL text, since it
    // has to match what velocity counts.
    const stored: BurstEntry = {
      text: truncate(entry.text, BURST_MAX_TEXT),
      template: normalizeHeavy(entry.text),
      pSpam: entry.pSpam,
      at: entry.at
    }
    await this.backend.appendBurst(this.key(chatId, userId), stored, BURST_MAX_ENTRIES)
      .catch(() => { /* the window is an optimisation, never a precondition */ })
  }

  async reset(chatId: number, userId: number): Promise<void> {
    await this.backend.resetBurst(this.key(chatId, userId)).catch(() => { /* best-effort */ })
  }
}
