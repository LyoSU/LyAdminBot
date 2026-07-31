import { describe, expect, it } from 'vitest'
import type { SignalName } from '@lyadmin/core'
import { formatLogLine, formatSignals } from './logger.js'

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

describe('formatSignals', () => {
  it('puts the heaviest driver first, with its weight', () => {
    const out = formatSignals([
      { name: 'new_globally' }, { name: 'sleeper_awakened' }, { name: 'edited_message' }
    ])
    expect(out).toBe('sleeper_awakened=1.2 new_globally=0.8 edited_message=0.2')
  })

  it('keeps trust signals visible — they explain a LOW score too', () => {
    expect(formatSignals([{ name: 'short_message' }])).toBe('short_message=-0.8')
  })

  it('deduplicates and survives unknown names', () => {
    expect(formatSignals([{ name: 'made_up' as SignalName }, { name: 'made_up' as SignalName }])).toBe('made_up')
  })

  it('is undefined for an empty list, so the field drops out of the line', () => {
    expect(formatSignals([])).toBeUndefined()
  })

  it('truncates a runaway list but says how many it hid', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `sig_${i}` as SignalName }))
    expect(formatSignals([{ name: 'scam_flag' }, ...many])).toMatch(/^scam_flag=3 .* \+9$/)
  })
})
