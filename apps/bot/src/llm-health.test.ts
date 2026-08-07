import { describe, expect, it } from 'vitest'
import { LlmHealth, LLM_OUTAGE_STREAK, LLM_OUTAGE_REPEAT_MS } from './llm-health.js'

const at = (t: { ms: number }): LlmHealth => new LlmHealth(() => t.ms)

describe('LlmHealth', () => {
  it('says nothing until the failures stop looking like bad luck', () => {
    const t = { ms: 1_000 }
    const health = at(t)
    for (let i = 1; i < LLM_OUTAGE_STREAK; i += 1) {
      expect(health.noteFailure(), `failure ${i}`).toBeNull()
    }
    expect(health.noteFailure()).toEqual({
      kind: 'down', consecutive: LLM_OUTAGE_STREAK, repeated: false
    })
  })

  it('announces the outage exactly once, however long it lasts', () => {
    // The property the whole file exists for. Handlers interleave, so without a
    // single-crossing test this becomes one line per message again — which is
    // the thing being replaced (2026-08-07: an hour of per-message warnings).
    const t = { ms: 1_000 }
    const health = at(t)
    let announcements = 0
    for (let i = 0; i < LLM_OUTAGE_STREAK * 20; i += 1) {
      if (health.noteFailure() !== null) announcements += 1
    }
    expect(announcements).toBe(1)
  })

  it('repeats hourly while it is still down, and not a message sooner', () => {
    const t = { ms: 1_000 }
    const health = at(t)
    for (let i = 0; i < LLM_OUTAGE_STREAK; i += 1) health.noteFailure()

    t.ms += LLM_OUTAGE_REPEAT_MS - 1
    expect(health.noteFailure()).toBeNull()
    t.ms += 2
    expect(health.noteFailure()).toEqual({
      kind: 'down', consecutive: LLM_OUTAGE_STREAK + 2, repeated: true
    })
    // And the hour restarts from the repeat, not from the original crossing.
    t.ms += LLM_OUTAGE_REPEAT_MS - 1
    expect(health.noteFailure()).toBeNull()
  })

  it('one answer clears the streak and reports what was missed', () => {
    const t = { ms: 1_000 }
    const health = at(t)
    for (let i = 0; i < LLM_OUTAGE_STREAK + 3; i += 1) health.noteFailure()
    expect(health.noteAnswer()).toEqual({ kind: 'recovered', missed: LLM_OUTAGE_STREAK + 3 })
    expect(health.failing).toBe(0)
  })

  it('a streak that was never announced recovers silently', () => {
    // A single rate limit is not an incident, and its ending is not news.
    const t = { ms: 1_000 }
    const health = at(t)
    health.noteFailure()
    health.noteFailure()
    expect(health.noteAnswer()).toBeNull()
  })

  it('interleaved answers mean there is no outage to announce', () => {
    // The 2026-08-07 truncation bug: some prompts 400'd for an hour while other
    // chats were judged normally throughout. Scattered failures are a malformed
    // question, not an unreachable classifier, and must never read as one.
    const t = { ms: 1_000 }
    const health = at(t)
    for (let i = 0; i < 200; i += 1) {
      expect(health.noteFailure()).toBeNull()
      expect(health.noteAnswer()).toBeNull()
    }
  })

  it('a second outage after a recovery is announced again', () => {
    const t = { ms: 1_000 }
    const health = at(t)
    for (let i = 0; i < LLM_OUTAGE_STREAK; i += 1) health.noteFailure()
    health.noteAnswer()
    let announcements = 0
    for (let i = 0; i < LLM_OUTAGE_STREAK; i += 1) {
      if (health.noteFailure() !== null) announcements += 1
    }
    expect(announcements).toBe(1)
  })
})
