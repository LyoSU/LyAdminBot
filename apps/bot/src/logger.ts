/**
 * Tiny zero-dependency structured logger. One JSON object per line on
 * stdout/stderr — exactly what Coolify (and any log shipper) ingests. Keeps
 * packages pure: only the composition root logs. Every moderation action,
 * vote, override, banan, captcha pass and error gets a line so prod activity
 * is fully auditable from the container logs.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

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

const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
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
