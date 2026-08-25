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

import { trimUrlPunctuation } from '@lyadmin/core'

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

/**
 * The absolute https URL this module would fetch for a link token, or null for
 * anything it refuses to request.
 *
 * Lenient about the scheme, strict about the host — and the leniency is a fix
 * rather than a convenience. Telegram's `url` entity carries the text as typed,
 * and nobody types the scheme: a message containing `t.me/+…` reaches us as
 * exactly that. `classifyUrl` parses such a token leniently and happily called
 * it a private invite, so the call site selected the link and then handed it to
 * a resolver that required `new URL()` to succeed — which it cannot without a
 * scheme. Every scheme-less invite in a message therefore resolved to `null`
 * and was read as "leads nowhere", silently, since that is also what a dead
 * link returns.
 *
 * `http://` stays refused rather than upgraded: a scheme that was written down
 * is a statement, and the only reason to write that one is to be downgraded.
 */
export const normalizeTmeUrl = (raw: string): string | null => {
  const trimmed = trimUrlPunctuation(raw.trim())
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') return null
    if (!TME_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ''))) return null
    // Telegram answers on 443 and nowhere else, so a written port can only be
    // somebody's idea rather than a destination. `:443` normalises away by
    // itself and is indistinguishable from having written none.
    if (url.port !== '') return null
    // `user@t.me/x` still lands on t.me — the host check is what stops SSRF, and
    // it holds — but it would put an arbitrary string in an Authorization header
    // and split the cache in two for one destination. Nothing here needs to
    // authenticate to a public page.
    url.username = ''
    url.password = ''
    // A fragment is never sent to the server, so two links differing only by
    // one are one question — and were two cache entries and two requests.
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** True for a URL this module is willing to fetch. */
export const isTmeUrl = (raw: string): boolean => normalizeTmeUrl(raw) !== null

export interface TmeResolverOptions {
  /** Abort a page that has not answered. Telegram is fast or it is rate-limiting. */
  timeoutMs?: number
  /** Stop reading past this. The preview lives in the first few kilobytes. */
  maxBytes?: number
  cacheTtlMs?: number
  /** How long a failure to ASK is remembered. See `errorTtlMs` in DEFAULTS. */
  errorTtlMs?: number
  maxCacheEntries?: number
  /** Telegram's own redirects, followed by hand. Deeper than this is a loop. */
  maxRedirects?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const DEFAULTS = {
  timeoutMs: 4000,
  maxBytes: 64 * 1024,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  /**
   * A minute, against six hours for an answer — because the two are different
   * facts wearing the same `null`.
   *
   * "This link leads nowhere" is stable and worth remembering all day. "We
   * could not reach Telegram" is a statement about us, and caching it for six
   * hours turns a momentary rate limit into six hours of blindness about every
   * link asked during it — the outage amplifying its own effect on moderation.
   * The retry storm that long TTL was guarding against is handled properly
   * below, by coalescing concurrent askers into one request.
   */
  errorTtlMs: 60 * 1000,
  maxCacheEntries: 2000,
  maxRedirects: 3
}

interface CacheEntry { preview: TmePreview | null; expiresAt: number }

/** What one attempt at a page produced, and whether it got that far. */
interface Reading {
  preview: TmePreview | null
  /** False only when the page could not be reached: timeout, refusal, 5xx. */
  answered: boolean
}

/**
 * The first `maxBytes` of a response and not a byte more.
 *
 * `response.text()` buffers the WHOLE body before anything can slice it, so the
 * cap named a string that had already been paid for in memory and bandwidth.
 * Telegram puts the preview in the first few kilobytes; a page still talking
 * past that is not answering this question.
 */
const readBounded = async (response: Response, maxBytes: number): Promise<string> => {
  const body = response.body
  if (!body) return (await response.text()).slice(0, maxBytes)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        size += value.byteLength
      }
    }
  } finally {
    // Hangs up on a page that would keep going; already-closed is not an error.
    await reader.cancel().catch(() => { /* nothing left to cancel */ })
  }
  const buffer = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    buffer.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(buffer).slice(0, maxBytes)
}

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

  /**
   * One page, with Telegram's own redirects followed BY HAND.
   *
   * `redirect: 'follow'` let fetch chase the chain and only then compared
   * `response.url` against the allow-list — so the check that the destination
   * is still Telegram happened after the request to wherever the redirect
   * pointed had already been made. Should any t.me path ever become an open
   * redirect, the allow-list would be inspecting a page it had just fetched.
   * Validating each hop puts the list back in front of the connection.
   */
  const read = async (start: string): Promise<Reading> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, opts.timeoutMs)
    try {
      let url = start
      for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
        const response = await doFetch(url, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { accept: 'text/html' }
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          const next = location === null
            ? null
            : normalizeTmeUrl(new URL(location, url).toString())
          // A redirect off Telegram is neither followed nor read: the URL we
          // were handed is the only one vouched for. That is an ANSWER — the
          // link goes somewhere we will not look — not a failure to ask.
          if (next === null) return { preview: null, answered: true }
          url = next
          continue
        }
        if (!response.ok) {
          // 404 is the page saying there is nothing there. 429 and 5xx are it
          // saying not now, which is a fact about Telegram and not about the
          // link, and must not be remembered for six hours.
          return { preview: null, answered: response.status !== 429 && response.status < 500 }
        }
        return {
          preview: parseTmePreview(await readBounded(response, opts.maxBytes)),
          answered: true
        }
      }
      // Going in circles is the page's answer, not a transport failure.
      return { preview: null, answered: true }
    } catch {
      return { preview: null, answered: false } // timeout, DNS, connection reset
    } finally {
      clearTimeout(timer)
    }
  }

  /** Asks in progress, so that N askers of one URL make one request. */
  const inFlight = new Map<string, Promise<TmePreview | null>>()

  return async (raw: string): Promise<TmePreview | null> => {
    // Normalised once, then used as both the request and the cache key, so
    // `t.me/x` and `https://t.me/x` are one question rather than two.
    const url = normalizeTmeUrl(raw)
    if (url === null) return null
    const cached = cache.get(url)
    if (cached && cached.expiresAt > now()) return cached.preview

    // The cache only stops the SECOND ask once the first has answered, and the
    // shape this module exists for is a burst: one link in fifty messages
    // arriving faster than any answer. Each of those used to open its own
    // connection, which is how a moderation path turns into a scraper the one
    // time it matters most.
    const pending = inFlight.get(url)
    if (pending) return pending

    const task = read(url).then(({ preview, answered }) => {
      prune()
      cache.set(url, {
        preview,
        expiresAt: now() + (answered ? opts.cacheTtlMs : opts.errorTtlMs)
      })
      return preview
    }).finally(() => { inFlight.delete(url) })

    inFlight.set(url, task)
    return task
  }
}
