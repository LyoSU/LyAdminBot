/**
 * What a t.me link leads to, read from Telegram's own public web preview.
 *
 * Why the web and not MTProto: a bot account cannot call
 * `messages.checkChatInvite`, so for a private invite there is no API route to
 * the destination at all — and a private invite is the commonest shape spam
 * takes here. The same page also answers for public channels without spending
 * a `contacts.resolveUsername`, which is the call that earned a 46-minute
 * FLOOD_WAIT in production and stalls the shared connection while it lasts.
 *
 * What this buys, concretely: `private_invite_new` punished the SHAPE of a
 * link, because the shape was all anything could see — on 2026-08-01 it muted
 * somebody for pasting an invite into a conversation that had asked for one.
 * Reading the destination replaces a guess about form with a fact about where
 * it goes, in both directions: an advert behind the link is evidence, and an
 * ordinary community behind it is the reason not to act.
 *
 * IO is kept behind `createTmePreviewResolver` so the brittle part — Telegram's
 * markup, and the placeholder it serves for links that resolve to nothing — is
 * a pure function with tests.
 */

/** Hosts whose pages this module will fetch. Nothing else is ever requested. */
const TME_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog'])

export interface TmePreview {
  title: string
  description: string | null
  imageUrl: string | null
}

const META_REGEX = /<meta\s+property="og:(title|description|image)"\s+content="([^"]*)"/gi

/** Minimal entity decode — Telegram escapes these five in `content`. */
const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Telegram answers a dead or expired link with a generic invitation page rather
 * than a 404: a localised "Join group chat on Telegram", an empty description
 * and the Telegram logo served from telegram.org. A live chat's picture always
 * comes from the CDN, so the pair "logo host + no description" identifies the
 * placeholder without depending on the wording, which is translated.
 *
 * Both conditions are required. A real channel that has no photo also gets the
 * logo, and its title is worth reading.
 */
const isPlaceholder = (title: string, description: string | null, imageUrl: string | null): boolean =>
  description === null && imageUrl !== null && /^https?:\/\/(?:[a-z0-9-]+\.)*telegram\.org\//i.test(imageUrl) &&
  title.length > 0

export const parseTmePreview = (html: string): TmePreview | null => {
  let title = ''
  let description: string | null = null
  let imageUrl: string | null = null
  for (const [, key, raw] of html.matchAll(META_REGEX)) {
    const value = decode(raw ?? '').trim()
    if (value.length === 0) continue
    if (key === 'title') title = value
    else if (key === 'description') description = value
    else if (key === 'image') imageUrl = value
  }
  if (title.length === 0) return null
  if (isPlaceholder(title, description, imageUrl)) return null
  return { title, description, imageUrl }
}

/** True for a URL this module is willing to fetch. */
export const isTmeUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' &&
      TME_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ''))
  } catch {
    return false
  }
}

export interface TmeResolverOptions {
  /** Abort a page that has not answered. Telegram is fast or it is rate-limiting. */
  timeoutMs?: number
  /** Stop reading past this. The preview lives in the first few kilobytes. */
  maxBytes?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const DEFAULTS = {
  timeoutMs: 4000,
  maxBytes: 64 * 1024,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  maxCacheEntries: 2000
}

interface CacheEntry { preview: TmePreview | null; expiresAt: number }

/**
 * A cached, bounded, t.me-only GET.
 *
 * `null` covers every unhappy path — not a t.me link, timeout, non-200,
 * unparseable, placeholder — and is cached like any other answer. A link that
 * leads nowhere is a stable fact, and re-asking on every message is how a
 * moderation path turns into a scraper.
 */
export const createTmePreviewResolver = (options: TmeResolverOptions = {}) => {
  const opts = { ...DEFAULTS, ...options }
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()

  const prune = (): void => {
    const t = now()
    for (const [key, entry] of cache) if (entry.expiresAt <= t) cache.delete(key)
    for (const key of cache.keys()) {
      if (cache.size <= opts.maxCacheEntries) break
      cache.delete(key)
    }
  }

  return async (url: string): Promise<TmePreview | null> => {
    if (!isTmeUrl(url)) return null
    const cached = cache.get(url)
    if (cached && cached.expiresAt > now()) return cached.preview

    let preview: TmePreview | null = null
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, opts.timeoutMs)
    try {
      const response = await doFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'text/html' }
      })
      // A redirect that leaves Telegram is not something to read or to follow
      // the content of — the URL we were given is the only thing vouched for.
      if (response.ok && isTmeUrl(response.url || url)) {
        const body = await response.text()
        preview = parseTmePreview(body.slice(0, opts.maxBytes))
      }
    } catch {
      preview = null // timeout, DNS, rate limit — the stage simply has no answer
    } finally {
      clearTimeout(timer)
    }

    prune()
    cache.set(url, { preview, expiresAt: now() + opts.cacheTtlMs })
    return preview
  }
}
