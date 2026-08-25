import { describe, expect, it } from 'vitest'
import {
  createTmePreviewResolver, isTmeUrl, normalizeTmeUrl, parseTmePreview
} from './tme-preview.js'

const page = (meta: Record<string, string>): string =>
  `<!DOCTYPE html><html><head><title>Telegram</title>` +
  Object.entries(meta).map(([k, v]) => `<meta property="og:${k}" content="${v}">`).join('\n') +
  `</head><body></body></html>`

const CDN_IMAGE = 'https://cdn1.telesco.pe/file/abcdef.jpg'
const LOGO = 'https://telegram.org/img/t_logo_2x.png'

describe('parseTmePreview', () => {
  it('reads what the page says the destination is', () => {
    expect(parseTmePreview(page({
      title: 'Робота в Європі', description: 'Вакансії щодня', image: CDN_IMAGE
    }))).toEqual({
      title: 'Робота в Європі', description: 'Вакансії щодня', imageUrl: CDN_IMAGE
    })
  })

  it('a dead invite is nothing, not a channel called "Join group chat"', () => {
    // Telegram answers an expired or invalid link with a generic invitation
    // page rather than a 404. Taken at face value it would enter the prompt as
    // the destination's real name.
    expect(parseTmePreview(page({
      title: 'Join group chat on Telegram', image: LOGO
    }))).toBeNull()
  })

  it('the placeholder is recognised by its picture, not by its wording', () => {
    // The title is localised; the logo host is not.
    expect(parseTmePreview(page({ title: 'Telegramでグループチャットに参加', image: LOGO })))
      .toBeNull()
  })

  it('a real channel with no picture is still worth reading', () => {
    // Both halves of the placeholder test are required: a live chat that never
    // set a photo also gets the logo, and its title is real.
    expect(parseTmePreview(page({
      title: 'Сусіди', description: 'Чат будинку', image: LOGO
    }))?.title).toBe('Сусіди')
  })

  it('nothing to read is null, never a half-built preview', () => {
    expect(parseTmePreview('<html><head></head></html>')).toBeNull()
    expect(parseTmePreview('')).toBeNull()
    expect(parseTmePreview(page({ description: 'orphan description' }))).toBeNull()
  })

  it('unescapes what Telegram escaped', () => {
    expect(parseTmePreview(page({
      title: 'A &amp; B', description: '&quot;quoted&quot; &lt;tag&gt;', image: CDN_IMAGE
    }))).toMatchObject({ title: 'A & B', description: '"quoted" <tag>' })
  })
})

describe('isTmeUrl', () => {
  it('accepts Telegram\'s own hosts over https and nothing else', () => {
    for (const ok of ['https://t.me/+abc', 'https://telegram.me/x', 'https://www.t.me/y',
      'https://telegram.dog/z']) {
      expect(isTmeUrl(ok), ok).toBe(true)
    }
    for (const no of ['http://t.me/x', 'https://t.me.evil.com/x', 'https://evil.com/t.me',
      'https://example.com', 'file:///etc/passwd', 'not a url', '']) {
      expect(isTmeUrl(no), no).toBe(false)
    }
  })

  it('REGRESSION: a link typed without a scheme is still a link', () => {
    // Telegram's `url` entity carries the text as typed and nobody types the
    // scheme, so this is how invites actually arrive. `classifyUrl` parsed them
    // leniently and called them private invites; the resolver required
    // `new URL()` to succeed and returned null — indistinguishable from a dead
    // link, which is the answer the pipeline then acted on.
    for (const bare of ['t.me/+abc', 'T.ME/joinchat/AAA', 'telegram.me/x', 'www.t.me/y']) {
      expect(isTmeUrl(bare), bare).toBe(true)
      expect(normalizeTmeUrl(bare), bare).toMatch(/^https:\/\//)
    }
    // Leniency about a missing scheme is not leniency about a written one.
    expect(normalizeTmeUrl('http://t.me/x')).toBeNull()
    expect(normalizeTmeUrl('t.me.evil.com/x')).toBeNull()
  })

  it('one destination is one question however it was written', () => {
    expect(normalizeTmeUrl('t.me/x')).toBe(normalizeTmeUrl('https://t.me/x'))
    // Credentials nobody needs for a public page: they would travel in an
    // Authorization header and split one destination across two cache keys.
    expect(normalizeTmeUrl('user:pw@t.me/x')).toBe('https://t.me/x')
    // A fragment is never sent to the server, so it cannot be part of what is
    // being asked — but it did split one destination across two cache keys.
    expect(normalizeTmeUrl('t.me/x#1')).toBe(normalizeTmeUrl('t.me/x#2'))
    // Punctuation the surrounding sentence donated: `t.me/foo),` would have
    // asked Telegram for a path nobody wrote, and read the 404 as "leads
    // nowhere" rather than as "we mangled the link".
    expect(normalizeTmeUrl('t.me/foo),')).toBe('https://t.me/foo')
    expect(normalizeTmeUrl('t.me/wiki_(2024)')).toBe('https://t.me/wiki_(2024)')
  })

  it('the host check is what holds, and it holds under a userinfo @', () => {
    // The authority is where this could go wrong: everything before an `@` is
    // credentials, everything after is the host, so a reader skimming for
    // "t.me" can be fooled where `new URL` cannot.
    expect(normalizeTmeUrl('t.me@evil.example/x')).toBeNull()
    expect(normalizeTmeUrl('//evil.example/x')).toBeNull()
    expect(normalizeTmeUrl('т.me/x'), 'cyrillic т punycodes to another host').toBeNull()
    expect(normalizeTmeUrl('t.me:8080/x'), 'Telegram is on 443 or it is not Telegram').toBeNull()
    expect(normalizeTmeUrl('https://t.me:443/x')).toBe('https://t.me/x')
  })
})

describe('createTmePreviewResolver', () => {
  const ok = (body: string, url = 'https://t.me/x'): Response =>
    ({ ok: true, status: 200, url, text: async () => body } as Response)

  /** A real 3xx with a Location header, which is what Node hands back now. */
  const redirect = (location: string): Response =>
    ({ ok: false, status: 302, headers: { get: () => location } } as unknown as Response)

  /** A body that arrives in pieces and never ends, like a page that will not stop. */
  const streamed = (chunk: string): Response => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      pull (controller) { controller.enqueue(new TextEncoder().encode(chunk)) }
    })
  } as unknown as Response)

  it('never requests anything that is not Telegram', async () => {
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => { called += 1; return ok(page({ title: 'x', image: CDN_IMAGE })) }
    })
    expect(await resolve('https://evil.example/steal')).toBeNull()
    expect(called, 'the allow-list is checked before the request, not after').toBe(0)
  })

  it('the cache key is the destination, not the spelling', async () => {
    // Follows from normalising before the lookup: otherwise the same invite
    // pasted with and without a scheme costs two requests and can hold two
    // different answers.
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => {
        called += 1
        return ok(page({ title: 'Канал', description: 'опис', image: CDN_IMAGE }))
      }
    })
    expect((await resolve('t.me/x'))?.title).toBe('Канал')
    expect((await resolve('https://t.me/x'))?.title).toBe('Канал')
    expect(called).toBe(1)
  })

  it('asks once per link, however many messages carry it', async () => {
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => {
        called += 1
        return ok(page({ title: 'Канал', description: 'опис', image: CDN_IMAGE }))
      }
    })
    expect((await resolve('https://t.me/x'))?.title).toBe('Канал')
    expect((await resolve('https://t.me/x'))?.title).toBe('Канал')
    expect(called).toBe(1)
  })

  it('caches "leads nowhere" too — a dead link stays dead', async () => {
    // Otherwise every repost of the same expired invite is another request, and
    // a moderation path quietly becomes a scraper.
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => { called += 1; return ok(page({ title: 'Join group chat on Telegram', image: LOGO })) }
    })
    expect(await resolve('https://t.me/+dead')).toBeNull()
    expect(await resolve('https://t.me/+dead')).toBeNull()
    expect(called).toBe(1)
  })

  it('a redirect off Telegram is never followed, not merely never read', async () => {
    // The allow-list used to be consulted AFTER `redirect: 'follow'` had
    // already chased the chain, so the destination was contacted and only its
    // content discarded. Each hop is now validated before the connection, which
    // is what `requested` proves: the second URL is never asked for.
    const requested: string[] = []
    const resolve = createTmePreviewResolver({
      fetchImpl: async (input) => {
        requested.push(String(input))
        return String(input).includes('t.me')
          ? redirect('https://elsewhere.example/x')
          : ok(page({ title: 'Payload', image: CDN_IMAGE }))
      }
    })
    expect(await resolve('https://t.me/x')).toBeNull()
    expect(requested).toEqual(['https://t.me/x'])
  })

  it('follows Telegram\'s own redirects, including relative ones', async () => {
    const requested: string[] = []
    const resolve = createTmePreviewResolver({
      fetchImpl: async (input) => {
        requested.push(String(input))
        return String(input).endsWith('/moved')
          ? redirect('/arrived')
          : ok(page({ title: 'Канал', description: 'опис', image: CDN_IMAGE }))
      }
    })
    expect((await resolve('https://t.me/moved'))?.title).toBe('Канал')
    expect(requested).toEqual(['https://t.me/moved', 'https://t.me/arrived'])
  })

  it('a redirect loop ends, and ends as an answer', async () => {
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => { called += 1; return redirect('https://t.me/round') }
    })
    expect(await resolve('https://t.me/round')).toBeNull()
    expect(called, 'bounded by maxRedirects, not by the page giving up').toBe(4)
  })

  it('every failure is an absent answer, never a thrown one', async () => {
    for (const impl of [
      async () => { throw new Error('timeout') },
      async () => ({ ok: false, url: 'https://t.me/x', text: async () => '' } as Response),
      async () => ok('total garbage')
    ]) {
      const resolve = createTmePreviewResolver({ fetchImpl: impl as typeof fetch })
      expect(await resolve('https://t.me/x')).toBeNull()
    }
  })

  it('a burst of askers for one link makes one request', async () => {
    // The cache stops the second ask only once the first has ANSWERED, and the
    // shape this module exists for is fifty messages carrying one link faster
    // than any answer. Each used to open its own connection.
    let called = 0
    let release = (): void => { /* replaced below */ }
    const gate = new Promise<void>((resolve) => { release = resolve })
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => {
        called += 1
        await gate
        return ok(page({ title: 'Канал', description: 'опис', image: CDN_IMAGE }))
      }
    })
    const all = Promise.all(Array.from({ length: 50 }, () => resolve('t.me/x')))
    release()
    expect((await all).every((p) => p?.title === 'Канал')).toBe(true)
    expect(called).toBe(1)
  })

  it('"leads nowhere" is remembered all day; "we could not ask" is not', async () => {
    // Both arrive as null, and conflating them let one momentary rate limit
    // blind the pipeline about every link asked during it for six hours.
    const runs = async (first: () => Promise<Response>) => {
      let called = 0
      let clock = 0
      const resolve = createTmePreviewResolver({
        cacheTtlMs: 60_000,
        errorTtlMs: 1_000,
        now: () => clock,
        fetchImpl: async () => {
          called += 1
          return called === 1 ? await first() : ok(page({ title: 'Канал', description: 'о', image: CDN_IMAGE }))
        }
      })
      expect(await resolve('t.me/x')).toBeNull()
      clock = 5_000 // past the error TTL, nowhere near the answer TTL
      const second = await resolve('t.me/x')
      return { called, second }
    }

    const timedOut = await runs(async () => { throw new Error('ETIMEDOUT') })
    expect(timedOut.called, 'a transport failure is re-asked').toBe(2)
    expect(timedOut.second?.title).toBe('Канал')

    const rateLimited = await runs(async () => ({ ok: false, status: 429 } as Response))
    expect(rateLimited.called, '429 is Telegram saying not now').toBe(2)

    const dead = await runs(async () => ok(page({ title: 'Join group chat', image: LOGO })))
    expect(dead.called, 'a dead invite is a stable fact').toBe(1)

    const gone = await runs(async () => ({ ok: false, status: 404 } as Response))
    expect(gone.called, 'so is a page that is not there').toBe(1)
  })

  it('stops reading a page that will not stop talking', async () => {
    // `response.text()` buffered the whole body before anything could slice it,
    // so `maxBytes` named a string already paid for. This body never ends.
    const resolve = createTmePreviewResolver({
      maxBytes: 4096,
      fetchImpl: async () => streamed(page({ title: 'Канал', description: 'опис', image: CDN_IMAGE }))
    })
    expect((await resolve('t.me/x'))?.title).toBe('Канал')
  })

  it('re-asks once the answer is stale', async () => {
    let called = 0
    let clock = 1_000
    const resolve = createTmePreviewResolver({
      cacheTtlMs: 100,
      now: () => clock,
      fetchImpl: async () => { called += 1; return ok(page({ title: 'K', image: CDN_IMAGE })) }
    })
    await resolve('https://t.me/x')
    clock += 101
    await resolve('https://t.me/x')
    expect(called).toBe(2)
  })
})
