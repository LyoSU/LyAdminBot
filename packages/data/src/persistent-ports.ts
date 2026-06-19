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
import type { EvaluationInput, SessionPort, SessionWindow, VelocityPort, VelocityResult } from '@lyadmin/core'
import { normalizeHeavy, sha256 } from './hashing.js'
import type { VelocityOptions, SessionOptions } from './index.js'

export interface VelocityBackend {
  /** Record one sighting of `hash` and return the windowed aggregates. */
  bumpVelocity(hash: string, chatId: number, userId: number, windowMs: number):
    Promise<{ count: number; chatCount: number; userCount: number }>
}

export interface SessionBackend {
  /** Append `text` (if any) to the window, trim to maxMessages, return it. */
  appendSession(key: string, text: string, maxMessages: number, windowMs: number): Promise<string[]>
  resetSession(key: string): Promise<void>
}

const VELOCITY_DEFAULTS: Required<Omit<VelocityOptions, 'maxTrackedTexts'>> = {
  windowMs: 10 * 60 * 1000,
  chatThreshold: 3,
  countThreshold: 5
}

export class PersistentVelocityPort implements VelocityPort {
  private readonly opts: Required<Omit<VelocityOptions, 'maxTrackedTexts'>>
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
        await this.backend.bumpVelocity(sha256(template), input.message.chatId, input.user.id, this.opts.windowMs)
      if (chatCount < this.opts.chatThreshold && count < this.opts.countThreshold) {
        return { exceeded: false }
      }
      return {
        exceeded: true,
        evidence: `${count} copies in ${chatCount} chats from ${userCount} accounts within window`
      }
    } catch {
      return null // backend unavailable → stage unavailable, pipeline continues
    }
  }
}

const SESSION_DEFAULTS: Required<Omit<SessionOptions, 'maxTrackedSessions'>> = {
  windowMs: 30 * 60 * 1000,
  maxMessages: 10
}

export class PersistentSessionPort implements SessionPort {
  private readonly opts: Required<Omit<SessionOptions, 'maxTrackedSessions'>>
  constructor(private readonly backend: SessionBackend, options: SessionOptions = {}) {
    this.opts = { ...SESSION_DEFAULTS, ...options }
  }

  async append(chatId: number, userId: number, text: string): Promise<SessionWindow> {
    try {
      const texts = await this.backend.appendSession(`${chatId}:${userId}`, text, this.opts.maxMessages, this.opts.windowMs)
      return { combinedText: texts.join('\n'), count: texts.length }
    } catch {
      return { combinedText: text, count: text ? 1 : 0 }
    }
  }

  async reset(chatId: number, userId: number): Promise<void> {
    await this.backend.resetSession(`${chatId}:${userId}`).catch(() => { /* best-effort */ })
  }
}
