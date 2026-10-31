import { describe, expect, it } from 'vitest'
import { sniffImageMime } from './image-mime.js'

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

describe('sniffImageMime', () => {
  it('recognises webp, png and gif', () => {
    expect(sniffImageMime(b64([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), 1, 2]))).toBe('image/webp')
    expect(sniffImageMime(b64([0x89, ...ascii('PNG'), 0x0d, 0x0a]))).toBe('image/png')
    expect(sniffImageMime(b64([...ascii('GIF89a'), 0, 0]))).toBe('image/gif')
  })

  it('defaults to jpeg for jpeg and for anything unknown', () => {
    expect(sniffImageMime(b64([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime('')).toBe('image/jpeg')
    expect(sniffImageMime('!!!not base64')).toBe('image/jpeg')
  })
})
