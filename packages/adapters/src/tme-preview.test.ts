import { describe, expect, it } from 'vitest'
import { createTmePreviewResolver, isTmeUrl, parseTmePreview } from './tme-preview.js'

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
})

describe('createTmePreviewResolver', () => {
  const ok = (body: string, url = 'https://t.me/x'): Response =>
    ({ ok: true, url, text: async () => body } as Response)

  it('never requests anything that is not Telegram', async () => {
    let called = 0
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => { called += 1; return ok(page({ title: 'x', image: CDN_IMAGE })) }
    })
    expect(await resolve('https://evil.example/steal')).toBeNull()
    expect(called, 'the allow-list is checked before the request, not after').toBe(0)
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

  it('a link that redirects off Telegram is not read', async () => {
    const resolve = createTmePreviewResolver({
      fetchImpl: async () => ok(page({ title: 'Payload', image: CDN_IMAGE }), 'https://elsewhere.example/x')
    })
    expect(await resolve('https://t.me/x')).toBeNull()
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
