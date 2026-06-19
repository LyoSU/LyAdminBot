import { describe, expect, it } from 'vitest'
import { countRecentChanges, groupDocToChatPolicy, presetToThreshold, thresholdToPreset, userDocToHistory } from './mappers.js'

describe('thresholdToPreset', () => {
  it('maps the v1 confidence slider to presets', () => {
    expect(thresholdToPreset(undefined)).toBe('standard')
    expect(thresholdToPreset(50)).toBe('strict')
    expect(thresholdToPreset(65)).toBe('strict')
    expect(thresholdToPreset(70)).toBe('standard')
    expect(thresholdToPreset(78)).toBe('standard')
    expect(thresholdToPreset(85)).toBe('soft')
    expect(thresholdToPreset(95)).toBe('soft')
  })
})

describe('presetToThreshold', () => {
  it('writes back v1 slider values that round-trip to the same preset', () => {
    for (const preset of ['soft', 'standard', 'strict'] as const) {
      expect(thresholdToPreset(presetToThreshold(preset))).toBe(preset)
    }
  })
})

describe('groupDocToChatPolicy', () => {
  it('maps a real-shaped group document', () => {
    const policy = groupDocToChatPolicy({
      group_id: -100,
      settings: {
        openaiSpamCheck: {
          enabled: true, confidenceThreshold: 60,
          customRules: ['DENY: казино'], trustedUsers: [42]
        }
      }
    })
    expect(policy.enabled).toBe(true)
    expect(policy.preset).toBe('strict')
    expect(policy.customRules).toEqual(['DENY: казино'])
    expect(policy.trustedUserIds).toEqual([42])
    expect(policy.reactionModeration).toBe(false)
  })

  it('defaults sanely for a missing document', () => {
    const policy = groupDocToChatPolicy(null)
    expect(policy.enabled).toBe(true)
    expect(policy.preset).toBe('standard')
    expect(policy.votingEnabled).toBe(true)
    expect(policy.captchaEnabled).toBe(false)
  })

  it('external ban databases are on by default (v1 banDatabase parity)', () => {
    expect(groupDocToChatPolicy(null).externalBanEnabled).toBe(true)
    expect(groupDocToChatPolicy({ group_id: -1, settings: {} }).externalBanEnabled).toBe(true)
  })

  it('respects a group that turned external ban databases off', () => {
    const policy = groupDocToChatPolicy({ group_id: -1, settings: { banDatabase: false } })
    expect(policy.externalBanEnabled).toBe(false)
  })

  it('reaction moderation is off by default but reachable when a group enables it', () => {
    expect(groupDocToChatPolicy(null).reactionModeration).toBe(false)
    expect(groupDocToChatPolicy({ group_id: -1, settings: { reactionModeration: true } }).reactionModeration).toBe(true)
  })
})

describe('countRecentChanges (v1 semantics)', () => {
  const NOW = 1_781_000_000_000

  it('a single seeded entry is baseline, not churn', () => {
    expect(countRecentChanges([{ seenAt: new Date(NOW - 1000) }], NOW)).toBe(0)
  })

  it('counts entries within 24h when history has >= 2 entries', () => {
    const history = [
      { seenAt: new Date(NOW - 1000) },
      { seenAt: new Date(NOW - 2 * 60 * 60 * 1000) },
      { seenAt: new Date(NOW - 30 * 60 * 60 * 1000) } // outside window
    ]
    expect(countRecentChanges(history, NOW)).toBe(2)
  })

  it('handles garbage gracefully', () => {
    expect(countRecentChanges(undefined, NOW)).toBe(0)
    expect(countRecentChanges([], NOW)).toBe(0)
    expect(countRecentChanges([{}, {}], NOW)).toBe(0)
  })
})

describe('userDocToHistory', () => {
  const NOW = 1_781_000_000_000

  it('maps a real-shaped user document', () => {
    const history = userDocToHistory({
      telegram_id: 42,
      globalStats: { totalMessages: 300, groupsActive: 3, firstSeen: new Date(NOW - 100 * 86400 * 1000), spamDetections: 1 },
      reputation: { score: 70, status: 'neutral' },
      externalBan: { lols: { banned: true, spamFactor: 0.9 } }
    }, 25, NOW)!
    expect(history.messagesGlobal).toBe(300)
    expect(history.messagesInChat).toBe(25)
    expect(history.externalBan).toEqual({ banned: true, spamFactor: 0.9 })
    expect(Math.round((NOW / 1000 - history.firstSeenUnix!) / 86400)).toBe(100)
  })

  it('cas-only ban maps to banned with zero spam factor', () => {
    const history = userDocToHistory({ telegram_id: 1, externalBan: { cas: { banned: true } } }, 0, NOW)!
    expect(history.externalBan).toEqual({ banned: true, spamFactor: 0 })
  })

  it('a flagged scammer maps to a maximal spam factor', () => {
    const history = userDocToHistory(
      { telegram_id: 1, externalBan: { lols: { banned: false, spamFactor: 0.1, scammer: true } } },
      0, NOW
    )!
    expect(history.externalBan).toEqual({ banned: false, spamFactor: 1 })
  })

  it('null doc → null history', () => {
    expect(userDocToHistory(null, 0, NOW)).toBeNull()
  })
})
