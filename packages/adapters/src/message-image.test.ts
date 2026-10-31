import { describe, expect, it } from 'vitest'
import { downloadMessageImage, downloadMessageImageBase64, pickMessageImage } from './enrich.js'

describe('pickMessageImage', () => {
  const thumb = (type: string, w: number, h: number, isVideo = false) => ({ type, width: w, height: h, isVideo })
  const cap = 1000

  it('takes a photo whole', () => {
    expect(pickMessageImage({ type: 'photo' }, cap)).toEqual({ kind: 'file' })
  })

  it('takes a static sticker whole', () => {
    expect(pickMessageImage({ type: 'sticker', sourceType: 'static', mimeType: 'image/webp', fileSize: 10 }, cap))
      .toEqual({ kind: 'file' })
  })

  it('falls back to a thumbnail for an oversized static sticker', () => {
    const media = {
      type: 'sticker', sourceType: 'static', mimeType: 'image/webp', fileSize: 5000,
      thumbnails: [thumb('m', 320, 320)]
    }
    expect(pickMessageImage(media, cap)).toEqual({ kind: 'thumbnail', index: 0 })
  })

  it('uses the largest still thumbnail for animated and video stickers, GIFs and videos', () => {
    const thumbnails = [thumb('i', 40, 40), thumb('s', 100, 100), thumb('j', 0, 0), thumb('v', 400, 400, true), thumb('m', 320, 320)]
    for (const media of [
      { type: 'sticker', sourceType: 'animated', mimeType: 'application/x-tgsticker', thumbnails },
      { type: 'sticker', sourceType: 'video', mimeType: 'video/webm', thumbnails },
      { type: 'video', mimeType: 'video/mp4', thumbnails },
      { type: 'video', mimeType: 'image/gif', thumbnails }
    ]) {
      expect(pickMessageImage(media, cap)).toEqual({ kind: 'thumbnail', index: 4 })
    }
  })

  it('has nothing to show for a bare strip or outline, or for kinds with no picture', () => {
    expect(pickMessageImage({ type: 'sticker', sourceType: 'animated', thumbnails: [thumb('i', 40, 40), thumb('j', 0, 0)] }, cap)).toBeNull()
    expect(pickMessageImage({ type: 'video' }, cap)).toBeNull()
    expect(pickMessageImage({ type: 'audio' }, cap)).toBeNull()
    expect(pickMessageImage({ type: 'voice' }, cap)).toBeNull()
    expect(pickMessageImage(null, cap)).toBeNull()
  })
})

describe('downloadMessageImageBase64', () => {
  type Tg = Parameters<typeof downloadMessageImageBase64>[0]
  type Media = Parameters<typeof downloadMessageImageBase64>[1]
  const tgReturning = (result: Uint8Array | Error, seen: unknown[] = []) => ({
    downloadAsBuffer: async (loc: unknown) => {
      seen.push(loc)
      if (result instanceof Error) throw result
      return result
    }
  }) as unknown as Tg

  const animated = {
    type: 'sticker', sourceType: 'animated',
    thumbnails: [{ type: 'm', width: 320, height: 320, isVideo: false }]
  } as unknown as Media

  it('downloads the chosen thumbnail and returns base64', async () => {
    const seen: unknown[] = []
    const out = await downloadMessageImageBase64(tgReturning(new Uint8Array([1, 2, 3]), seen), animated)
    expect(out).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    expect(seen[0]).toBe((animated as unknown as { thumbnails: unknown[] }).thumbnails[0])
  })

  // What the check actually looked at goes on the decision: a thumbnail of an
  // animated sticker can be too small to read, and only this says so afterwards.
  it('names the picture it took — whole file or which thumbnail', async () => {
    const thumb = await downloadMessageImage(tgReturning(new Uint8Array([1])), animated)
    expect(thumb?.source).toBe('sticker:thumb:320x320')
    const still = { type: 'sticker', sourceType: 'static', mimeType: 'image/webp', fileSize: 1000 } as unknown as Media
    const whole = await downloadMessageImage(tgReturning(new Uint8Array([1])), still)
    expect(whole?.source).toBe('sticker:file')
  })

  it('returns null over the byte cap', async () => {
    expect(await downloadMessageImageBase64(tgReturning(new Uint8Array(11)), animated, 10)).toBeNull()
  })

  it('returns null, never throws, when the download fails', async () => {
    expect(await downloadMessageImageBase64(tgReturning(new Error('FILE_REFERENCE_EXPIRED')), animated)).toBeNull()
  })

  it('does not download for a kind with no image', async () => {
    const seen: unknown[] = []
    const media = { type: 'audio' } as unknown as Media
    expect(await downloadMessageImageBase64(tgReturning(new Uint8Array([1]), seen), media)).toBeNull()
    expect(seen).toEqual([])
  })
})
