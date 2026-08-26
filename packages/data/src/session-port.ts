/**
 * In-memory session window for the abstain path: low-information messages
 * from a newcomer accumulate until the combined window is classifiable
 * ("пиши мені" / "в особисті" / "заробіток" … reads as spam only together).
 */
import type { SessionPort, SessionWindow } from '@lyadmin/core'

import { SESSION_WINDOW_MS } from './persistent-ports.js'

export interface SessionOptions {
  /** Only the in-memory port honours this; the Mongo one uses a TTL index. */
  windowMs?: number
  maxMessages?: number
  maxTrackedSessions?: number
}

const DEFAULTS: Required<SessionOptions> = {
  windowMs: SESSION_WINDOW_MS,
  maxMessages: 10,
  maxTrackedSessions: 5000
}

/** One buffered message, keyed so an edit replaces it — see `SessionPort.append`. */
interface BufferedMessage {
  id: number
  text: string
}

interface SessionEntry {
  messages: BufferedMessage[]
  startedMs: number
}

export class MemorySessionPort implements SessionPort {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly options: Required<SessionOptions>

  constructor(options: SessionOptions = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULTS, ...options }
  }

  async append(chatId: number, userId: number, messageId: number, text: string): Promise<SessionWindow> {
    const key = `${chatId}:${userId}`
    const nowMs = this.now()

    let entry = this.sessions.get(key)
    if (entry && nowMs - entry.startedMs > this.options.windowMs) {
      this.sessions.delete(key)
      entry = undefined
    }
    if (!entry) {
      entry = { messages: [], startedMs: nowMs }
      this.sessions.set(key, entry)
      this.evictIfNeeded()
    }

    if (text) {
      // Replace, then append: an edit is the same message said again, and the
      // newest text is the one that counts. Keeping both copies is what turned
      // three conversational messages into a five-line "flood" in production.
      const at = entry.messages.findIndex((m) => m.id === messageId)
      if (at >= 0) entry.messages.splice(at, 1)
      entry.messages.push({ id: messageId, text })
      if (entry.messages.length > this.options.maxMessages) entry.messages.shift()
    }

    return {
      combinedText: entry.messages.map((m) => m.text).join('\n'),
      count: entry.messages.length
    }
  }

  /** Clear after a decisive verdict so old lines don't haunt the user. */
  async reset(chatId: number, userId: number): Promise<void> {
    this.sessions.delete(`${chatId}:${userId}`)
  }

  private evictIfNeeded(): void {
    if (this.sessions.size <= this.options.maxTrackedSessions) return
    const toDrop = this.sessions.size - this.options.maxTrackedSessions
    let dropped = 0
    for (const key of this.sessions.keys()) {
      this.sessions.delete(key)
      if (++dropped >= toDrop) break
    }
  }
}
