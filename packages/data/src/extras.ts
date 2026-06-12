/**
 * Custom hashtag triggers ("extras"). An admin saves a message under a name;
 * anyone using `#name` replays it. Pure helpers here; storage + sending live
 * in the store / bot layer.
 *
 * Two storage shapes are read transparently:
 *  - v2: { name, text, fileId }              — what v2 writes
 *  - v1: { name, type, message }             — telegraf payload (Bot API
 *        file ids, which mtcute's sendMedia also accepts) so existing prod
 *        extras keep working after cutover.
 */
export interface NormalizedExtra {
  name: string
  text: string
  fileId: string | null
}

const HASHTAG_REGEX = /#([\p{L}\p{N}_]+)/gu

/** Hashtag names in order of appearance, without the leading #. */
export const parseHashtags = (text: string): string[] => {
  const names: string[] = []
  for (const m of text.matchAll(HASHTAG_REGEX)) {
    if (m[1]) names.push(m[1])
  }
  return names
}

/** Normalize either storage shape into a single re-sendable form. */
export const normalizeExtra = (raw: unknown): NormalizedExtra | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r['name'] === 'string' ? r['name'] : null
  if (!name) return null

  // v2 shape.
  if (typeof r['text'] === 'string' || 'fileId' in r) {
    return { name, text: typeof r['text'] === 'string' ? r['text'] : '', fileId: typeof r['fileId'] === 'string' ? r['fileId'] : null }
  }

  // v1 telegraf shape: { type, message }.
  const type = typeof r['type'] === 'string' ? r['type'] : null
  const message = (r['message'] && typeof r['message'] === 'object') ? r['message'] as Record<string, unknown> : null
  if (!message) return null
  const text = typeof message['text'] === 'string' ? message['text']
    : typeof message['caption'] === 'string' ? message['caption'] : ''
  // The media file id lives under the field named after the media type.
  const media = type && type !== 'text' ? message[type] : null
  const fileId = typeof media === 'string' ? media : null
  return { name, text, fileId }
}

/**
 * Resolve the extras triggered by a message's hashtags, in order, capped at
 * maxExtra. Names match case-insensitively (v1 semantics).
 */
export const matchExtras = (
  text: string,
  extras: NormalizedExtra[],
  maxExtra: number
): NormalizedExtra[] => {
  const byName = new Map(extras.map((e) => [e.name.toLowerCase(), e]))
  const out: NormalizedExtra[] = []
  for (const tag of parseHashtags(text)) {
    if (out.length >= maxExtra) break
    const hit = byName.get(tag.toLowerCase())
    if (hit) out.push(hit)
  }
  return out
}
