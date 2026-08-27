import { describe, expect, it } from 'vitest'
import { CaptchaGates } from './captcha-gate.js'

const TTL = 60_000

/** A clock the test moves by hand; every rule here is about time or order. */
const clock = (start = 1_000): { ms: number; now: () => number } => {
  const c = { ms: start, now: () => c.ms }
  return c
}

describe('CaptchaGates — a caller may only act on the gate it is holding', () => {
  it('drops the gate it was given', () => {
    const gates = new CaptchaGates()
    const gate = gates.issue(-100, 7, TTL)

    expect(gates.forget(gate)).toBe(true)
    expect(gates.peek(-100, 7)).toBeNull()
  })

  /**
   * Production shape (2026-08-27 review): gate A's whisper is still in flight
   * when a report or a join screen opens gate B for the same person. A's send
   * then fails, and its `abandonUndeliverable` used to call `forget(key)` —
   * which lifted B's restriction and stopped B's timers, leaving the member
   * restricted by a gate the bot had forgotten.
   */
  it('a superseded gate cannot drop the one that replaced it', () => {
    const gates = new CaptchaGates()
    const first = gates.issue(-100, 7, TTL)
    const second = gates.issue(-100, 7, TTL)

    expect(gates.forget(first)).toBe(false)
    expect(gates.peek(-100, 7)).toBe(second)
  })

  it('a superseded gate knows it is no longer in force', () => {
    const gates = new CaptchaGates()
    const first = gates.issue(-100, 7, TTL)
    gates.issue(-100, 7, TTL)

    expect(gates.isCurrent(first)).toBe(false)
  })

  it('an expired gate is not in force either', () => {
    const c = clock()
    const gates = new CaptchaGates(c.now)
    const gate = gates.issue(-100, 7, TTL)

    c.ms += TTL + 1
    expect(gates.isCurrent(gate)).toBe(false)
    expect(gates.peek(-100, 7)).toBeNull()
  })

  it('replacing a gate stops the timers of the one it replaced', () => {
    const gates = new CaptchaGates()
    const first = gates.issue(-100, 7, TTL)
    let stopped = 0
    first.cancels.push(() => { stopped += 1 })

    gates.issue(-100, 7, TTL)
    expect(stopped).toBe(1)
  })

  it('forgetting a gate stops its timers', () => {
    const gates = new CaptchaGates()
    const gate = gates.issue(-100, 7, TTL)
    let stopped = 0
    gate.cancels.push(() => { stopped += 1 })

    gates.forget(gate)
    expect(stopped).toBe(1)
  })

  it('keeps chats and people apart', () => {
    const gates = new CaptchaGates()
    const here = gates.issue(-100, 7, TTL)
    const elsewhere = gates.issue(-200, 7, TTL)

    expect(gates.isCurrent(here)).toBe(true)
    expect(gates.peek(-200, 7)).toBe(elsewhere)
  })
})

describe('CaptchaGates — the unanswered-gate consequence', () => {
  it('is claimable exactly once', () => {
    const gates = new CaptchaGates()
    const gate = gates.issue(-100, 7, TTL)

    expect(gates.claimConsequence(gate)).toBe(true)
    expect(gates.claimConsequence(gate)).toBe(false)
  })

  /**
   * The race that made a member who PASSED lose their message anyway: the tap
   * lands at 119.9s, the deadline fires at 120s, and `clearTimeout` cannot
   * recall a callback that has already started. The tap has to close the door
   * itself, not rely on the timer being cancelled in time.
   */
  it('is refused once a tap has proven liveness', () => {
    const gates = new CaptchaGates()
    const gate = gates.issue(-100, 7, TTL)

    gates.markAnswered(gate)
    expect(gates.claimConsequence(gate)).toBe(false)
  })

  /**
   * A tap whose unrestrict FAILED still proves a person is there. The gate
   * stays open — another tap is the only thing they can do, and it is worth
   * something — but silence is no longer an available reading.
   */
  it('stays refused for a gate that was answered but not lifted', () => {
    const gates = new CaptchaGates()
    const gate = gates.issue(-100, 7, TTL)

    gates.markAnswered(gate)
    expect(gates.peek(-100, 7)).toBe(gate)
    expect(gates.claimConsequence(gate)).toBe(false)
  })

  it('is refused to a gate that has been replaced', () => {
    const gates = new CaptchaGates()
    const first = gates.issue(-100, 7, TTL)
    gates.issue(-100, 7, TTL)

    expect(gates.claimConsequence(first)).toBe(false)
  })

  /**
   * An overdue timer — the process was suspended, or the loop was blocked past
   * the gate's own TTL. Punishing here creates the one state the design forbids:
   * a fresh hour-long restriction whose button `peek` already refuses.
   */
  it('is refused to a gate that outlived its TTL', () => {
    const c = clock()
    const gates = new CaptchaGates(c.now)
    const gate = gates.issue(-100, 7, TTL)

    c.ms += TTL + 1
    expect(gates.claimConsequence(gate)).toBe(false)
  })
})

describe('CaptchaGates — the cap holds during a raid', () => {
  it('collects expired gates to make room', () => {
    const c = clock()
    const gates = new CaptchaGates(c.now, 3)
    gates.issue(-100, 1, TTL)
    gates.issue(-100, 2, TTL)

    c.ms += TTL + 1
    gates.issue(-100, 3, TTL)
    gates.issue(-100, 4, TTL)

    expect(gates.size).toBe(2)
  })

  /**
   * The old sweep only collected the dead, so a map of 2000 LIVE gates — which
   * is what a join raid is — grew without a ceiling.
   */
  it('drops the oldest when every gate is still live', () => {
    const gates = new CaptchaGates(Date.now, 3)
    const oldest = gates.issue(-100, 1, TTL)
    gates.issue(-100, 2, TTL)
    gates.issue(-100, 3, TTL)
    const newest = gates.issue(-100, 4, TTL)

    expect(gates.size).toBe(3)
    expect(gates.isCurrent(oldest)).toBe(false)
    expect(gates.isCurrent(newest)).toBe(true)
  })

  it('stops the timers of a gate it evicts', () => {
    const gates = new CaptchaGates(Date.now, 2)
    const oldest = gates.issue(-100, 1, TTL)
    let stopped = 0
    oldest.cancels.push(() => { stopped += 1 })
    gates.issue(-100, 2, TTL)
    gates.issue(-100, 3, TTL)

    expect(stopped).toBe(1)
  })
})
