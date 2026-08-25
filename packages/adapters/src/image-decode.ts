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
import jpeg from 'jpeg-js'
import type { RgbaImage } from '@lyadmin/core'

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
