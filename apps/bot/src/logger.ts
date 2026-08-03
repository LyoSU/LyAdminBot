/**
 * Tiny zero-dependency structured logger. One JSON object per line on
 * stdout/stderr — exactly what Coolify (and any log shipper) ingests. Keeps
 * packages pure: only the composition root logs. Every moderation action,
 * vote, override, banan, captcha pass and error gets a line so prod activity
 * is fully auditable from the container logs.
 */
import { DECISIVE_MIN_WEIGHT, weightOf, type Signal } from '@lyadmin/core'

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
/**
 * How many of the heaviest signals get to say what they saw, and how much of it.
 *
 * Not all of them: most lines carry a dozen signals, and evidence for every one
 * would bury the fields around it. Not one, either — the top signal is often the
 * self-explanatory one (an account listed in a ban feed) while the signal that
 * actually decided the case sits below it.
 *
 * 2026-08-03: `mixed_script_word` was given an evidence string precisely so a
 * production line could be judged, and the line did not change at all, because
 * this function had never passed evidence through. A fix that cannot be observed
 * is not a fix.
 */
const MAX_LOGGED_EVIDENCE = 3
const MAX_EVIDENCE_CHARS = 48

/**
 * Signals as one greppable field: `sleeper_awakened=1.2 promo_in_bio=1.2 …`,
 * heaviest first, weightless names bare, and the heavy ones carrying what they
 * saw: `mixed_script_word=1.5(«…»)`.
 *
 * Evidence is shown only at or above `DECISIVE_MIN_WEIGHT`, which is the same
 * bar the pipeline uses to decide a signal is heavy enough to act on: a signal
 * that can convict on its own has to be able to say why, and a nudge does not
 * need to.
 */
export const formatSignals = (signals: Signal[]): string | undefined => {
  const seen = new Map<string, { weight: number; evidence?: string }>()
  for (const { name, evidence } of signals) {
    if (seen.has(name)) continue
    const weight = weightOf(name)
    seen.set(name, evidence !== undefined && evidence !== null && Math.abs(weight) >= DECISIVE_MIN_WEIGHT
      ? { weight, evidence }
      : { weight })
  }
  if (seen.size === 0) return undefined

  const ranked = [...seen].sort(([, a], [, b]) => Math.abs(b.weight) - Math.abs(a.weight))
  let evidenceBudget = MAX_LOGGED_EVIDENCE
  const shown = ranked.slice(0, MAX_LOGGED_SIGNALS).map(([name, { weight, evidence }]) => {
    const head = weight === 0 ? name : `${name}=${weight}`
    if (evidence === undefined || evidenceBudget === 0) return head
    evidenceBudget -= 1
    // Newlines would break the one-object-per-line contract this logger exists
    // to keep, and evidence strings are built from user text.
    const clean = evidence.replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE_CHARS)
    return clean === '' ? head : `${head}(${clean})`
  })
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
