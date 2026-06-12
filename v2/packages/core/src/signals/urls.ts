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
