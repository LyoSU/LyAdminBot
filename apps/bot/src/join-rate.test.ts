import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  JOIN_SCREEN_BUDGET,
  JOIN_SURGE_ALERT_RISK_MIN,
  JOIN_SURGE_MIN,
  JOIN_SURGE_QUIET_MS,
  JOIN_WINDOW_MS,
  JoinRateTracker
} from './join-rate.js'

const at = (t: { ms: number }, maxChats = 500): JoinRateTracker =>
  new JoinRateTracker(() => t.ms, { maxChats })

describe('JoinRateTracker', () => {
  it('starts a surge once the sliding-window threshold is reached', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)

    expect(tracker.note(-100, JOIN_SURGE_MIN - 1)).toEqual({
      surging: false,
      started: false,
      total: JOIN_SURGE_MIN - 1
    })
    expect(tracker.note(-100, 1)).toEqual({
      surging: true,
      started: true,
      total: JOIN_SURGE_MIN
    })
    expect(tracker.note(-100, 1)).toEqual({
      surging: true,
      started: false,
      total: JOIN_SURGE_MIN + 1
    })
  })

  it('ends a surge only after the configured quiet period', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    tracker.note(-200, JOIN_SURGE_MIN)

    t.ms += JOIN_SURGE_QUIET_MS - 1
    expect(tracker.note(-200, 1).surging).toBe(true)
    t.ms += JOIN_SURGE_QUIET_MS + 1
    expect(tracker.note(-200, 1)).toEqual({ surging: false, started: false, total: 1 })
  })

  it('uses the injected clock for the sliding window', () => {
    const t = { ms: 5_000 }
    const tracker = at(t)
    tracker.note(-300, JOIN_SURGE_MIN - 1)
    t.ms += JOIN_WINDOW_MS + 1
    expect(tracker.note(-300, 1)).toEqual({ surging: false, started: false, total: 1 })
  })

  it('keeps chat state bounded and evicts the least recently touched chat', () => {
    const t = { ms: 1_000 }
    const tracker = at(t, 2)
    tracker.note(-1, 1)
    t.ms += 1
    tracker.note(-2, 1)
    t.ms += 1
    tracker.note(-3, 1)

    expect(tracker.trackedChatCount()).toBe(2)
    expect(tracker.note(-1, 1).total).toBe(1)
  })

  it('stops greeting once twenty single-member joins are recognised as a surge', () => {
    // Production 2026-08-02: twenty members arrived in seventeen seconds and the
    // bot answered with twenty greetings, doubling the load on the chat it was
    // supposed to be protecting. Greetings cannot go to zero — a surge is only
    // knowable in arrears — but they must stop scaling with the influx.
    const t = { ms: 1_000 }
    const tracker = at(t)
    let greetings = 0

    for (let i = 0; i < 20; i += 1) {
      tracker.note(-400, 1, [i + 1])
      if (tracker.claimWelcome(-400)) greetings += 1
      t.ms += 800
    }

    expect(greetings).toBeLessThanOrEqual(JOIN_SURGE_MIN)
    expect(greetings, 'the tail of the burst must be silent').toBeLessThan(20)
  })

  it('REGRESSION: an ordinary trickle is greeted in full, forever', () => {
    // The throttle is for amplification, not for rationing. Gating on the join
    // episode instead of on the surge silently turned welcome off: an episode is
    // any run of joins spaced under the window, so a chat receiving one member
    // every fifty seconds greeted the first and then nobody, for as long as the
    // trickle lasted, while never once surging.
    const t = { ms: 1_000 }
    const tracker = at(t)
    let greetings = 0
    let everSurged = false

    for (let i = 0; i < 72; i += 1) {
      everSurged = tracker.note(-401, 1, [i + 1]).surging || everSurged
      if (tracker.claimWelcome(-401)) greetings += 1
      t.ms += 50_000
    }

    expect({ greetings, everSurged }).toEqual({ greetings: 72, everSurged: false })
  })

  it('two members arriving a window apart are both greeted', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    tracker.note(-402, 1, [1])
    expect(tracker.claimWelcome(-402)).toBe(true)
    t.ms += 40_000
    tracker.note(-402, 1, [2])
    expect(tracker.claimWelcome(-402)).toBe(true)
  })

  it('shares one avatar-screening budget across separate join packets', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    let screened = 0

    for (let i = 0; i < 20; i += 1) {
      tracker.note(-500, 1, [i + 1])
      screened += tracker.claimScreening(-500, 1)
      t.ms += 500
    }

    expect(screened).toBe(JOIN_SCREEN_BUDGET)
  })

  it('marks every member in the triggering window as having joined during the surge', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    tracker.note(-600, JOIN_SURGE_MIN - 1, [1, 2, 3, 4, 5, 6, 7])
    tracker.note(-600, 1, [8])

    expect(tracker.joinedDuringSurge(-600, 1)).toBe(true)
    expect(tracker.joinedDuringSurge(-600, 8)).toBe(true)
    expect(tracker.joinedDuringSurge(-600, 9)).toBe(false)
  })

  it('lets the member marker decay even when no later join arrives', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    tracker.note(-625, JOIN_SURGE_MIN, [1, 2, 3, 4, 5, 6, 7, 8])
    t.ms += JOIN_SURGE_QUIET_MS + 1
    expect(tracker.joinedDuringSurge(-625, 1)).toBe(false)
  })

  it('raises one alert only after enough distinct risky joiners are present', () => {
    const t = { ms: 1_000 }
    const tracker = at(t)
    tracker.note(-650, JOIN_SURGE_MIN)

    for (let i = 1; i < JOIN_SURGE_ALERT_RISK_MIN; i += 1) {
      tracker.noteRisk(-650, i)
      expect(tracker.takeSurgeAlert(-650)).toBeNull()
    }
    tracker.noteRisk(-650, JOIN_SURGE_ALERT_RISK_MIN)
    expect(tracker.takeSurgeAlert(-650)).toEqual({
      riskCount: JOIN_SURGE_ALERT_RISK_MIN,
      total: JOIN_SURGE_MIN
    })
    expect(tracker.takeSurgeAlert(-650)).toBeNull()
  })

  it('never reports a surge for isolated single joins', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: JOIN_WINDOW_MS + 1, max: JOIN_WINDOW_MS * 4 }), {
        minLength: 1,
        maxLength: 100
      }),
      (gaps) => {
        const t = { ms: 0 }
        const tracker = at(t)
        for (const gap of gaps) {
          t.ms += gap
          expect(tracker.note(-700, 1).surging).toBe(false)
        }
      }
    ))
  })
})
