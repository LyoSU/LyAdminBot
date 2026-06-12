import { describe, expect, it } from 'vitest'
import { formatLogLine } from './logger.js'

describe('formatLogLine', () => {
  it('emits a single-line JSON object with ts, level and event', () => {
    const line = formatLogLine('info', 'moderation', { chatId: -100, action: 'ban' }, new Date('2026-06-12T10:00:00.000Z'))
    expect(line).not.toContain('\n')
    const parsed = JSON.parse(line)
    expect(parsed).toMatchObject({
      ts: '2026-06-12T10:00:00.000Z',
      level: 'info',
      event: 'moderation',
      chatId: -100,
      action: 'ban'
    })
  })

  it('drops undefined fields so log lines stay clean', () => {
    const parsed = JSON.parse(formatLogLine('warn', 'x', { a: 1, b: undefined }, new Date()))
    expect(parsed).toHaveProperty('a', 1)
    expect(parsed).not.toHaveProperty('b')
  })

  it('serializes Error fields as message strings, not empty objects', () => {
    const parsed = JSON.parse(formatLogLine('error', 'boom', { err: new Error('nope') }, new Date()))
    expect(parsed.err).toBe('nope')
  })

  it('works with no fields', () => {
    const parsed = JSON.parse(formatLogLine('info', 'started', undefined, new Date('2026-06-12T00:00:00.000Z')))
    expect(parsed.event).toBe('started')
    expect(parsed.ts).toBe('2026-06-12T00:00:00.000Z')
  })
})
