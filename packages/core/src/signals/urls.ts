/**
 * URL classification for spam signals.
 *
 * Spam-relevant URL classes, ordered by precision observed in production:
 * private invite links and bot deeplinks from low-history accounts are the
 * strongest promo markers; shorteners hide destinations; plain telegram
 * profile/channel links are mostly benign (internal).
 */

export type UrlKind =
  | 'private_invite'    // t.me/+HASH, t.me/joinchat/...
  | 'bot_deeplink'      // t.me/xxxbot?start=payload
  | 'telegram_internal' // t.me/username, t.me/channel/123
  | 'shortener'         // bit.ly, tinyurl, ...
  | 'messenger_contact' // wa.me/..., viber deep links
  | 'external'          // everything else

export interface ClassifiedUrl {
  kind: UrlKind
  host: string
}

/**
 * URL-ish tokens in free text: scheme URLs, t.me/telegram links, or bare
 * host(/path) like "yuri.ly" / "telegra.ph/x". Case-insensitive and global,
 * so callers must use `.match()` (or reset `lastIndex`) — never `.test()`,
 * which would advance the shared regex state between calls.
 */
export const URL_TOKEN_REGEX =
  /(?:https?:\/\/\S+|(?:t|telegram)\.me\/\S+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/\S*)?)/gi

/** URL classes that carry promo intent (a plain telegram profile link does not). */
export const PROMO_URL_KINDS = new Set<UrlKind>([
  'private_invite', 'bot_deeplink', 'shortener', 'messenger_contact', 'external'
])

const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog'])

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'goo.gl', 'tinyurl.com', 't.co', 'cutt.ly', 'is.gd', 'rb.gy',
  'clck.ru', 'vk.cc', 'shorturl.at', 'rebrand.ly', 'tiny.cc', 'lnk.to',
  'qps.ru', 'u.to', 'kortlink.dk', 'surl.li', 'choko.link'
])

const MESSENGER_CONTACT_HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'viber.click'])

/** Parse leniently: messages contain scheme-less and mixed-case URLs. */
const parse = (raw: string): URL | null => {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

/**
 * Whether two URLs land the reader in the same place.
 *
 * Exists because "the visible text is not byte-identical to the target" is not
 * the question `hidden_url` means to ask. That signal asserts DECEPTION — the
 * text advertises one destination and the click goes to another — and it carries
 * weight 2.0 plus a deterministic kick, with no stage reading the message. So on
 * 2026-07-31 a trailing slash was enough: production kicked a post whose link
 * markup differed from its visible URL by one character.
 *
 * Host and path decide, because that is what "where you land" means. Scheme,
 * `www.`, letter case and a trailing slash are spelling. The query is ignored
 * too: a tracking parameter added to the same page is not a different page, and
 * the one query that does change a destination — a bot's `?start=` payload — has
 * its own signal already.
 */
export const sameDestination = (a: string, b: string): boolean => {
  const at = parse(a.trim())
  const bt = parse(b.trim())
  // Unparseable on either side: fall back to comparing what we were given, so a
  // visible string that is not really a URL cannot silently count as a match.
  if (!at || !bt) return a.trim() === b.trim()

  const key = (u: URL): string =>
    `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`
  return key(at) === key(bt)
}

export const classifyUrl = (raw: string): ClassifiedUrl => {
  const url = parse(raw.trim())
  if (!url) return { kind: 'external', host: '' }

  // Normalize: case-fold and drop a leading www. so host-set lookups are
  // universal across how users actually type links.
  const host = url.hostname.toLowerCase().replace(/^www\./, '')

  if (TELEGRAM_HOSTS.has(host)) {
    const path = url.pathname.replace(/^\/+/, '')
    if (path.startsWith('+') || /^joinchat\//i.test(path)) {
      return { kind: 'private_invite', host }
    }
    const firstSegment = path.split('/')[0] ?? ''
    if (/bot$/i.test(firstSegment) && url.searchParams.has('start')) {
      return { kind: 'bot_deeplink', host }
    }
    return { kind: 'telegram_internal', host }
  }

  if (SHORTENER_HOSTS.has(host)) return { kind: 'shortener', host }
  if (MESSENGER_CONTACT_HOSTS.has(host)) return { kind: 'messenger_contact', host }

  return { kind: 'external', host }
}
