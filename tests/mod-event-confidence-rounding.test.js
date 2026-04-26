// Regression: confidence values must reach persistence as integers.
//
// History: production ModEvent rows were observed with raw float confidences
// like 92.84843072905365 / 99.99995, originating from LLM/vector-pipeline
// computations. Those leaked into ModLog.reason as `confidence=92.84843...`
// and broke `group-by reason` analytics dashboards. Fix rounds at write time
// in two places (createModEvent + sendModEventNotification entry point).

const assert = require('assert')

delete require.cache[require.resolve('../helpers/mod-event')]
const modEvent = require('../helpers/mod-event')

// ──────────────────────────────────────────────────────────────────────────
// roundConfidence — pure utility
// ──────────────────────────────────────────────────────────────────────────
{
  const { roundConfidence } = modEvent
  assert.strictEqual(roundConfidence(92.84843072905365), 93, 'rounds .84 up')
  assert.strictEqual(roundConfidence(99.99995), 100, 'rounds near-100 up')
  assert.strictEqual(roundConfidence(99.4), 99, 'rounds .4 down')
  assert.strictEqual(roundConfidence(85), 85, 'integer pass-through')
  assert.strictEqual(roundConfidence(0), 0, 'zero pass-through')
  assert.strictEqual(roundConfidence(null), null, 'null pass-through')
  assert.strictEqual(roundConfidence(undefined), undefined, 'undefined pass-through')
  assert.strictEqual(roundConfidence('92.5'), 93, 'numeric string is normalized')
  assert.strictEqual(roundConfidence(NaN), NaN, 'NaN pass-through (not finite → no rounding)')
}

// ──────────────────────────────────────────────────────────────────────────
// createModEvent — must round confidence on its way to db.ModEvent.create
// ──────────────────────────────────────────────────────────────────────────
{
  const captured = []
  const fakeDb = {
    ModEvent: {
      create: async (fields) => {
        captured.push(fields)
        return { ...fields, _id: 'fake' }
      }
    }
  }

  ;(async () => {
    await modEvent.createModEvent(fakeDb, {
      chatId: -100,
      targetId: 1,
      actionType: 'auto_ban',
      confidence: 92.84843072905365,
      reason: 'Vector match: spam'
    })
    await modEvent.createModEvent(fakeDb, {
      chatId: -100,
      targetId: 2,
      actionType: 'auto_mute',
      confidence: 99.99995
    })
    // null/undefined must survive
    await modEvent.createModEvent(fakeDb, {
      chatId: -100,
      targetId: 3,
      actionType: 'manual_ban',
      confidence: undefined
    })
    await modEvent.createModEvent(fakeDb, {
      chatId: -100,
      targetId: 4,
      actionType: 'manual_kick'
      // confidence omitted entirely
    })

    assert.strictEqual(captured[0].confidence, 93, 'float rounded on create')
    assert.strictEqual(captured[1].confidence, 100, 'near-100 rounded on create')
    assert.strictEqual(captured[2].confidence, undefined, 'undefined preserved')
    assert.strictEqual('confidence' in captured[3], false, 'omitted key stays omitted')
    // Original reason must not be mutated
    assert.strictEqual(captured[0].reason, 'Vector match: spam')

    console.log('mod-event-confidence-rounding: OK')
  })().catch(err => {
    console.error('mod-event-confidence-rounding: FAIL', err)
    process.exit(1)
  })
}
