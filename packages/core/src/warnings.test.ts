import { describe, expect, it } from 'vitest'
import { DEFAULT_WARN_SETTINGS, normalizeWarnSettings, warnOutcome } from './warnings.js'

describe('warnings', () => {
  it('reaches the limit exactly at the limit', () => {
    const s = { limit: 3, action: 'mute' as const }
    expect(warnOutcome(2, s)).toBe('warned')
    expect(warnOutcome(3, s)).toBe('limit')
    expect(warnOutcome(4, s)).toBe('limit')
  })

  it('stored settings outside what the panel offers read as the defaults', () => {
    expect(normalizeWarnSettings(null)).toEqual(DEFAULT_WARN_SETTINGS)
    expect(normalizeWarnSettings({ limit: 7, action: 'nuke' })).toEqual(DEFAULT_WARN_SETTINGS)
    expect(normalizeWarnSettings({ limit: 5, action: 'ban' })).toEqual({ limit: 5, action: 'ban' })
  })
})
