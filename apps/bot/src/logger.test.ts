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

describe('formatSignals — evidence', () => {
  it('REGRESSION: a heavy signal says what it saw', () => {
    // `mixed_script_word` was given an evidence string on 2026-08-03 so a
    // production line could be judged FP or TP, and the line did not change:
    // this formatter dropped evidence entirely.
    const out = formatSignals([
      { name: 'mixed_script_word', evidence: '«Зaрaбoтoк»' },
      { name: 'new_globally' }
    ])
    expect(out).toBe('mixed_script_word=1.5(«Зaрaбoтoк») new_globally=0.8')
  })

  it('a sub-threshold nudge stays bare however much it has to say', () => {
    // The bar is the same one the pipeline uses to call a signal decisive: what
    // can convict alone must explain itself; a nudge has nothing to answer for.
    const out = formatSignals([{ name: 'edited_message', evidence: 'text changed' }])
    expect(out).toBe('edited_message=0.2')
  })

  it('never breaks the one-object-per-line contract, whatever the text', () => {
    const out = formatSignals([
      { name: 'hidden_url', evidence: `a\nb\tc   d${'x'.repeat(300)}` }
    ])
    expect(out).not.toContain('\n')
    expect(out).not.toContain('\t')
    expect(out?.length).toBeLessThan(80)
  })

  it('spends its evidence budget on the heaviest signals and no further', () => {
    const withEvidence = (name: string) => ({ name: name as never, evidence: `saw ${name}` })
    const out = formatSignals([
      withEvidence('hidden_url'),          // 2.0
      withEvidence('private_invite_link'), // 1.8
      withEvidence('mixed_script_word'),   // 1.5
      withEvidence('phone_number')         // 1.2 — over budget
    ])
    expect(out).toContain('hidden_url=2(saw hidden_url)')
    expect(out).toContain('mixed_script_word=1.5(saw mixed_script_word)')
    expect(out).toContain('phone_number=1.2')
    expect(out).not.toContain('saw phone_number')
  })

  it('an empty evidence string adds nothing but empty parentheses', () => {
    expect(formatSignals([{ name: 'hidden_url', evidence: '   ' }])).toBe('hidden_url=2')
  })
})
