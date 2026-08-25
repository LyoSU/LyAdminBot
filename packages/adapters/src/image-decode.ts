/**
 * Turning downloaded profile-picture bytes into pixels for `dhash`.
 *
 * Kept out of core deliberately: the hash is exact integer arithmetic that must
 * give the same answer forever, and belongs with the other pure logic. Decoding
 * is format handling with a third-party dependency and hostile input, and
 * belongs out here with the rest of the IO.
 *
 * `jpeg-js` rather than sharp: Telegram profile photos are JPEG, and a pure-JS
 * decoder needs no native build for a bot that already ships as a plain Node
 * image. The cost is speed, which does not matter — this runs once per sender
 * per few days, behind the same avatar cache the NSFW check uses, on bytes
 * already in memory.
 *
 * JPEG only, therefore, and that is a statement about the source rather than a
 * shortcut: photos downloaded through MTProto are JPEG. (A t.me profile PAGE
 * serves a PNG placeholder for accounts with no public photo — noticed while
 * sampling avatars on 2026-08-25 — but that is a web surface this bot never
 * reads pictures from.) Anything else returns null, which every caller already
 * treats as "no answer".
 */
import { createHash } from 'node:crypto'
import jpeg from 'jpeg-js'
import { dhash, type RgbaImage } from '@lyadmin/core'

/**
 * Widest image we will decode, in pixels of output.
 *
 * A decoder allocates width × height × 4 bytes before anything else looks at
 * the picture, so an attacker-supplied header claiming 30000×30000 is a 3.6 GB
 * allocation from a 2 KB file — the classic decompression bomb. Profile photos
 * are at most 800×800; the ceiling is generous against that and still small.
 */
const MAX_PIXELS = 4096 * 4096

/**
 * Decode JPEG bytes to RGBA, or null if they are not a picture we can read.
 *
 * Null on every failure and never a throw: this sits on the moderation path,
 * where the rule everywhere else is that a port which cannot answer degrades to
 * "no answer". A corrupt avatar must cost the sender nothing and must not cost
 * the chat its moderation.
 */
export const decodeImage = (bytes: Uint8Array | Buffer): RgbaImage | null => {
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    // `maxMemoryUsageInMB` is the library's own bomb guard; the explicit pixel
    // check below covers the case where it is generous enough to allow a
    // picture too large to be a profile photo.
    const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 })
    if (!raw || !raw.data) return null
    if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)) return null
    if (raw.width <= 0 || raw.height <= 0) return null
    if (raw.width * raw.height > MAX_PIXELS) return null
    // The decoder is documented to emit RGBA; verify rather than trust, because
    // a shorter buffer would make `dhash` read past the end of a row.
    if (raw.data.length < raw.width * raw.height * 4) return null
    return { width: raw.width, height: raw.height, data: raw.data }
  } catch {
    return null
  }
}

/** Decode base64 image bytes — the form the avatar already travels in. */
export const decodeImageBase64 = (base64: string): RgbaImage | null => {
  if (base64.length === 0) return null
  try {
    return decodeImage(Buffer.from(base64, 'base64'))
  } catch {
    return null
  }
}

/**
 * Perceptual hash of an avatar, memoised on the bytes it came from.
 *
 * Decoding a JPEG in pure JS is the most expensive thing on the enrichment
 * path, and the avatar cache in the app layer already hands us the same bytes
 * for the same sender for hours — so memoising is worth real latency.
 *
 * ── The key, which is the whole point of this cache existing here ──
 *
 * A cost cache is allowed to forget. It is not allowed to answer WRONGLY.
 *
 * The first version of this cache, in the composition root, keyed entries by
 * `length + first 64 base64 characters`. That is the 2026-02 hash-collapse
 * defect in its sharpest form: the first 64 base64 characters are the first 48
 * bytes of a JPEG — SOI plus the JFIF header — and Telegram re-encodes every
 * profile photo through one encoder, so those bytes are IDENTICAL across
 * avatars. The key collapsed to the file length alone, and two unrelated people
 * whose avatars happened to encode to the same number of bytes were handed each
 * other's hash.
 *
 * Downstream that is not a missed match but a MANUFACTURED one: the second
 * account is written into the shared-picture store under the first account's
 * hash, and both are then told they wear one photograph — which is
 * `avatar_shared_with_accounts`: evidence, weight 1.8, on two strangers.
 *
 * A digest of the whole content is the only key that can promise otherwise.
 * SHA-1 over a hundred kilobytes costs a fraction of a millisecond against the
 * tens of milliseconds the decode costs, so the optimisation survives intact.
 */
const DHASH_CACHE_MAX = 2000
const dhashCache = new Map<string, string | null>()

export const avatarDhashOf = (base64: string): string | null => {
  const key = createHash('sha1').update(base64).digest('hex')
  const hit = dhashCache.get(key)
  if (hit !== undefined) return hit
  const image = decodeImageBase64(base64)
  const hash = image === null ? null : dhash(image)
  if (dhashCache.size >= DHASH_CACHE_MAX) {
    // Coarse eviction: this is a cost cache, not a correctness one.
    for (const k of dhashCache.keys()) {
      dhashCache.delete(k)
      if (dhashCache.size < DHASH_CACHE_MAX / 2) break
    }
  }
  dhashCache.set(key, hash)
  return hash
}

/** Entries currently memoised. Tests only. */
export const avatarDhashCacheSize = (): number => dhashCache.size

/** Drop everything memoised. Tests only. */
export const resetAvatarDhashCache = (): void => { dhashCache.clear() }
