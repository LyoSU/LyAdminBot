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
  ban(chatId: number, userId: number): Promise<void>
}

export interface ExecutionResult {
  applied: boolean
  skippedReason: string | null
  /** App layer must post a captcha prompt when set. */
  captchaRequired: boolean
  errors: string[]
}

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
    applied: false, skippedReason: null, captchaRequired: false, errors: []
  }

  if (verdict.action === 'none' || verdict.action === 'observe') return result

  for (const [guard, active] of Object.entries(guards)) {
    if (active) {
      result.skippedReason = guard
      return result
    }
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
      result.captchaRequired = true
      return result
    }
    case 'delete': {
      result.applied = await attempt('delete', () =>
        actions.deleteMessage(target.chatId, target.messageId))
      return result
    }
    case 'mute': {
      await attempt('delete', () => actions.deleteMessage(target.chatId, target.messageId))
      result.applied = await attempt('mute', () =>
        actions.mute(target.chatId, target.userId, MUTE_DURATION_SECONDS))
      return result
    }
    case 'ban': {
      await attempt('delete', () => actions.deleteMessage(target.chatId, target.messageId))
      result.applied = await attempt('ban', () => actions.ban(target.chatId, target.userId))
      return result
    }
  }
}
