/**
 * In-memory velocity store: catches the same (or templated-same) text
 * blasted across chats in a short window. v1 used per-process memory too;
 * a Redis backend can be added behind the same interface later.
 */
import type {
  EvaluationInput, VelocityCheckOptions, VelocityPort, VelocityResult
} from '@lyadmin/core'
import { VELOCITY_WINDOW_MS, velocityKey } from './persistent-ports.js'

interface WindowEntry {
  chatIds: Set<number>
  userIds: Set<number>
  /** `chatId:messageId` — distinct messages, not passes over them. */
  messageIds: Set<string>
  firstSeenMs: number
}

export interface VelocityOptions {
  /** Only the in-memory port honours this; the Mongo one uses a TTL index. */
  windowMs?: number
  /** Same text in this many chats inside the window → exceeded. */
  chatThreshold?: number
  /** Same text this many times total inside the window → exceeded. */
  countThreshold?: number
  /** Same text this many times from ONE account → exceeded. See below. */
  soloThreshold?: number
  maxTrackedTexts?: number
}

const DEFAULTS: Required<VelocityOptions> = {
  windowMs: VELOCITY_WINDOW_MS,
  chatThreshold: 3,
  countThreshold: 5,
  soloThreshold: 3,
  maxTrackedTexts: 10_000
}

export class MemoryVelocityPort implements VelocityPort {
  private readonly entries = new Map<string, WindowEntry>()
  private readonly options: Required<VelocityOptions>

  constructor(options: VelocityOptions = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULTS, ...options }
  }

  async check(input: EvaluationInput, options: VelocityCheckOptions = {}): Promise<VelocityResult | null> {
    const text = input.message.text
    if (!text) return null
    // Shared with the Mongo port deliberately: two implementations of "what
    // counts as the same message" is two answers to one question.
    const key = velocityKey(text, options)
    if (key === null) return null

    const nowMs = this.now()

    let entry = this.entries.get(key)
    if (entry && nowMs - entry.firstSeenMs > this.options.windowMs) {
      this.entries.delete(key)
      entry = undefined
    }
    if (!entry) {
      entry = { chatIds: new Set(), userIds: new Set(), messageIds: new Set(), firstSeenMs: nowMs }
      this.entries.set(key, entry)
      this.evictIfNeeded()
    }

    /**
     * Distinct MESSAGES, not passes over them — an edit and a gap-recovery
     * replay are the same message arriving again. See `MongoStore.bumpVelocity`
     * for the production case and for why this is a set rather than an
     * exception carved out for edits.
     *
     * The comment above about sharing `velocityKey` is exactly why this is here
     * too: two implementations of "the same message" is two answers to one
     * question, and the id half of that answer was missing from both.
     */
    entry.chatIds.add(input.message.chatId)
    entry.userIds.add(input.user.id)
    entry.messageIds.add(`${input.message.chatId}:${input.message.messageId}`)

    // `userIds` was tracked and then thrown away (2026-07-30 review). It is the
    // difference between the two things this window sees: ONE account repeating
    // itself is the sender's own behaviour, observed directly — while several
    // accounts carrying the same line may be a multi-account campaign OR a text
    // that simply went viral (a news line, a meme, an announcement people
    // copy-paste). Both stay detected; only the first is certain enough to act
    // on without asking anybody, and only the first gets the lower bar.
    const singleAuthor = entry.userIds.size === 1
    const count = entry.messageIds.size
    const exceeded =
      entry.chatIds.size >= this.options.chatThreshold ||
      count >= (singleAuthor
        ? Math.min(this.options.soloThreshold, this.options.countThreshold)
        : this.options.countThreshold)
    if (!exceeded) return { exceeded: false }
    return {
      exceeded: true,
      singleAuthor,
      evidence: `${count} copies in ${entry.chatIds.size} chats from ${entry.userIds.size} accounts within window`
    }
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.options.maxTrackedTexts) return
    // Drop the oldest entries (Map preserves insertion order).
    const toDrop = this.entries.size - this.options.maxTrackedTexts
    let dropped = 0
    for (const key of this.entries.keys()) {
      this.entries.delete(key)
      if (++dropped >= toDrop) break
    }
  }
}
