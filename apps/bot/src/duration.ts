/**
 * /banan duration parsing and humanizing — v1 semantics: `5m`, `2h`, `3d`,
 * a bare number means minutes, anything else falls back to the chat default.
 */
const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400 }
const MIN_SECONDS = 60
const MAX_SECONDS = 364 * 86400

export interface ParsedDuration {
  seconds: number
  /** true when the caller typed the duration literally. */
  explicit: boolean
}

export const parseBananDuration = (arg: string | undefined, fallbackSeconds = 600): ParsedDuration => {
  const match = /^(\d+)([mhd]?)$/.exec((arg ?? '').trim())
  if (!match) return { seconds: clamp(fallbackSeconds), explicit: false }
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return { seconds: clamp(fallbackSeconds), explicit: false }
  const unit = UNIT_SECONDS[match[2] || 'm'] ?? 60
  return { seconds: clamp(amount * unit), explicit: true }
}

const clamp = (seconds: number): number =>
  Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, seconds))

/** "5 хв" / "2 год" / "3 дн" — the largest unit the value fits in. */
export const formatDuration = (seconds: number, units: { m: string; h: string; d: string }): string => {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} ${units.d}`
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} ${units.h}`
  return `${Math.round(seconds / 60)} ${units.m}`
}
