/**
 * Verdict executor. Translates a core Verdict into Telegram moderation
 * calls behind a narrow ModerationActions interface (implemented over
 * mtcute in gateway.ts, faked in tests and replay).
 *
 * Safety invariants enforced HERE, regardless of what the pipeline said:
 * never act on admins, never act on the bot itself, never act on
 * chat-trusted users. The pipeline also guards these — defense in depth.
 */
import type { Verdict } from '@lyadmin/core'
import { OVERRIDES_CHAT_TRUST_SIGNALS } from '@lyadmin/core'

export interface ExecutionTarget {
  chatId: number
  userId: number
  messageId: number
}

export interface ExecutionGuards {
  senderIsAdmin: boolean
  senderIsSelf: boolean
  senderIsTrusted: boolean
}

export interface ModerationActions {
  deleteMessage(chatId: number, messageId: number): Promise<void>
  /** Restrict sending for the given duration. */
  mute(chatId: number, userId: number, untilSeconds: number): Promise<void>
  /** Remove from the chat without blocking a rejoin (ban immediately undone). */
  kick(chatId: number, userId: number): Promise<void>
  /** Ban for `untilSeconds`, or permanently when null. */
  ban(chatId: number, userId: number, untilSeconds: number | null): Promise<void>
}

export interface ExecutionResult {
  /**
   * Whether the action NAMED BY THE VERDICT took hold. For `ban`/`kick`/`mute`
   * that is the thing done to the sender; the message deletion those actions
   * also perform is reported separately, in `deleted`.
   *
   * The distinction is not pedantry. `applied: false` on a ban means "the
   * message went, the person stayed" — most often because the bot lacks the
   * right to ban in that chat — and reading it as "nothing happened" gets the
   * blast radius of a false positive exactly backwards. A verdict recorded with
   * this field alone cannot be told apart from one where nothing was attempted.
   */
  applied: boolean
  /**
   * Whether the message itself was removed, or null when the action never
   * involved removing one (`captcha`, or a skip before anything was attempted).
   *
   * Added 2026-08-24. Until then the delete's outcome was discarded on three of
   * the four enforcement paths — `await attempt('delete', ...)` with no
   * assignment — so nothing downstream and nothing in the record knew whether
   * the spam was still in the chat.
   */
  deleted: boolean | null
  skippedReason: string | null
  /** App layer must post a captcha prompt when set. */
  captchaRequired: boolean
  errors: string[]
}

/**
 * Condemned by someone other than us — the only grounds on which a chat-trusted
 * member is still actioned — at either tier of authority, unlike the permanent-ban
 * grounds, which only Telegram's own verdict earns. The list lives in the signal
 * catalogue; this file used to keep a private copy of the same four
 * names under a different name, in a different package, linked to the original
 * by nothing at all.
 */
const hasHardAccountVerdict = (verdict: Verdict): boolean =>
  verdict.signals.some((s) => OVERRIDES_CHAT_TRUST_SIGNALS.has(s.name))

const MUTE_DURATION_SECONDS = 24 * 60 * 60
const CAPTCHA_WINDOW_SECONDS = 10 * 60
/** FLOOD_WAITs up to this long are absorbed; longer ones propagate. */
const FLOOD_WAIT_RETRY_MAX_SECONDS = 60

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const floodWaitSeconds = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null
  const text = (err as { text?: string; errorMessage?: string }).text
    ?? (err as { errorMessage?: string }).errorMessage ?? ''
  if (!text.startsWith('FLOOD_WAIT')) return null
  const fromField = (err as { seconds?: number }).seconds
  if (typeof fromField === 'number') return fromField
  const parsed = Number(text.split('_').pop())
  return Number.isFinite(parsed) ? parsed : 0
}

/** Retry once after a short FLOOD_WAIT; never block the queue on long ones. */
export const withFloodWait = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call()
  } catch (err) {
    const seconds = floodWaitSeconds(err)
    if (seconds === null || seconds > FLOOD_WAIT_RETRY_MAX_SECONDS) throw err
    await sleep(seconds * 1000)
    return await call()
  }
}

export const applyVerdict = async (
  verdict: Verdict,
  target: ExecutionTarget,
  guards: ExecutionGuards,
  actions: ModerationActions
): Promise<ExecutionResult> => {
  const result: ExecutionResult = {
    applied: false, deleted: null, skippedReason: null, captchaRequired: false, errors: []
  }

  if (verdict.action === 'none' || verdict.action === 'observe') return result

  // Checked explicitly rather than by iterating Object.entries(guards): with
  // the loop, any non-boolean field later added to ExecutionGuards would have
  // silently become a truthy guard that blocks all moderation.
  if (guards.senderIsAdmin) { result.skippedReason = 'senderIsAdmin'; return result }
  if (guards.senderIsSelf) { result.skippedReason = 'senderIsSelf'; return result }
  // Trust is a shield against OUR judgement, not against someone else's
  // verdict. It is granted by a single tap — an admin ham ballot or the
  // override button — and never expires, so treating it as absolute meant one
  // misclick bought an account permanent immunity in that chat, including
  // against a Telegram scam flag or an external ban listing. That is exactly
  // the sold/compromised long-time account from the threat model
  // (2026-07-30 review).
  if (guards.senderIsTrusted && !hasHardAccountVerdict(verdict)) {
    result.skippedReason = 'senderIsTrusted'
    return result
  }

  const attempt = async (label: string, call: () => Promise<void>): Promise<boolean> => {
    try {
      await withFloodWait(call)
      return true
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  switch (verdict.action) {
    case 'captcha': {
      const ok = await attempt('mute', () =>
        actions.mute(target.chatId, target.userId, CAPTCHA_WINDOW_SECONDS))
      result.applied = ok
      // Only a gate that actually closed is worth prompting about: a prompt
      // over a failed restriction asks the user to unlock a door that is open.
      result.captchaRequired = ok
      return result
    }
    case 'delete': {
      result.deleted = await attempt('delete', () =>
        actions.deleteMessage(target.chatId, target.messageId))
      result.applied = result.deleted
      // An uncertain verdict (see `requireCaptcha`): the message goes, and the
      // sender is gated rather than removed. The gate is only claimed if the
      // restriction actually took — otherwise the app layer would post a prompt
      // for a user who was never restricted and has nothing to prove.
      if (verdict.requireCaptcha === true) {
        result.captchaRequired = await attempt('captcha_mute', () =>
          actions.mute(target.chatId, target.userId, CAPTCHA_WINDOW_SECONDS))
      }
      return result
    }
    case 'kick': {
      result.deleted = await attempt('delete', () => actions.deleteMessage(target.chatId, target.messageId))
      result.applied = await attempt('kick', () => actions.kick(target.chatId, target.userId))
      return result
    }
    case 'mute': {
      result.deleted = await attempt('delete', () => actions.deleteMessage(target.chatId, target.messageId))
      result.applied = await attempt('mute', () =>
        actions.mute(target.chatId, target.userId, MUTE_DURATION_SECONDS))
      return result
    }
    case 'ban': {
      result.deleted = await attempt('delete', () => actions.deleteMessage(target.chatId, target.messageId))
      result.applied = await attempt('ban', () =>
        actions.ban(target.chatId, target.userId, verdict.banDurationSeconds))
      return result
    }
  }
}
