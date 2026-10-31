/**
 * The MIME type of base64 image bytes, from their magic numbers.
 *
 * Message pictures are no longer always JPEG: a static sticker is webp, and the
 * data URL handed to a vision or moderation endpoint should say so rather than
 * claim jpeg for everything. Unknown content keeps the historical jpeg label.
 */
export const sniffImageMime = (base64: string): string => {
  try {
    const head = Buffer.from(base64.slice(0, 24), 'base64')
    if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      return 'image/webp'
    }
    if (head.length >= 4 && head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'image/png'
    if (head.length >= 4 && head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  } catch {
    // fall through to the default
  }
  return 'image/jpeg'
}
