/**
 * Text normalization shared by every content detector.
 *
 * One source of truth for emoji/invisible-char handling. The v1 codebase
 * had three drifted copies of this logic, which produced the emoji-only
 * hash-collision bug class (identical hashes/embeddings for unrelated
 * messages). Keep it here and nowhere else.
 */

// Covers the major Unicode emoji ranges plus joiners/selectors so that
// ZWJ sequences and keycaps are removed entirely (no stray combiners left).
/**
 * Regional indicators (U+1F1E6-1F1FF) sit BELOW the main pictograph block, so
 * they were absent here and a flag survived stripping as if it were text. That
 * gave the same gesture two answers depending on how often it was made: one
 * flag is four code units and slipped under `isEmojiOnly`'s old five-character
 * bar, two flags did not. Added 2026-08-22 alongside the bar itself.
 */
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|\u{3030}|\u{303D}|\u{3297}|\u{3299}|[\u{E0020}-\u{E007F}]/gu

/**
 * Unicode Format category (zero-width, directional marks, BOM, tags, …) plus
 * unpaired surrogates. The lone-surrogate clause is what keeps stripInvisible
 * idempotent: a Format char sitting between an unpaired high and low surrogate
 * would, once removed, leave those two surrogates adjacent — and they can then
 * combine into a supplementary-plane code point that is itself a Format char
 * (e.g. U+E0001), which a second pass would strip. Dropping lone surrogates up
 * front makes that merge impossible. Valid surrogate pairs are left untouched.
 */
const INVISIBLE_REGEX = /\p{Cf}|[\uD800-\uDFFF]/gu

/**
 * Unpaired surrogates, and ONLY unpaired ones.
 *
 * The `u` flag is what makes that true rather than approximate: in Unicode mode
 * the pattern matches code points, so a valid pair is a single code point above
 * U+FFFF and cannot match a BMP range — while an orphaned half, having no
 * partner, is itself a code point in D800–DFFF and does. Without the flag this
 * would match both halves of every emoji. Same reliance as INVISIBLE_REGEX.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu
const HAS_LONE_SURROGATE = /[\uD800-\uDFFF]/u

/**
 * True when the string can be encoded as UTF-8 at all — i.e. carries no orphaned
 * surrogate half. ES2024's `String.prototype.isWellFormed`, which this repo
 * cannot name because it targets lib ES2023.
 */
export const isWellFormed = (text: string): boolean => !HAS_LONE_SURROGATE.test(text)

/**
 * Make a string encodable, replacing each orphaned surrogate with U+FFFD.
 *
 * For use at the boundary of anything that will encode to UTF-8 — every HTTP
 * body, every stored document. Not because such strings are expected, but
 * because the failure mode is grotesquely disproportionate: ONE orphaned half
 * anywhere in a prompt makes the entire request unencodable and the provider
 * rejects all of it (2026-08-07, OpenAI 400 "unpaired UTF-16 surrogate code
 * point"). A replacement character costs one glyph of fidelity; the alternative
 * cost every verdict in that call.
 *
 * U+FFFD rather than deletion, matching both the ES2024 operation of the same
 * name and what Node's own UTF-8 encoder does on the Mongo path — so the loud
 * boundary and the silent one now agree instead of diverging.
 */
export const toWellFormed = (text: string): string => text.replace(LONE_SURROGATE, '�')

/**
 * Cut a string to at most `limit` UTF-16 code units WITHOUT splitting a surrogate
 * pair. Use instead of `.slice(0, n)` on anything a user wrote.
 *
 * `.slice()` counts code units, so any limit landing between the two halves of an
 * emoji orphans one — and an orphan is not merely odd, it is unencodable. On
 * 2026-08-07 that is what took the classifier down: a 200-unit cut on a bio,
 * shipped as the legal JSON escape \udXXX, refused by the provider as a whole
 * request. The same cut on the embeddings path failed silently instead, inside a
 * catch that returns null, so it had been losing vectors invisibly.
 *
 * The limit stays in code units on purpose: these limits exist to bound prompt
 * and document SIZE, and size is units, not code points. So a cut may yield one
 * unit less than asked, never one more. The dangling half is dropped rather than
 * replaced — half an emoji is not a character, and inventing a U+FFFD where we
 * chose to cut would put an artifact in front of the model.
 */
export const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const last = cut.charCodeAt(limit - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export const stripEmoji = (text: string): string => text.replace(EMOJI_REGEX, '')

export const stripInvisible = (text: string): string => text.replace(INVISIBLE_REGEX, '')

/**
 * True when the message carries enough non-emoji, non-invisible characters
 * to be worth hashing/embedding/classifying as text.
 */
export const hasTextualContent = (text: string, minLength = 5): boolean => {
  if (!text) return false
  const stripped = stripInvisible(stripEmoji(text)).replace(/\s+/g, '')
  return stripped.length >= minLength
}

/**
 * True when nothing but emoji is left — not "not much text", but none.
 *
 * The distinction is the whole function. `hasTextualContent` answers "is there
 * enough here to be worth embedding", and its five-character default belongs to
 * that question. Borrowing it made every message under five characters count as
 * emoji: production 2026-08-20 handed the 1.5 reaction discount to the
 * two-letter text "NV", and stacked with `short_message` that paid a newcomer
 * 2.3 of trust for typing almost nothing.
 *
 * Punctuation-only text ("...", "?") is deliberately not a reaction here. It is
 * text, `short_message` already covers its brevity, and reading it as emoji
 * would be the same borrowing in a smaller costume.
 */
export const isEmojiOnly = (text: string): boolean =>
  text.length > 0 && !hasTextualContent(text, 1)

/**
 * What a redacted destination is replaced with. Localized by the caller: a
 * voter reading a ballot in Ukrainian must not be told "[link]".
 */
export interface RedactionMarkers {
  /** A URL, a bare host with a path, or an email address. */
  link: string
  /** An `@handle`. */
  mention: string
  /** A `t.me/+…` or `/joinchat/…` invite — a door, not a page. */
  invite: string
}

// Order matters: the narrow patterns run first, because each replacement is
// final and a generic URL match would swallow the invite that a voter most
// needs named. The markers themselves carry no dot, slash or `@`, so a later
// pattern cannot match what an earlier one wrote.
// A Telegram host is only a host when a letter, digit or dot does not run into
// it: without the lookbehind `t.me` matches inside an ordinary word (the "t.me"
// hiding in "part.men"), and a ballot that redacts words is worse than one that
// shows a dead link.
const TG_HOST = '(?<![\\p{L}\\p{N}_.-])(?:[a-z][a-z0-9+.-]*://)?(?:t|telegram)\\.(?:me|dog)'
const INVITE_REGEX = new RegExp(`${TG_HOST}/(?:\\+|joinchat/)\\S+`, 'giu')
const TG_HOST_REGEX = new RegExp(
  `(?:${TG_HOST}|(?<![\\p{L}\\p{N}_.-])(?:[a-z][a-z0-9+.-]*://)?telegra\\.ph)(?![\\p{L}\\p{N}-])(?:/\\S*)?`,
  'giu'
)
const SCHEME_URL_REGEX = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi
const EMAIL_REGEX = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,24}/giu
/**
 * Anything with a path is a destination, whatever its suffix. A path is the one
 * unambiguous signal: no filename and no abbreviation carries one.
 */
const HOSTED_PATH_REGEX = /[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,24}\/\S*/giu

/**
 * Suffixes a bare host is redacted for even with no path.
 *
 * Requiring a path was the first cut and it leaves real spam readable — a naked
 * `something.com` is a destination anybody can type into a browser, and the
 * ballot was reprinting it. Matching every `word.tld` instead is worse: it eats
 * a filename ("звіт.pdf"), a module ("node.js"), an abbreviation, and a ballot
 * that redacts the words it was asked to show is useless.
 *
 * So: a curated list, not a rule. These are the suffixes that actually appear
 * in what this bot removes, chosen so that none of them doubles as a common
 * file extension in the languages these chats are written in. Adding one is a
 * deliberate act — weigh it against what it will eat.
 */
const BARE_HOST_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'top', 'club', 'online', 'site',
  'shop', 'store', 'live', 'link', 'click', 'space', 'website', 'vip', 'win',
  'bet', 'casino', 'cash', 'money', 'icu', 'fun', 'life', 'world',
  'ru', 'ua', 'by', 'kz', 'pl', 'de', 'fr', 'uk', 'su', 'tv', 'cc'
].join('|')
const BARE_HOST_REGEX = new RegExp(
  `(?<![\\p{L}\\p{N}_.-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]*(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${BARE_HOST_TLDS})(?![\\p{L}\\p{N}-])`,
  'giu'
)
/**
 * Telegram handles are 5–32 chars and start with a letter, which is what keeps
 * this off the vocative "@всім" and off a bare "@" used as punctuation.
 */
const HANDLE_REGEX = /(^|[^\p{L}\p{N}_@/])@([a-z][a-z0-9_]{4,31})/giu

/**
 * Where each Telegram handle sits in a piece of text.
 *
 * Exported so that the redactor and the abstain gate cannot come to disagree
 * about what a handle IS. The grammar is Telegram's own and it already settles
 * three questions a hand-rolled `@\w+` gets wrong: `@всім` is not a handle
 * (letter-leading, 5–32), `name@example.com` is not a handle (the character
 * before `@` may not be a letter or digit), and the `@bot` of `/start@bot` is
 * not a handle either — it is the command's target, and the leading class
 * excludes `/`.
 *
 * Deliberately read from the text rather than from Telegram's `mention`
 * entities. The entities are what Telegram chose to tag; the grammar is what a
 * reader sees and can retype. The redactor has trusted the grammar since it was
 * written, for a job where a miss means the bot republishes the advertisement
 * itself.
 */
export const handleSpans = (text: string): { start: number; end: number }[] => {
  const spans: { start: number; end: number }[] = []
  for (const match of text.matchAll(HANDLE_REGEX)) {
    const lead = (match[1] ?? '').length
    spans.push({ start: match.index + lead, end: match.index + match[0].length })
  }
  return spans
}

/**
 * Replace every destination in a piece of user text with a marker naming what
 * kind of destination it was.
 *
 * This exists because of what our own notices are: the ballot, the incident card
 * and the "why" card all quote a stranger's message back into a chat that every
 * member reads. Quoting a live invite means the bot itself delivers the spam to
 * the whole room, with the bot's own authority behind it — the one distribution
 * channel the spammer could not buy.
 *
 * This used to be half of a pair: a monospace block stopped a destination being
 * CLICKABLE and redaction stopped it being READABLE. The block is gone as of
 * 2026-08-26 — it did not wrap, so long quotes ran off the edge of the ballot
 * and a voter could not read what they were voting on — which leaves redaction
 * carrying both jobs alone. `COMMAND_HANDLE_REGEX` below is the hole that
 * arrangement exposed.
 *
 * Naming the kind rather than deleting it silently is the point: "was there a
 * link" is most of what a voter is judging, so a marker keeps the evidence while
 * dropping the payload. What survives is the shape of the message, which is what
 * the question is actually about.
 */
/**
 * `/command@SomeBot` — a handle `HANDLE_REGEX` deliberately does not see.
 *
 * That regex requires a non-word character before the `@` so it cannot chew
 * through an address, and in a command suffix the `@` follows a letter. Telegram
 * links the handle half anyway: tapping it opens that bot.
 *
 * It stayed harmless while every quote sat inside a monospace block, which is
 * not clickable. It stopped being harmless on 2026-08-26, when the ballot's
 * quote became a real blockquote so that long messages would wrap and collapse
 * — readable at last, and linkifying. Measured over 13,241 stored quotes at that
 * point: 905 command suffixes survived redaction, against 4 URLs and handles in
 * total that slipped everything else. One systematic hole, not a long tail.
 *
 * Its own pass rather than a loosened `HANDLE_REGEX`: that grammar is also read
 * by `handleSpans`, where the abstain gate decides whether a message is nothing
 * but a pointer outward. Widening it there would silently reclassify every bot
 * command in every chat — a change to moderation, made while editing a renderer.
 */
const COMMAND_HANDLE_REGEX = /(\/[a-z0-9_]{1,32})@[a-z][a-z0-9_]{3,31}/gi

export const redactLinks = (text: string, markers: RedactionMarkers): string => {
  // Every replacement goes through a function rather than a string. A marker is
  // a TRANSLATED string, and a `$` inside one would be read as a group
  // reference the day somebody writes a price into it.
  const invite = (): string => markers.invite
  const link = (): string => markers.link
  return text
    .replace(INVITE_REGEX, invite)
    .replace(TG_HOST_REGEX, link)
    .replace(SCHEME_URL_REGEX, link)
    .replace(EMAIL_REGEX, link)
    .replace(HOSTED_PATH_REGEX, link)
    .replace(BARE_HOST_REGEX, link)
    // Before the general one, and keeping the command itself: `/roll` is what
    // the message was about, `@SomeBot` is where it points.
    .replace(COMMAND_HANDLE_REGEX, (_match, command: string) => `${command}${markers.mention}`)
    .replace(HANDLE_REGEX, (_match, before: string) => `${before}${markers.mention}`)
}
