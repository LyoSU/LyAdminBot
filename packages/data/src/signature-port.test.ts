import { describe, expect, it } from 'vitest'
import { MongoSignaturePort } from './signature-port.js'
import type { MongoStore } from './mongo.js'

/** Stub store whose spamsignatures.findOne always returns the given doc. */
const storeWith = (doc: Record<string, unknown> | null): MongoStore =>
  ({ spamSignatures: { findOne: async () => doc } }) as unknown as MongoStore

const CONFIRMED = { _id: 'abc', status: 'confirmed' }

describe('MongoSignaturePort.match', () => {
  it('a confirmed match on a long text decides', async () => {
    const port = new MongoSignaturePort(storeWith(CONFIRMED))
    const match = await port.match('Заработок от 500$ в день, пиши в личку прямо сейчас!!!')
    expect(match?.status).toBe('confirmed')
  })

  it('a confirmed match on a short greeting-length text is downgraded to a signal', async () => {
    const port = new MongoSignaturePort(storeWith(CONFIRMED))
    // Real poisoned-corpus case: v1 auto-banned for this exact text.
    const match = await port.match('утра доброго')
    expect(match?.status).toBe('candidate')
  })

  it('returns null when nothing matches', async () => {
    const port = new MongoSignaturePort(storeWith(null))
    expect(await port.match('будь-який текст повідомлення тут')).toBeNull()
  })
})
