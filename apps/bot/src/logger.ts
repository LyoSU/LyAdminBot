/**
 * Tiny zero-dependency structured logger. One JSON object per line on
 * stdout/stderr — exactly what Coolify (and any log shipper) ingests. Keeps
 * packages pure: only the composition root logs. Every moderation action,
 * vote, override, banan, captcha pass and error gets a line so prod activity
 * is fully auditable from the container logs.
 */
import { weightOf, type Signal } from '@lyadmin/core'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

/** Beyond this the line stops being readable; the drivers are always first. */
const MAX_LOGGED_SIGNALS = 12

/**
 * Signals as one greppable field: `sleeper_awakened=1.2 promo_in_bio=1.2 …`,
 * heaviest first, weightless names bare.
 *
 * Why the weights are in the log: without them a line records WHICH signals
 * fired but not what they did to the score, so a false positive cannot be
 * reproduced from logs — exactly the wall hit when diagnosing the 2026-07-30
 * kick, where `reason` named only the top contributor and the production
 * database was the sole record of the rest.
 */
export const formatSignals = (signals: Signal[]): string | undefined => {
  const seen = new Map<string, number>()
  for (const { name } of signals) {
    if (!seen.has(name)) seen.set(name, weightOf(name))
  }
  if (seen.size === 0) return undefined

  const ranked = [...seen].sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
  const shown = ranked.slice(0, MAX_LOGGED_SIGNALS)
    .map(([name, weight]) => (weight === 0 ? name : `${name}=${weight}`))
  const hidden = ranked.length - shown.length
  return hidden > 0 ? `${shown.join(' ')} +${hidden}` : shown.join(' ')
}

/** Pure formatter (testable): merges ts/level/event with caller fields. */
export const formatLogLine = (
  level: LogLevel,
  event: string,
  fields: LogFields | undefined,
  now: Date
): string => {
  const out: Record<string, unknown> = { ts: now.toISOString(), level, event }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      out[key] = value instanceof Error ? value.message : value
    }
  }
  return JSON.stringify(out)
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Minimum level to emit. Defaults to 'info' so the chatty per-message
 * `observe` debug lines stay out of prod; set LOG_LEVEL=debug to see them.
 */
const minLevel = (): number => {
  const env = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase()
  return LEVEL_ORDER[env as LogLevel] ?? LEVEL_ORDER.info
}

const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
  if (LEVEL_ORDER[level] < minLevel()) return
  const line = formatLogLine(level, event, fields, new Date())
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  debug: (event: string, fields?: LogFields): void => emit('debug', event, fields),
  info: (event: string, fields?: LogFields): void => emit('info', event, fields),
  warn: (event: string, fields?: LogFields): void => emit('warn', event, fields),
  error: (event: string, fields?: LogFields): void => emit('error', event, fields)
}
