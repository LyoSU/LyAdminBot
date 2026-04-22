/**
 * Perceptual image hash (dhash) using sharp.
 *
 * Why dhash and not phash:
 *   - dhash (difference hash) is ~10x faster to compute than full-DCT phash,
 *     gives a stable 64-bit fingerprint that's robust to JPEG recompression,
 *     resizing, colour adjustments, and small cropping.
 *   - phash has slightly better precision against heavy edits, but the cost
 *     difference matters at our message volume.
 *
 * Algorithm (standard dhash, 8x8 output):
 *   1. Download + decode the image (sharp handles JPEG/PNG/WebP/GIF).
 *   2. Resize to 9x8 greyscale.
 *   3. For each row, compare adjacent pixel pairs (0<1?, 1<2?, … 7<8?).
 *      That's 8 bits per row × 8 rows = 64 bits.
 *   4. Concatenate bits → 16-hex-char string.
 *
 * Properties:
 *   - Identical image: Hamming distance 0
 *   - JPEG recompressed: typically 0-4 bits diff
 *   - Resized: typically 0-2 bits diff (dhash is resolution-invariant)
 *   - Cropped ~10% edge: typically 4-8 bits diff
 *   - Unrelated images: typically 28-36 bits (near random)
 *
 * Threshold for "same image": <= 10 bits Hamming distance. Higher-noise
 * sources (random web compression) may need 12-14; we default conservatively.
 *
 * Size / perf: a 9x8 resize + raw read costs ~3-5ms on 1MB JPEG on a
 * modern CPU. Cheap enough to run on every media message. Downloading is
 * the actual bottleneck — caller is expected to call sparingly.
 */

const sharp = require('sharp')

const IMAGE_HASH_BITS = 64

/**
 * Compute dhash of an image buffer. Returns a 16-hex-character string
 * (64 bits) on success, null on failure (non-image, corrupt, etc.).
 *
 * @param {Buffer} buffer  Raw image bytes
 * @returns {Promise<string|null>}
 */
const dhash = async (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  try {
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== 9 || info.height !== 8) return null

    // Compare adjacent pixel pairs per row → 8 bits per row × 8 rows
    let bits = ''
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = data[y * 9 + x]
        const right = data[y * 9 + x + 1]
        bits += (left < right) ? '1' : '0'
      }
    }
    // Convert 64 bits → 16 hex chars
    let hex = ''
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.substr(i, 4), 2).toString(16)
    }
    return hex
  } catch (_err) {
    return null
  }
}

/**
 * Hamming distance between two 16-hex-char dhash strings.
 * Returns -1 for invalid inputs so callers can distinguish "unknown" from
 * "very different" (which would be up to 64).
 */
const hammingDistance = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return -1
  if (a.length !== b.length) return -1
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    if (!Number.isFinite(x)) return -1
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1)
  }
  return d
}

/**
 * Convenience: "is this hash a near-duplicate of the reference hash?"
 * Default threshold 10 bits — errs on the side of false negatives (missing
 * matches) rather than false positives (wrong grouping).
 */
const isNearDuplicate = (a, b, maxDistance = 10) => {
  const d = hammingDistance(a, b)
  if (d < 0) return false
  return d <= maxDistance
}

/**
 * Download an image by Telegram file_id and compute its dhash.
 * Best-effort: returns null on any network / decode failure. Callers
 * should NEVER treat a null result as a match.
 *
 * @param {Object} telegram  telegraf telegram client (ctx.telegram)
 * @param {string} fileId    Telegram file_id
 * @returns {Promise<string|null>}
 */
const dhashFromFileId = async (telegram, fileId) => {
  if (!telegram || !fileId) return null
  try {
    const link = await telegram.getFileLink(fileId)
    const url = typeof link === 'string' ? link : (link && link.href)
    if (!url) return null
    // node-fetch lives inside telegraf's deps; but to avoid pulling a new
    // dep we use the built-in https/http.
    const buf = await downloadBuffer(url)
    if (!buf) return null
    return await dhash(buf)
  } catch (_err) {
    return null
  }
}

// Minimal HTTPS downloader with hard timeouts. Kept internal to avoid
// adding a new npm dep; `got` is already a project dep but is heavier
// and locks onto specific versions.
const https = require('https')
const http = require('http')

const downloadBuffer = (url, { timeoutMs = 10000, maxBytes = 4 * 1024 * 1024 } = {}) => {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https:') ? https : http
      const req = client.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(null)
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            req.destroy()
            resolve(null)
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        resolve(null)
      })
    } catch (_err) {
      resolve(null)
    }
  })
}

module.exports = {
  dhash,
  hammingDistance,
  isNearDuplicate,
  dhashFromFileId,
  IMAGE_HASH_BITS
}
