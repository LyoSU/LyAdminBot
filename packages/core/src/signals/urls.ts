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

const TRAILING_PUNCTUATION = /[.,;:!?…«»"'“”‘’]+$/

/**
 * Drop the punctuation a sentence leaves stuck to a link.
 *
 * `URL_TOKEN_REGEX` ends a token at the first space, so prose donates whatever
 * sat between the link and the next word: `подивись (t.me/foo), там усе` yields
 * `t.me/foo),`. Harmless for classification, which reads only the host — and
 * not harmless at all for anything that FETCHES the token, which would then ask
 * Telegram for a path nobody wrote and read the answer as "leads nowhere".
 *
 * A closing bracket is punctuation only when the token does not already
 * BALANCE it: `…/foo)` came from the sentence, `…/wiki/Foo_(bar)` is the link,
 * and `…/wiki/Foo_(bar))` is the link inside a parenthetical. Counting rather
 * than merely looking for an opener is what separates the last two.
 */
export const trimUrlPunctuation = (token: string): string => {
  const occurrences = (text: string, character: string): number =>
    text.split(character).length - 1

  let trimmed = token.replace(TRAILING_PUNCTUATION, '')
  while (/[)\]}]$/.test(trimmed)) {
    const closer = trimmed.slice(-1)
    const opener = { ')': '(', ']': '[', '}': '{' }[closer]!
    const withoutBracket = trimmed.slice(0, -1)
    if (occurrences(withoutBracket, opener) > occurrences(withoutBracket, closer)) break
    trimmed = withoutBracket.replace(TRAILING_PUNCTUATION, '')
  }
  return trimmed
}

/** A Telegram destination worth resolving, found in free text. */
export interface TelegramLink {
  /** Fetchable form — the surrounding sentence's punctuation removed. */
  url: string
  kind: 'private_invite' | 'telegram_internal'
  /** The name a public link points at, lowercased; null for a private invite. */
  username: string | null
}

/** The name a public t.me link points at, or null if it points at no one. */
const linkUsername = (raw: string): string | null => {
  const segment = parse(raw)?.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  return segment.length > 0 ? segment.replace(/^@/, '').toLowerCase() : null
}

/**
 * The strongest Telegram destination advertised across some free text.
 *
 * "Strongest" is the rule the bio signals already use: a profile offering both
 * a website and a way into a closed channel is advertising the channel,
 * whichever was typed first. Only the two kinds worth a lookup are considered —
 * everything else is either not Telegram or not a destination.
 */
export const strongestTelegramLink = (texts: readonly string[]): TelegramLink | null => {
  const found: TelegramLink[] = []
  for (const text of texts) {
    for (const token of text.match(URL_TOKEN_REGEX) ?? []) {
      const url = trimUrlPunctuation(token)
      const { kind } = classifyUrl(url)
      if (kind !== 'private_invite' && kind !== 'telegram_internal') continue
      found.push({ url, kind, username: kind === 'private_invite' ? null : linkUsername(url) })
    }
  }
  return found.find((link) => link.kind === 'private_invite') ?? found[0] ?? null
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
