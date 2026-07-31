/**
 * What a ground-truth label has to contain.
 *
 * `pipeline_feedback` is the only permanent record of a human saying "this was
 * not spam", and it is the whole corpus available for judging a calibration
 * change. It used to store `decidedBy`/`ruleId`/`reasonCode` — how the verdict
 * was reached — while the signals and the score lived in `pipeline_decisions`,
 * which expires after 14 days. Two weeks on, a permanent label pointed at
 * evidence that no longer existed, so no weight change could ever be checked
 * against the false positives we already knew about.
 *
 * Hence a test on the document shape rather than on behaviour: the value of this
 * write is entirely in what it preserves.
 */
import { describe, expect, it } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { MongoStore } from './mongo.js'

interface Captured { doc: Record<string, unknown> | null }

/** A store whose feedback insert is captured instead of performed. */
const captureStore = (): { store: MongoStore; captured: Captured } => {
  const captured: Captured = { doc: null }
  const store = {
    feedback: {
      insertOne: async (doc: Record<string, unknown>) => { captured.doc = doc; return {} }
    },
    // recordOverride also deactivates a matched signature; not under test here.
    spamSignatures: { updateOne: async () => ({}) }
  } as unknown as MongoStore
  // The method under test is the real one; only the collections are stubbed.
  return { store: Object.assign(store, { recordOverride: MongoStore.prototype.recordOverride }), captured }
}

const verdict: Pick<Verdict, 'decidedBy' | 'ruleId' | 'reasonCode' | 'pSpam' | 'action' | 'signals' | 'meta'> = {
  decidedBy: 'score',
  ruleId: null,
  reasonCode: 'promo',
  pSpam: 0.82,
  action: 'delete',
  signals: [{ name: 'sleeper_awakened' }, { name: 'promo_in_bio' }, { name: 'new_globally' }],
  meta: { scorePSpam: 0.82, contentEvidence: '0/0', cappedGroups: 'newness' }
}

describe('recordOverride', () => {
  it('keeps the evidence, not just a pointer to how the verdict was reached', async () => {
    const { store, captured } = captureStore()
    await store.recordOverride({ chatId: -100, messageId: 7, userId: 42, adminId: 1, verdict })

    expect(captured.doc).toMatchObject({
      kind: 'override_not_spam',
      // Without these three the label cannot be replayed against new weights.
      signals: ['sleeper_awakened', 'promo_in_bio', 'new_globally'],
      pSpam: 0.82,
      action: 'delete'
    })
    // The score breakdown is what makes the arithmetic reproducible for a
    // verdict that came from a port or the model rather than from signals alone.
    expect((captured.doc?.['meta'] as Record<string, unknown>)['scorePSpam']).toBe(0.82)
  })

  it('still records a label when the verdict could not be recalled', async () => {
    // The decision record expired or the process restarted. An admin did say
    // "not spam", so the label is kept — it simply cannot join a replay.
    const { store, captured } = captureStore()
    await store.recordOverride({
      chatId: -100, messageId: 7, userId: 42, adminId: 1,
      verdict: { decidedBy: 'error', ruleId: null, reasonCode: 'unknown', pSpam: 0, action: 'none', signals: [], meta: {} }
    })

    expect(captured.doc).toMatchObject({ kind: 'override_not_spam', signals: [] })
  })
})
