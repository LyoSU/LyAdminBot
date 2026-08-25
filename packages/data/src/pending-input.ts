/**
 * Transient per-user input state for PM editor flows (add a welcome text,
 * add a welcome gif, add an extra). Memory-only by design — same rationale as
 * MemoryConversationWindow: a half-finished "add" that outlives a bot restart
 * is not worth persisting, the admin simply taps the button again. Entries
 * self-expire after a TTL so an abandoned prompt never silently eats the
 * admin's next unrelated PM message.
 */

export interface PendingEntry {
  /** Flow discriminator, e.g. 'welcome.text' | 'welcome.gif' | 'extra'. */
  type: string
  /** The group being configured (the PM editor always targets a group). */
  chatId: number
  /** Optional flow argument, e.g. the extra name being defined. */
  arg?: string
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

export class PendingInput {
  private readonly store = new Map<number, PendingEntry & { at: number }>()

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  set(userId: number, entry: PendingEntry, now: number = Date.now()): void {
    this.store.set(userId, { ...entry, at: now })
  }

  /**
   * Read WITHOUT removing. `'expired'` where a lapsed entry was evicted, which
   * the caller needs told apart from "there was never one".
   *
   * The flows used to consume on read, before validation. So "that's not media,
   * send a gif" and "invalid name" both destroyed the state they were asking
   * the admin to correct: the corrected second message arrived with no pending
   * entry, fell through to the /start handler, and the editor looked broken. An
   * expiry did the same thing silently. Consumption now belongs to the caller
   * that knows the flow finished.
   */
  peek(userId: number, now: number = Date.now()): PendingEntry | 'expired' | null {
    const e = this.store.get(userId)
    if (!e) return null
    if (now - e.at > this.ttlMs) {
      this.store.delete(userId)
      return 'expired'
    }
    return { type: e.type, chatId: e.chatId, ...(e.arg !== undefined ? { arg: e.arg } : {}) }
  }

  /** Read AND remove the pending entry (one-shot). Null if absent or expired. */
  take(userId: number, now: number = Date.now()): PendingEntry | null {
    const e = this.store.get(userId)
    if (!e) return null
    this.store.delete(userId)
    if (now - e.at > this.ttlMs) return null
    return { type: e.type, chatId: e.chatId, ...(e.arg !== undefined ? { arg: e.arg } : {}) }
  }

  /** Non-consuming check; also evicts an expired entry as a side effect. */
  has(userId: number, now: number = Date.now()): boolean {
    const e = this.store.get(userId)
    if (!e) return false
    if (now - e.at > this.ttlMs) {
      this.store.delete(userId)
      return false
    }
    return true
  }

  cancel(userId: number): void {
    this.store.delete(userId)
  }
}
