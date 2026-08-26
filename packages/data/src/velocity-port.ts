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
  count: number
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
      entry = { chatIds: new Set(), userIds: new Set(), count: 0, firstSeenMs: nowMs }
      this.entries.set(key, entry)
      this.evictIfNeeded()
    }

    /**
     * An edit is not a new sighting — see `PersistentVelocityPort.check` for
     * the production case. Skipped rather than de-duplicated by id, because the
     * key IS the normalised text: a message edited into something else lands on
     * a different key and earns its first sighting there, correctly.
     *
     * The comment above about sharing `velocityKey` is exactly why this is here
     * too. Two implementations of "the same message" is two answers to one
     * question, and for a while the id half of that answer was in neither.
     */
    if (!input.message.isEdit) {
      entry.chatIds.add(input.message.chatId)
      entry.userIds.add(input.user.id)
      entry.count += 1
    }

    // `userIds` was tracked and then thrown away (2026-07-30 review). It is the
    // difference between the two things this window sees: ONE account repeating
    // itself is the sender's own behaviour, observed directly — while several
    // accounts carrying the same line may be a multi-account campaign OR a text
    // that simply went viral (a news line, a meme, an announcement people
    // copy-paste). Both stay detected; only the first is certain enough to act
    // on without asking anybody, and only the first gets the lower bar.
    const singleAuthor = entry.userIds.size === 1
    const exceeded =
      entry.chatIds.size >= this.options.chatThreshold ||
      entry.count >= (singleAuthor
        ? Math.min(this.options.soloThreshold, this.options.countThreshold)
        : this.options.countThreshold)
    if (!exceeded) return { exceeded: false }
    return {
      exceeded: true,
      singleAuthor,
      evidence: `${entry.count} copies in ${entry.chatIds.size} chats from ${entry.userIds.size} accounts within window`
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
