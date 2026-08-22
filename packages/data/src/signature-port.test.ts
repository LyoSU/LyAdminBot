import { describe, expect, it, vi } from 'vitest'
import { MongoSignaturePort, templateLiteralLength } from './signature-port.js'
import { computeSignatureHashes } from './hashing.js'
import type { MongoStore } from './mongo.js'

/** Stub store whose spamsignatures.findOne always returns the given doc. */
const storeWith = (doc: Record<string, unknown> | null): MongoStore =>
  ({ spamSignatures: { findOne: async () => doc } }) as unknown as MongoStore

/**
 * A stored signature as `learn` would have written it, carrying the hash the
 * lookup is expected to find it by. Which hash matched decides how much the hit
 * is worth, so a stub that carries none of them cannot stand in for a real
 * document — it looks exactly like a fold-only match.
 */
const confirmedVia = (
  layer: 'exact' | 'normalized' | 'folded',
  text: string
): Record<string, unknown> => {
  const hashes = computeSignatureHashes(text)!
  return {
    _id: 'abc',
    status: 'confirmed',
    ...(layer === 'exact' ? { exactHash: hashes.exactHash } : {}),
    ...(layer === 'normalized' ? { normalizedHash: hashes.normalizedHash } : {}),
    ...(layer === 'folded' ? { foldedHash: hashes.foldedHash } : {})
  }
}

describe('MongoSignaturePort.match', () => {
  it('a confirmed match on a long text decides', async () => {
    const text = 'Заработок от 500$ в день, пиши в личку прямо сейчас!!!'
    const port = new MongoSignaturePort(storeWith(confirmedVia('normalized', text)))
    expect((await port.match(text))?.status).toBe('confirmed')
  })

  it('a confirmed match on a short greeting-length text is downgraded to a signal', async () => {
    // Real poisoned-corpus case: v1 auto-banned for this exact text.
    const port = new MongoSignaturePort(storeWith(confirmedVia('normalized', 'утра доброго')))
    const match = await port.match('утра доброго')
    expect(match?.status).toBe('candidate')
  })

  it('finds a homoglyph rotation of a text it has seen', async () => {
    // Production 2026-07-31: the same advert reposted seven times, each with a
    // different Latin/Greek stand-in, matched by nothing at all.
    const learned = 'Ищу онлайн менеджера. От 50$ в день. Пиши в лс'
    const rotated = 'Ищу онлайη меhеджερа. От 50$ b деhь. Пиши b лс'
    const port = new MongoSignaturePort(storeWith(confirmedVia('folded', learned)))
    expect(await port.match(rotated)).not.toBeNull()
  })

  it('a fold-only match may signal but never decide', async () => {
    // The fold is lossy — that is how it survives the rotation — so it must not
    // carry the authority of a hash computed over the text itself, whatever
    // status the stored document claims.
    const learned = 'Ищу онлайн менеджера. От 50$ в день. Пиши в лс'
    const rotated = 'Ищу онлайη меhеджερа. От 50$ b деhь. Пиши b лс'
    const port = new MongoSignaturePort(storeWith(confirmedVia('folded', learned)))
    expect((await port.match(rotated))?.status).toBe('candidate')
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
    const text = 'Заходь @promo_bot https://t.me/+aaaaaaaaaaaaaaa 500$ 1000$'
    const port = new MongoSignaturePort(storeWith(confirmedVia('normalized', text)))
    expect((await port.match(text))?.status).toBe('candidate')
  })

  it('an EXACT-hash match is judged on the raw text, not the template', async () => {
    // The exact hash is the text itself — no templating, no false breadth — so
    // the placeholder rule must not water it down.
    const text = 'Заходь @promo_bot https://t.me/+aaaaaaaaaaaaaaa 500$ 1000$'
    const port = new MongoSignaturePort(storeWith(confirmedVia('exact', text)))
    expect((await port.match(text))?.status).toBe('confirmed')
  })
})


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

describe('MongoSignaturePort.retire', () => {
  const spamText = 'Заработок от 500$ в день, пиши в личку прямо сейчас!!!'

  /** Store stub that records the update `retire` issues. */
  const storeRecording = (): { store: MongoStore; calls: unknown[][] } => {
    const calls: unknown[][] = []
    const store = {
      spamSignatures: {
        updateOne: async (...args: unknown[]) => { calls.push(args); return { matchedCount: 1 } }
      }
    } as unknown as MongoStore
    return { store, calls }
  }

  it('disables the signature and drops it back to candidate', async () => {
    // Retiring is a network-wide act — the signature fires in every chat for
    // ninety days — so it demotes rather than deletes: the record of what was
    // once believed survives for calibration replay.
    const { store, calls } = storeRecording()
    await new MongoSignaturePort(store).retire(spamText)
    expect(calls).toHaveLength(1)
    const update = calls[0]?.[1] as { $set: Record<string, unknown> }
    expect(update.$set['status']).toBe('candidate')
    expect(update.$set['disabledAt']).toBeInstanceOf(Date)
    expect(update.$set['disabledBy']).toBe('admin_override')
  })

  it('finds the signature by every layer match() would have used', async () => {
    // The candidate that only contributed a SIGNAL is the case this exists for:
    // it never appears as `decidedBy`, so the ruleId path never reaches it, and
    // it has to be found by the text instead — through the same three hashes.
    const { store, calls } = storeRecording()
    await new MongoSignaturePort(store).retire(spamText)
    const filter = calls[0]?.[0] as { $or: Record<string, string>[] }
    const hashes = computeSignatureHashes(spamText)!
    expect(filter.$or.map((c) => Object.keys(c)[0]))
      .toEqual(['exactHash', 'normalizedHash', 'foldedHash'])
    expect(filter.$or[0]?.['exactHash']).toBe(hashes.exactHash)
  })

  it('text with nothing to hash is a no-op', async () => {
    const { store, calls } = storeRecording()
    await new MongoSignaturePort(store).retire('   ')
    expect(calls).toHaveLength(0)
  })
})
