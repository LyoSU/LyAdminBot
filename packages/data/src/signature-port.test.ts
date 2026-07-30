import { describe, expect, it, vi } from 'vitest'
import { MongoSignaturePort, templateLiteralLength } from './signature-port.js'
import { computeSignatureHashes } from './hashing.js'
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

  it('REGRESSION: a template made of placeholders cannot decide, however long the text', async () => {
    // The heavy normalizer turns handles, links, numbers and currency into
    // placeholders, so this 60-character message becomes the template
    // "заходь @_ _URL_ _NUM_" — which an innocent "заходь @vasya youtu.be/x"
    // matches just as well. Measuring the RAW length let it convict at 0.96.
    const port = new MongoSignaturePort(storeWith(CONFIRMED))
    const match = await port.match('Заходь @promo_bot https://t.me/+aaaaaaaaaaaaaaa 500$ 1000$')
    expect(match?.status).toBe('candidate')
  })

  it('an EXACT-hash match is judged on the raw text, not the template', async () => {
    // The exact hash is the text itself — no templating, no false breadth — so
    // the placeholder rule must not water it down.
    const text = 'Заходь @promo_bot https://t.me/+aaaaaaaaaaaaaaa 500$ 1000$'
    const port = new MongoSignaturePort(storeWith({ ...CONFIRMED, exactHash: exactHashOf(text) }))
    expect((await port.match(text))?.status).toBe('confirmed')
  })
})

/** The real exact hash, so the stub doc can pose as one written by `learn`. */
const exactHashOf = (text: string): string => computeSignatureHashes(text)!.exactHash

describe('templateLiteralLength', () => {
  it('counts only what survives the placeholders', () => {
    expect(templateLiteralLength('@vasya https://x.com 500$')).toBe(0)
    expect(templateLiteralLength('Заходь @vasya https://x.com')).toBe('заходь'.length)
  })

  it('is zero for text that is nothing but variable parts', () => {
    expect(templateLiteralLength('@a @b @c 1 2 3 $ €')).toBe(0)
  })
})

// ── learn ─────────────────────────────────────────────────────────────

interface LearnStub {
  store: MongoStore
  updates: Record<string, unknown>[]
  /** Doc the atomic upsert reports back (post-update state). */
  after: Record<string, unknown>
}

const learnStub = (after: Record<string, unknown> = {}): LearnStub => {
  const updates: Record<string, unknown>[] = []
  const stub: LearnStub = {
    after,
    updates,
    store: {
      spamSignatures: {
        findOneAndUpdate: vi.fn(async () => stub.after),
        updateOne: vi.fn(async (_filter: unknown, update: Record<string, unknown>) => {
          updates.push(update)
          return { acknowledged: true }
        })
      }
    } as unknown as MongoStore
  }
  return stub
}

const statusOf = (stub: LearnStub): string =>
  String((stub.updates[0]?.['$set'] as { status?: string } | undefined)?.status)

const longSpam = 'Потрібні люди на склад, оплата щодня, пишіть в особисті зараз'

describe('MongoSignaturePort.learn (2026-07-30 review)', () => {
  it('stores a candidate by default', async () => {
    const stub = learnStub()
    await new MongoSignaturePort(stub.store).learn(longSpam, 'auto:llm:job_scam')
    expect(statusOf(stub)).toBe('candidate')
  })

  it('honours an earned confirmation', async () => {
    const stub = learnStub()
    await new MongoSignaturePort(stub.store).learn(longSpam, 'community_vote', 'confirmed')
    expect(statusOf(stub)).toBe('confirmed')
  })

  it('refuses to confirm a text too short to be distinctive', async () => {
    // A deciding rule matched on a greeting is how v1 auto-banned people.
    const stub = learnStub()
    await new MongoSignaturePort(stub.store).learn('доброго ранку', 'community_vote', 'confirmed')
    expect(statusOf(stub)).toBe('candidate')
  })

  it('promotes a candidate once a SECOND chat reports the same text', async () => {
    const stub = learnStub({ chats: [-100, -200], status: 'candidate' })
    await new MongoSignaturePort(stub.store).learn(longSpam, 'auto:llm:job_scam', 'candidate', -200)
    expect(statusOf(stub)).toBe('confirmed')
  })

  it('does NOT promote on repetition inside one chat', async () => {
    // The same account re-posting the same text is one observation, not two.
    const stub = learnStub({ chats: [-100], status: 'candidate', confirmations: 9 })
    await new MongoSignaturePort(stub.store).learn(longSpam, 'auto:llm:job_scam', 'candidate', -100)
    expect(statusOf(stub)).toBe('candidate')
  })

  it('never demotes an already-confirmed signature', async () => {
    const stub = learnStub({ status: 'confirmed', chats: [-100] })
    await new MongoSignaturePort(stub.store).learn(longSpam, 'auto:llm:job_scam', 'candidate', -100)
    expect(statusOf(stub)).toBe('confirmed')
  })

  it('pushes the expiry out on every sighting, so a live campaign cannot age out', async () => {
    const stub = learnStub()
    const before = Date.now()
    await new MongoSignaturePort(stub.store).learn(longSpam, 'community_vote', 'confirmed')
    const expiresAt = (stub.updates[0]?.['$set'] as { expiresAt?: Date } | undefined)?.expiresAt
    expect(expiresAt).toBeInstanceOf(Date)
    // 90 days for confirmed, and measured from now rather than from first sighting.
    expect(expiresAt!.getTime() - before).toBeGreaterThan(89 * 86_400_000)
  })

  it('ignores text with no hashable content', async () => {
    const stub = learnStub()
    await new MongoSignaturePort(stub.store).learn('   ', 'community_vote', 'confirmed')
    expect(stub.updates).toHaveLength(0)
  })
})
