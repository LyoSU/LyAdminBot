/**
 * Warnings: the step between "your message was removed" and "you are out".
 *
 * An admin (`/warn`, the /mod panel) or a chat filter set to `warn` gives one;
 * at the chat's limit the member gets the chat's action and the count starts
 * over. Each warning expires on its own after `WARNING_TTL_DAYS`, so a member
 * who slipped twice last spring does not start this one on their last chance.
 *
 * Pure: the store keeps the warnings, the app layer applies the outcome.
 */

export type WarnLimitAction = 'mute' | 'kick' | 'ban'
export const WARN_LIMIT_ACTIONS: readonly WarnLimitAction[] = ['mute', 'kick', 'ban']

/** Limits the panel offers. Three is the convention every group bot keeps. */
export const WARN_LIMITS: readonly number[] = [2, 3, 5]

export interface WarnSettings {
  limit: number
  action: WarnLimitAction
}

export const DEFAULT_WARN_SETTINGS: WarnSettings = { limit: 3, action: 'mute' }

/** A warning lapses after a month. Fixed: one fewer knob, and stated on the panel. */
export const WARNING_TTL_DAYS = 30

/** Term of the limit's mute and ban. The ban is timed like every ban we decide. */
export const WARN_MUTE_SECONDS = 24 * 60 * 60
export const WARN_BAN_SECONDS = 30 * 24 * 60 * 60

export const normalizeWarnSettings = (raw: unknown): WarnSettings => {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_WARN_SETTINGS }
  const r = raw as Record<string, unknown>
  const limit = typeof r['limit'] === 'number' && WARN_LIMITS.includes(r['limit'])
    ? r['limit']
    : DEFAULT_WARN_SETTINGS.limit
  const action = typeof r['action'] === 'string' && (WARN_LIMIT_ACTIONS as readonly string[]).includes(r['action'])
    ? r['action'] as WarnLimitAction
    : DEFAULT_WARN_SETTINGS.action
  return { limit, action }
}

/**
 * What a warning leads to, given how many live warnings the member holds once
 * it is counted. `limit` when this one reaches the chat's limit — the caller
 * applies `settings.action` and clears the count.
 */
export const warnOutcome = (activeAfter: number, settings: WarnSettings): 'warned' | 'limit' =>
  activeAfter >= settings.limit ? 'limit' : 'warned'

/** Longest reason kept with a warning. It is shown back to the chat. */
export const WARN_REASON_MAX = 200
