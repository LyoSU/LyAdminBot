/**
 * In-memory velocity store: catches the same (or templated-same) text
 * blasted across chats in a short window. v1 used per-process memory too;
 * a Redis backend can be added behind the same interface later.
 */
import type { EvaluationInput, VelocityPort, VelocityResult } from '@lyadmin/core'
import { normalizeHeavy, sha256 } from './hashing.js'

interface WindowEntry {
  chatIds: Set<number>
  userIds: Set<number>
  count: number
  firstSeenMs: number
}

export interface VelocityOptions {
  windowMs?: number
  /** Same text in this many chats inside the window → exceeded. */
  chatThreshold?: number
  /** Same text this many times total inside the window → exceeded. */
  countThreshold?: number
  maxTrackedTexts?: number
}

const DEFAULTS: Required<VelocityOptions> = {
  windowMs: 10 * 60 * 1000,
  chatThreshold: 3,
  countThreshold: 5,
  maxTrackedTexts: 10_000
}

export class MemoryVelocityPort implements VelocityPort {
  private readonly entries = new Map<string, WindowEntry>()
  private readonly options: Required<VelocityOptions>

  constructor(options: VelocityOptions = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULTS, ...options }
  }

  async check(input: EvaluationInput): Promise<VelocityResult | null> {
    const text = input.message.text
    if (!text) return null
    const template = normalizeHeavy(text)
    if (template.length < 5) return null

    const key = sha256(template)
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

    entry.chatIds.add(input.message.chatId)
    entry.userIds.add(input.user.id)
    entry.count += 1

    const exceeded =
      entry.chatIds.size >= this.options.chatThreshold ||
      entry.count >= this.options.countThreshold
    if (!exceeded) return { exceeded: false }
    return {
      exceeded: true,
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
