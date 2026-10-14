import { describe, expect, it } from 'vitest'
import { CaptchaGates, memberGone, planRestoredGate, type GateMark, type PersistedGate } from './captcha-gate.js'

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

/**
 * The measurement the 2026-08-27 review could not make.
 *
 * A tap wrote nothing anywhere, so "answered before the 45s fallback" and
 * "answered after it, having been publicly accused for nothing" were the same
 * event in every record we keep. Of 65 gates over 47.6 hours, 61 fell into that
 * blind spot; the only four that were legible were the ones nobody answered,
 * and their timing (165s = 45 + 120) says the fallback fires exactly as
 * designed — which is not the question. The age of the gate at the moment of
 * the tap IS the question.
 */
describe('CaptchaGates — how long the answer took', () => {
  it('reports the age of a gate against its own clock', () => {
    const c = clock()
    const gates = new CaptchaGates(c.now)
    const gate = gates.issue(-100, 7, TTL)

    c.ms += 5_000
    expect(gates.ageMs(gate)).toBe(5_000)
  })

  it('is zero at the moment of issue', () => {
    const gates = new CaptchaGates(clock().now)
    expect(gates.ageMs(gates.issue(-100, 7, TTL))).toBe(0)
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

/**
 * The persisted copy is what a tap falls back on after a restart, so it has to
 * track the registry exactly: saved when a gate opens, dropped when it closes,
 * and never dropped in a way that can take a NEWER gate with it.
 */
describe('CaptchaGates — persistence follows the registry', () => {
  const recorder = (): {
    saved: { chatId: number; userId: number; issuedMs: number; expiresMs: number }[]
    dropped: [number, number, number][]
    persistence: { save: (g: never) => void; drop: (c: number, u: number, i: number) => void }
  } => {
    const saved: { chatId: number; userId: number; issuedMs: number; expiresMs: number }[] = []
    const dropped: [number, number, number][] = []
    return {
      saved,
      dropped,
      persistence: {
        save: (g) => { saved.push(g) },
        drop: (c, u, i) => { dropped.push([c, u, i]) }
      }
    }
  }

  it('saves who and until when on issue', () => {
    const c = clock(5_000)
    const r = recorder()
    new CaptchaGates(c.now, 10, r.persistence).issue(-100, 7, TTL)
    expect(r.saved).toEqual([{ chatId: -100, userId: 7, issuedMs: 5_000, expiresMs: 5_000 + TTL }])
  })

  it('drops exactly the gate that was forgotten, by its issue time', () => {
    const c = clock(5_000)
    const r = recorder()
    const gates = new CaptchaGates(c.now, 10, r.persistence)
    const first = gates.issue(-100, 7, TTL)
    c.ms += 1_000
    const second = gates.issue(-100, 7, TTL)
    // The superseded gate is no longer the one in force: nothing is dropped.
    expect(gates.forget(first)).toBe(false)
    expect(r.dropped).toEqual([])
    gates.forget(second)
    expect(r.dropped).toEqual([[-100, 7, 6_000]])
  })

  it('keeps the persisted exit of a live gate evicted by a raid', () => {
    const r = recorder()
    const gates = new CaptchaGates(clock().now, 1, r.persistence)
    gates.issue(-100, 1, TTL)
    gates.issue(-100, 2, TTL)
    expect(gates.peek(-100, 1)).toBeNull()
    expect(r.dropped).toEqual([])
  })

  it('a persistence layer that throws cannot break the registry', () => {
    const gates = new CaptchaGates(clock().now, 10, {
      save: () => { throw new Error('mongo down') },
      drop: () => { throw new Error('mongo down') }
    })
    const gate = gates.issue(-100, 7, TTL)
    expect(gates.peek(-100, 7)).toBe(gate)
    expect(gates.forget(gate)).toBe(true)
  })
})

/**
 * The consequence across a restart (2026-10-15). Until then the 120-second
 * timer lived only in memory, and a gate counting down during a deploy was
 * never punished. What the registry persists, and what the boot path decides
 * from it, are pinned here.
 */
describe('CaptchaGates — the consequence survives a restart', () => {
  const GRACE = 120_000
  const MUTE = 3_600_000
  const LIFE = GRACE + MUTE + 600_000

  const marks = (): {
    log: [number, number, number, GateMark][]
    persistence: { save: () => void; drop: () => void; mark: (c: number, u: number, i: number, p: GateMark) => void }
  } => {
    const log: [number, number, number, GateMark][] = []
    return {
      log,
      persistence: { save: () => {}, drop: () => {}, mark: (c, u, i, p) => { log.push([c, u, i, p]) } }
    }
  }

  const row = (over: Partial<PersistedGate> = {}): PersistedGate => ({
    chatId: -100, userId: 7, issuedMs: 1_000, expiresMs: 1_000 + LIFE,
    deliveredMs: 1_500, triggerMessageId: 42, ephemeralMessageId: 9, publicMessageId: null,
    answered: false, consequenceApplied: false, ...over
  })

  it('records the delivery moment, with the trigger, when the first prompt id lands', () => {
    const c = clock(1_000)
    const m = marks()
    const gates = new CaptchaGates(c.now, 10, m.persistence)
    const gate = gates.issue(-100, 7, LIFE)
    gate.triggerMessageId = 42
    expect(gate.deliveredMs).toBeNull()
    c.ms = 1_500
    gate.ephemeralMessageId = 9
    expect(gate.deliveredMs).toBe(1_500)
    expect(gate.ephemeralMessageId).toBe(9)
    expect(m.log).toEqual([[-100, 7, 1_000, {
      deliveredMs: 1_500, triggerMessageId: 42, ephemeralMessageId: 9, publicMessageId: null
    }]])
    // A later prompt keeps the first delivery moment: the clock started once.
    c.ms = 9_000
    gate.publicMessageId = 11
    expect(gate.deliveredMs).toBe(1_500)
  })

  it('records an answer and a claimed consequence against the exact gate', () => {
    const m = marks()
    const gates = new CaptchaGates(clock(1_000).now, 10, m.persistence)
    const answered = gates.issue(-100, 7, LIFE)
    gates.markAnswered(answered)
    const ignored = gates.issue(-100, 8, LIFE)
    expect(gates.claimConsequence(ignored)).toBe(true)
    expect(gates.claimConsequence(ignored)).toBe(false)
    expect(m.log).toEqual([
      [-100, 7, 1_000, { answered: true }],
      [-100, 8, 1_000, { consequenceApplied: true }]
    ])
  })

  it('a restored gate is in force, carries its row, and can be claimed exactly once', () => {
    const gates = new CaptchaGates(clock(200_000).now)
    const gate = gates.restore(row())
    expect(gate).not.toBeNull()
    expect(gates.peek(-100, 7)).toBe(gate)
    expect(gate!.triggerMessageId).toBe(42)
    expect(gate!.ephemeralMessageId).toBe(9)
    expect(gate!.deliveredMs).toBe(1_500)
    expect(gates.claimConsequence(gate!)).toBe(true)
    expect(gates.claimConsequence(gate!)).toBe(false)
  })

  it('a restore never displaces a gate issued since boot, nor revives a lapsed one', () => {
    const gates = new CaptchaGates(clock(200_000).now)
    const fresh = gates.issue(-100, 7, LIFE)
    expect(gates.restore(row())).toBeNull()
    expect(gates.peek(-100, 7)).toBe(fresh)
    expect(gates.restore(row({ userId: 8, expiresMs: 199_999 }))).toBeNull()
  })

  it('a tap on a restored gate shuts the door on its consequence', () => {
    const gates = new CaptchaGates(clock(200_000).now)
    const gate = gates.restore(row())!
    gates.markAnswered(gate)
    expect(gates.claimConsequence(gate)).toBe(false)
  })

  describe('planRestoredGate', () => {
    it('future consequence → re-arm for exactly the time that remains', () => {
      // Delivered at 1.5 s, due at 121.5 s; the bot is back at 60 s.
      expect(planRestoredGate(row(), 60_000, GRACE, MUTE)).toEqual({ kind: 'rearm', delayMs: 61_500 })
    })

    it('past consequence → apply once', () => {
      expect(planRestoredGate(row(), 300_000, GRACE, MUTE)).toEqual({ kind: 'apply' })
      // Exactly at the moment counts as past: the live timer would have fired.
      expect(planRestoredGate(row(), 121_500, GRACE, MUTE)).toEqual({ kind: 'apply' })
    })

    it('answered, punished, expired or never delivered → nothing', () => {
      expect(planRestoredGate(row({ answered: true }), 300_000, GRACE, MUTE))
        .toEqual({ kind: 'skip', reason: 'answered' })
      expect(planRestoredGate(row({ consequenceApplied: true }), 300_000, GRACE, MUTE))
        .toEqual({ kind: 'skip', reason: 'punished' })
      expect(planRestoredGate(row(), 1_000 + LIFE, GRACE, MUTE))
        .toEqual({ kind: 'skip', reason: 'expired' })
      expect(planRestoredGate(row({ deliveredMs: null }), 300_000, GRACE, MUTE))
        .toEqual({ kind: 'skip', reason: 'undelivered' })
    })

    it('never mutes for longer than the button still lives', () => {
      // The button lapses at 1_000 + LIFE; a mute applied after LIFE − MUTE
      // past the issue would outlast it.
      const late = 1_000 + LIFE - MUTE + 1
      expect(planRestoredGate(row(), late, GRACE, MUTE)).toEqual({ kind: 'skip', reason: 'button_would_lapse' })
      expect(planRestoredGate(row(), late - 1, GRACE, MUTE)).toEqual({ kind: 'apply' })
    })

    it('over the whole life of a gate: a re-arm is positive and never longer than the grace', () => {
      for (let now = 0; now <= LIFE + 2_000; now += 7_919) {
        for (const delivered of [null, 1_000, 1_500, 50_000]) {
          const plan = planRestoredGate(row({ deliveredMs: delivered }), now, GRACE, MUTE)
          if (plan.kind === 'rearm') {
            expect(plan.delayMs).toBeGreaterThan(0)
            expect(plan.delayMs).toBeLessThanOrEqual(GRACE + (delivered ?? 0))
            expect(now + plan.delayMs).toBe((delivered ?? 0) + GRACE)
          }
          if (delivered === null) expect(plan.kind).toBe('skip')
        }
      }
    })
  })

  describe('memberGone', () => {
    it('reads removal from the raw member answer', () => {
      expect(memberGone(null)).toBe(true)
      expect(memberGone({ status: 'banned' })).toBe(true)
      expect(memberGone({ status: 'left' })).toBe(true)
      expect(memberGone({ status: 'restricted', isMember: false })).toBe(true)
    })

    it('a member, a restricted member, or a failed lookup is not gone', () => {
      expect(memberGone({ status: 'member' })).toBe(false)
      expect(memberGone({ status: 'restricted', isMember: true })).toBe(false)
      expect(memberGone(undefined)).toBe(false)
    })
  })
})
