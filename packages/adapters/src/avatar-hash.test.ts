import { describe, expect, it, beforeEach } from 'vitest'
import jpeg from 'jpeg-js'
import { dhash } from '@lyadmin/core'
import {
  avatarDhashOf, avatarDhashCacheSize, resetAvatarDhashCache, decodeImageBase64
} from './image-decode.js'

/** A JPEG with structure, so its hash is not degenerate. */
const jpegOf = (seed: number, size = 64): Buffer => {
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const v = (x * seed + y * 13) % 251
      data[i] = v
      data[i + 1] = (v * 3) % 251
      data[i + 2] = (v * 7) % 251
      data[i + 3] = 255
    }
  }
  return Buffer.from(jpeg.encode({ data, width: size, height: size }, 80).data)
}

/**
 * Trailing bytes after a JPEG's end marker are ignored by every decoder, which
 * is what lets a test make two DIFFERENT pictures the same number of bytes —
 * the exact collision the old cache key could not tell apart.
 */
const padTo = (buf: Buffer, length: number): Buffer =>
  buf.length >= length ? buf : Buffer.concat([buf, Buffer.alloc(length - buf.length)])

describe('avatarDhashOf', () => {
  beforeEach(() => { resetAvatarDhashCache() })

  it('agrees with hashing the picture directly', () => {
    const b64 = jpegOf(5).toString('base64')
    const direct = dhash(decodeImageBase64(b64)!)
    expect(avatarDhashOf(b64)).toBe(direct)
  })

  it('memoises: the second call for the same bytes adds no entry', () => {
    const b64 = jpegOf(5).toString('base64')
    avatarDhashOf(b64)
    avatarDhashOf(b64)
    expect(avatarDhashCacheSize()).toBe(1)
  })

  /**
   * The regression this module was extracted for.
   *
   * The cache was first keyed by `length + first 64 base64 characters`. Those
   * 64 characters are the first 48 BYTES of a JPEG — SOI plus the JFIF header —
   * and this test asserts what production proves: two unrelated pictures
   * encoded by one encoder share them exactly. Equalise the lengths and the old
   * key becomes identical for two different photographs, so the second account
   * to be looked up receives the FIRST account's hash — and is then recorded in
   * the shared-picture store as wearing a photograph it has never seen.
   *
   * That is not a missed match. It is a fabricated one, carrying
   * `avatar_shared_with_accounts`: evidence, weight 1.8, against two strangers.
   */
  it('does not confuse two pictures that share a header and a length', () => {
    const a = jpegOf(5)
    const b = jpegOf(31)
    const length = Math.max(a.length, b.length)
    const aB64 = padTo(a, length).toString('base64')
    const bB64 = padTo(b, length).toString('base64')

    // The premise, asserted rather than assumed: the old key really did collide.
    expect(aB64.length).toBe(bB64.length)
    expect(aB64.slice(0, 64)).toBe(bB64.slice(0, 64))

    const hashA = avatarDhashOf(aB64)
    const hashB = avatarDhashOf(bB64)
    expect(hashA).not.toBeNull()
    expect(hashA).not.toBe(hashB)
    // Both were computed, not one served from the other's entry.
    expect(avatarDhashCacheSize()).toBe(2)
  })

  it('remembers a refusal, so undecodable bytes are not decoded twice', () => {
    const junk = Buffer.from('not a picture at all, not even close').toString('base64')
    expect(avatarDhashOf(junk)).toBeNull()
    expect(avatarDhashOf(junk)).toBeNull()
    expect(avatarDhashCacheSize()).toBe(1)
  })

  it('gives the same answer for the same bytes across an eviction', () => {
    const b64 = jpegOf(7).toString('base64')
    const first = avatarDhashOf(b64)
    resetAvatarDhashCache()
    expect(avatarDhashOf(b64)).toBe(first)
  })
})
