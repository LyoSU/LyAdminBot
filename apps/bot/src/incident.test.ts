import { describe, expect, it } from 'vitest'
import type { Verdict, VerdictAction } from '@lyadmin/core'
import { IncidentTracker, SenderMessageLog, incidentPowerFor, correctionOwns } from './incident.js'

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.9, action: 'ban', needsVote: false, banDurationSeconds: null,
  decidedBy: 'llm', ruleId: null, signals: [], reasonCode: 'job_scam',
  reasonEvidence: null, meta: {},
  ...over
})

describe('incidentPowerFor — the ceiling that makes this safe', () => {
  it('a removal licenses silencing what the sender sends next', () => {
    for (const action of ['ban', 'kick', 'mute'] as VerdictAction[]) {
      expect(incidentPowerFor(verdict({ action }), true)).toBe('silence_sender')
    }
  })

  it('a deleted MESSAGE licenses nothing but the shared card', () => {
    // The sender is still a member with every benefit of the doubt they had a
    // minute ago. Production 2026-08-01: a member answering somebody pasted a
    // private invite into a conversation that had asked for one — one message
    // taken down, and their next sentence is nobody's business but theirs.
    expect(incidentPowerFor(verdict({ action: 'delete' }), true)).toBe('card_only')
  })

  it('an unsure verdict never silences, whatever action carried it', () => {
    expect(incidentPowerFor(verdict({ action: 'ban', needsVote: true }), true)).toBe('card_only')
    expect(incidentPowerFor(verdict({ action: 'delete', needsVote: true }), true)).toBe('card_only')
  })

  it('nothing at all when the verdict acted on nobody', () => {
    expect(incidentPowerFor(verdict({ action: 'none' }), true)).toBeNull()
    expect(incidentPowerFor(verdict({ action: 'observe' }), true)).toBeNull()
    // A captcha restricts in order to ASK; it has concluded nothing.
    expect(incidentPowerFor(verdict({ action: 'captcha' }), true)).toBeNull()
  })

  it('REGRESSION: a verdict Telegram refused to execute contains nobody', () => {
    // Without the `applied` half, a chat where the bot has no rights would open
    // incidents that silence senders it never managed to remove — and the chats
    // where enforcement fails are exactly the ones where a run piles up fastest.
    expect(incidentPowerFor(verdict({ action: 'ban' }), false)).toBeNull()
  })
})

describe('IncidentTracker', () => {
  const open = (t: IncidentTracker, power: 'silence_sender' | 'card_only', now?: number) =>
    t.open(-100, 42, {
      power, action: power === 'silence_sender' ? 'ban' : 'delete',
      reasonCode: 'job_scam', triggerMessageId: 7, cardMessageId: 11
    }, now)

  it('only a silencing incident may act on a message by itself', () => {
    const t = new IncidentTracker()
    open(t, 'card_only')
    expect(t.live(-100, 42)).not.toBeNull()
    expect(t.silencing(-100, 42)).toBeNull()
    open(t, 'silence_sender')
    expect(t.silencing(-100, 42)).not.toBeNull()
  })

  it('ages out at the TTL', () => {
    const t = new IncidentTracker({ ttlMs: 1000 })
    open(t, 'silence_sender', 5_000)
    expect(t.silencing(-100, 42, 5_999)).not.toBeNull()
    expect(t.silencing(-100, 42, 6_000)).toBeNull()
  })

  it('is per sender per chat — not per chat', () => {
    const t = new IncidentTracker()
    open(t, 'silence_sender')
    // A join surge brings several spammers at once; one verdict must not silence
    // the others' victims, or anybody else in the chat.
    expect(t.silencing(-100, 43)).toBeNull()
    expect(t.silencing(-200, 42)).toBeNull()
  })

  it('counts what the run has cost, starting from the trigger', () => {
    const t = new IncidentTracker()
    const opened = open(t, 'silence_sender')
    expect(opened.removedCount).toBe(1)
    expect(t.addRemoved(-100, 42)?.removedCount).toBe(2)
    expect(t.addRemoved(-100, 42, 3)?.removedCount).toBe(5)
  })

  it('a closed incident stops silencing immediately', () => {
    // What an override or a ham vote calls: an incident that outlived its verdict
    // would go on deleting the messages of somebody the chat just vouched for.
    const t = new IncidentTracker()
    open(t, 'silence_sender')
    t.close(-100, 42)
    expect(t.silencing(-100, 42)).toBeNull()
    expect(t.addRemoved(-100, 42)).toBeNull()
  })

  /**
   * The incident is the only thing that remembers where the enforcement notice
   * is, and closing the incident is the first thing a correction does — so a
   * caller that means to take that notice down has to read the id first.
   *
   * Written down because `restoreFalsePositive` depends on the ordering and
   * nothing about the two lines says so: swapping them leaves the chat reading
   * an accusation the bot has already withdrawn, and every test still passes.
   */
  it('forgets where the notice was as soon as it is closed', () => {
    const t = new IncidentTracker()
    open(t, 'silence_sender')
    t.attachCard(-100, 42, 777)
    expect(t.live(-100, 42)?.cardMessageId).toBe(777)
    t.close(-100, 42)
    expect(t.live(-100, 42)).toBeNull()
  })

  it('stays bounded under load', () => {
    const t = new IncidentTracker({ maxTracked: 10 })
    for (let i = 0; i < 100; i += 1) {
      t.open(-100, i, {
        power: 'silence_sender', action: 'ban', reasonCode: 'x',
        triggerMessageId: i, cardMessageId: null
      })
    }
    expect(t.silencing(-100, 99)).not.toBeNull()
    expect(t.silencing(-100, 0)).toBeNull()
  })
})

describe('SenderMessageLog — which of the run goes with the sender', () => {
  it('returns only what the pipeline had already declined to call clean', () => {
    const log = new SenderMessageLog()
    log.note(-100, 42, 1, 0.9)
    log.note(-100, 42, 2, 0.34)
    log.note(-100, 42, 3, 0.35)
    log.note(-100, 42, 4, 0.05)
    expect(log.purgeTargets(-100, 42, { except: 99, minPSpam: 0.35 })).toEqual([1, 3])
  })

  it('REGRESSION: the member who was mid-argument keeps their messages', () => {
    // The reason the bar exists. Eight short messages in two minutes is what a
    // disagreement looks like, and they score around 0.1 — so a verdict against
    // somebody else, or a later verdict against this person, must not sweep
    // them. Without a bar the cost of one false positive is multiplied by the
    // length of the conversation.
    const log = new SenderMessageLog()
    for (let id = 1; id <= 8; id += 1) log.note(-100, 42, id, 0.1)
    expect(log.purgeTargets(-100, 42, { except: 9, minPSpam: 0.35 })).toEqual([])
  })

  it('never returns the triggering message — the executor owns that one', () => {
    const log = new SenderMessageLog()
    log.note(-100, 42, 5, 0.99)
    expect(log.purgeTargets(-100, 42, { except: 5, minPSpam: 0.35 })).toEqual([])
  })

  it('forgets messages older than the window', () => {
    const log = new SenderMessageLog({ windowMs: 1000 })
    log.note(-100, 42, 1, 0.9, 9_000)
    log.note(-100, 42, 2, 0.9, 10_800)
    // Floor is inclusive: at exactly windowMs old a message is still in the run.
    expect(log.purgeTargets(-100, 42, { except: 0, minPSpam: 0.35 }, 11_000)).toEqual([2])
    expect(log.purgeTargets(-100, 42, { except: 0, minPSpam: 0.35 }, 11_800)).toEqual([2])
  })

  it('keeps at most the newest few per sender', () => {
    const log = new SenderMessageLog({ maxPerSender: 3 })
    for (let id = 1; id <= 10; id += 1) log.note(-100, 42, id, 0.9)
    expect(log.purgeTargets(-100, 42, { except: 0, minPSpam: 0.35 })).toEqual([8, 9, 10])
  })

  it('is per sender per chat, and forgettable', () => {
    const log = new SenderMessageLog()
    log.note(-100, 42, 1, 0.9)
    log.note(-100, 43, 2, 0.9)
    expect(log.purgeTargets(-100, 43, { except: 0, minPSpam: 0.35 })).toEqual([2])
    log.forget(-100, 42)
    expect(log.purgeTargets(-100, 42, { except: 0, minPSpam: 0.35 })).toEqual([])
    expect(log.purgeTargets(-100, 43, { except: 0, minPSpam: 0.35 })).toEqual([2])
  })
})

describe('correctionOwns — a correction is about one message', () => {
  it('clears state this message opened', () => {
    expect(correctionOwns(7, 7)).toBe(true)
  })

  it('REGRESSION: leaves alone state that names a later message', () => {
    // Incident A ages out at ten minutes, B opens for the same sender, A's
    // fifteen-minute ballot then resolves ham. Without this, restoring A closes
    // B — a valid, newer enforcement silently stops, and a captcha cancelled
    // without lifting its mute leaves the member muted with nothing to answer.
    expect(correctionOwns(9, 7)).toBe(false)
  })

  /**
   * A gate whose trigger message is already gone names nobody. Refusing to
   * clear it would bring back the stray consequence timer of `4950a6c`.
   */
  it('clears unowned state rather than leaving a timer armed', () => {
    expect(correctionOwns(null, 7)).toBe(true)
    expect(correctionOwns(undefined, 7)).toBe(true)
  })
})
