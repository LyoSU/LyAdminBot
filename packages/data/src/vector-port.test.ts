import { beforeEach, describe, expect, it, vi } from 'vitest'

// The port builds its own Qdrant/OpenAI clients, so the seams are the modules.
const search = vi.fn()
const upsert = vi.fn()
const setPayload = vi.fn()
const embeddings = vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class { search = search; upsert = upsert; setPayload = setPayload }
}))
vi.mock('openai', () => ({
  default: class { embeddings = { create: embeddings } }
}))

const { QdrantVectorPort } = await import('./vector-port.js')

const port = new QdrantVectorPort({ qdrantUrl: 'http://q', openaiApiKey: 'k' })

/** Long enough to be distinctive — the short-text case is tested separately. */
const spamText = 'Потрібні люди на склад, оплата щодня, пишіть в особисті зараз'

const hit = (payload: Record<string, unknown>, score = 0.95): void => {
  search.mockResolvedValueOnce([{ id: 'p1', score, payload }])
}

const payloadOf = (call: number = 0): Record<string, unknown> =>
  upsert.mock.calls[call]?.[1].points[0].payload as Record<string, unknown>

beforeEach(() => {
  search.mockReset()
  upsert.mockReset()
  setPayload.mockReset()
})

describe('QdrantVectorPort.search', () => {
  it('an explicitly confirmed point is confirmed', async () => {
    hit({ status: 'confirmed' })
    expect((await port.search(spamText))?.status).toBe('confirmed')
  })

  it('repeated independent hits confirm', async () => {
    hit({ hitCount: 3 })
    expect((await port.search(spamText))?.status).toBe('confirmed')
  })

  it('REGRESSION: a v1 point with high confidence is only a candidate', async () => {
    // `confidence` is v1's own LLM score — including on its false positives,
    // which is what v2 exists to stop. Treating it as confirmation let an
    // unvetted v1 point mute people at 0.92 pSpam with no vote.
    hit({ confidence: 95 })
    expect((await port.search(spamText))?.status).toBe('candidate')
  })

  it('an expired learned point is ignored entirely', async () => {
    hit({ status: 'confirmed', expiresAtUnix: Math.floor(Date.now() / 1000) - 10 })
    expect(await port.search(spamText)).toBeNull()
  })

  it('a v1 point without an expiry still counts', async () => {
    hit({ status: 'confirmed' })
    expect(await port.search(spamText)).not.toBeNull()
  })

  it('a disabled point is ignored', async () => {
    hit({ status: 'confirmed', disabledAt: '2026-01-01' })
    expect(await port.search(spamText)).toBeNull()
  })

  it('below the reportable similarity nothing is returned', async () => {
    hit({ status: 'confirmed' }, 0.5)
    expect(await port.search(spamText)).toBeNull()
  })

  it('emoji-only text never reaches the index (v1 collision bug)', async () => {
    expect(await port.search('🔥🔥🔥')).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })
})

describe('QdrantVectorPort.learn (2026-07-30 review)', () => {
  it('writes a candidate by default — a semantic rule is blunter than a hash', async () => {
    await port.learn(spamText, 'auto:llm:job_scam')
    expect(payloadOf()['status']).toBe('candidate')
    expect(payloadOf()['hitCount']).toBeUndefined()
  })

  it('a confirmed write carries the confirming fields', async () => {
    await port.learn(spamText, 'community_vote', 'confirmed')
    expect(payloadOf()['status']).toBe('confirmed')
    expect(payloadOf()['hitCount']).toBe(3)
  })

  it('every learned point expires, so a dead campaign stops matching', async () => {
    await port.learn(spamText, 'community_vote', 'confirmed')
    const expires = Number(payloadOf()['expiresAtUnix'])
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000) + 89 * 86_400)
  })

  it('REGRESSION: a text too short to be distinctive is not learned at all', async () => {
    // Cosine distance on short strings is dominated by length and topic: two
    // unrelated greetings sit above 0.93 routinely.
    await port.learn('доброго ранку', 'community_vote', 'confirmed')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('re-learning the same text upserts the same point id', async () => {
    await port.learn(spamText, 'a', 'candidate')
    await port.learn(spamText, 'b', 'confirmed')
    expect(upsert.mock.calls[0]?.[1].points[0].id).toBe(upsert.mock.calls[1]?.[1].points[0].id)
  })
})

describe('QdrantVectorPort.retire', () => {
  it('disables the point for a text an admin called clean', async () => {
    // `search` has always skipped points carrying `disabledAt`, but nothing in
    // the codebase ever wrote one: a read with no writer, so a vector that kept
    // producing false positives could not be retired by anybody, admin
    // included. The signature layer had this from the start.
    await port.retire(spamText)
    expect(setPayload).toHaveBeenCalledTimes(1)
    const [collection, args] = setPayload.mock.calls[0] as [string, {
      payload: Record<string, unknown>; points: string[]
    }]
    expect(collection).toBe('spam_vectors')
    expect(typeof args.payload['disabledAt']).toBe('string')
    expect(args.points).toHaveLength(1)
  })

  it('addresses the same point learning would have written', async () => {
    // The id is derived from the text, so retiring needs no lookup — but it
    // also means the two must agree, or retirement silently misses.
    await port.learn(spamText, 'test', 'candidate')
    await port.retire(spamText)
    const learned = (upsert.mock.calls[0]?.[1] as { points: { id: string }[] }).points[0]?.id
    const retired = (setPayload.mock.calls[0]?.[1] as { points: string[] }).points[0]
    expect(retired).toBe(learned)
  })

  it('a text that was never learned is a no-op, not a throw', async () => {
    setPayload.mockRejectedValueOnce(new Error('point not found'))
    await expect(port.retire('нічого такого не було')).resolves.toBeUndefined()
  })
})
