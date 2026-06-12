/**
 * In-memory session window for the abstain path: low-information messages
 * from a newcomer accumulate until the combined window is classifiable
 * ("пиши мені" / "в особисті" / "заробіток" … reads as spam only together).
 */
import type { SessionPort, SessionWindow } from '@lyadmin/core'

export interface SessionOptions {
  windowMs?: number
  maxMessages?: number
  maxTrackedSessions?: number
}

const DEFAULTS: Required<SessionOptions> = {
  windowMs: 30 * 60 * 1000,
  maxMessages: 10,
  maxTrackedSessions: 5000
}

interface SessionEntry {
  texts: string[]
  startedMs: number
}

export class MemorySessionPort implements SessionPort {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly options: Required<SessionOptions>

  constructor(options: SessionOptions = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULTS, ...options }
  }

  async append(chatId: number, userId: number, text: string): Promise<SessionWindow> {
    const key = `${chatId}:${userId}`
    const nowMs = this.now()

    let entry = this.sessions.get(key)
    if (entry && nowMs - entry.startedMs > this.options.windowMs) {
      this.sessions.delete(key)
      entry = undefined
    }
    if (!entry) {
      entry = { texts: [], startedMs: nowMs }
      this.sessions.set(key, entry)
      this.evictIfNeeded()
    }

    if (text) {
      entry.texts.push(text)
      if (entry.texts.length > this.options.maxMessages) entry.texts.shift()
    }

    return { combinedText: entry.texts.join('\n'), count: entry.texts.length }
  }

  /** Clear after a decisive verdict so old lines don't haunt the user. */
  reset(chatId: number, userId: number): void {
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
