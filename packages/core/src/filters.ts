/**
 * Chat filters: rules an admin sets for their own chat, applied as written.
 *
 * Everything else in this package estimates whether a message is spam. A
 * filter does not. "No Chinese here", "no stickers from newcomers", "this word
 * is not said here" are house rules, and a message breaking one is removed
 * whether or not it is spam — so a filter verdict must never be read as a
 * finding about the sender anywhere a spam verdict would be: it teaches no
 * signature, feeds no forward reputation, debits no standing and carries to no
 * other chat. `isChatFilterVerdict` is the one test every such consumer asks.
 *
 * Families:
 *  - writing systems: the message (or a newcomer's name) is mostly written in a
 *    script the chat refuses. Scripts, not languages: a script is a property of
 *    the characters and is read exactly; telling Farsi from Arabic or Chinese
 *    from Japanese kanji on a ten-character message is a guess, and a house rule
 *    that fires on a guess is not the rule the admin set.
 *  - locks: a kind of message the chat does not accept (stickers, links,
 *    forwards…). Read off the normalized message, never inferred. Links have an
 *    allow-list of the chat's own sites.
 *  - stop-words: words the chat does not accept, matched as whole words, with a
 *    trailing `*` for every form of a word, and through look-alike letters.
 *  - flood: more messages than the chat allows inside its window.
 *
 * Pure and IO-free like the rest of core, so a replay sees what production saw.
 */
import type { NormalizedMessage, Verdict } from './types.js'
import { blockedScriptShare, type ScriptName } from './text/script.js'
import { foldConfusables } from './text/confusables.js'

/**
 * Scripts an admin may refuse. Latin and Cyrillic are not offered: brands,
 * code, URLs and the bot's own UI languages are written in them, so blocking
 * either would remove ordinary messages in every chat that tried it.
 */
export const FILTERABLE_SCRIPTS = [
  'arabic', 'han', 'kana', 'hangul', 'hebrew',
  'devanagari', 'thai', 'armenian', 'georgian', 'greek'
] as const satisfies readonly ScriptName[]
export type FilterableScript = typeof FILTERABLE_SCRIPTS[number]

export const LOCK_KINDS = [
  'links', 'tg_links', 'forwards', 'channel_forwards', 'buttons',
  'media', 'stickers', 'gifs', 'voice', 'video_notes',
  'stories', 'contacts', 'polls'
] as const
export type LockKind = typeof LOCK_KINDS[number]

/**
 * What a hit does. Applied in full to newcomers only: a member with standing
 * who breaks a house rule loses the message, never their place in the chat —
 * one sticker in a sticker-free chat is not grounds to ban a regular. `warn`
 * deletes and adds a warning; the chat's warning limit decides what follows.
 */
export type FilterAction = 'delete' | 'warn' | 'mute' | 'ban'
export const FILTER_ACTIONS: readonly FilterAction[] = ['delete', 'warn', 'mute', 'ban']

/** At most `messages` inside any `seconds`-long window. */
export interface FloodLimit { messages: number; seconds: number }

/** The limits the panel offers — a chat picks one, it does not type numbers. */
export const FLOOD_PRESETS: readonly FloodLimit[] = [
  { messages: 5, seconds: 10 },
  { messages: 10, seconds: 30 },
  { messages: 20, seconds: 60 }
]

export interface ChatFilters {
  scripts: FilterableScript[]
  /** Also judge a newcomer's display name by `scripts`. */
  nameScripts: boolean
  locks: LockKind[]
  /** Stop-words, normalized (`normalizeWord`). A trailing `*` matches every ending. */
  words: string[]
  /** Sites a `links`/`tg_links` lock lets through, normalized (`normalizeDomain`). */
  domains: string[]
  flood: FloodLimit | null
  action: FilterAction
  /** Filters touch newcomers only; members with standing are not filtered at all. */
  newcomersOnly: boolean
}

export const DEFAULT_FILTERS: ChatFilters = {
  scripts: [], nameScripts: false, locks: [], words: [], domains: [], flood: null,
  action: 'delete', newcomersOnly: false
}

export const MAX_WORDS = 200
export const MAX_DOMAINS = 50
export const MAX_WORD_LENGTH = 64

/** Whether any filter is switched on — the pipeline skips the stage otherwise. */
export const hasActiveFilters = (f: ChatFilters | undefined): f is ChatFilters =>
  f !== undefined &&
  (f.scripts.length > 0 || f.locks.length > 0 || f.words.length > 0 || f.flood !== null)

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

/**
 * One stop-word as stored: trimmed, lower-cased, inner spaces collapsed,
 * surrounding quotes dropped. Null when nothing usable is left — an empty
 * entry, a bare `*`, something longer than `MAX_WORD_LENGTH`.
 */
export const normalizeWord = (raw: string): string | null => {
  const word = raw.trim().replace(/^["'«“]+|["'»”]+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (word.replace(/\*+$/, '').trim().length === 0 || word.length > MAX_WORD_LENGTH) return null
  // One trailing star means "any ending"; stars elsewhere are literal noise.
  return word.replace(/\*+$/, '*')
}

/**
 * A site as stored: lower-case host, optional first path segment (so a chat can
 * allow its own `t.me/channel` without allowing every t.me link). Scheme,
 * `www.`, query and trailing slashes are dropped. Null for anything that is not
 * a host with a dot in it.
 */
export const normalizeDomain = (raw: string): string | null => {
  const s = raw.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
  const [host = '', first = ''] = s.split('/')
  if (!/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(host)) return null
  const segment = first.replace(/[^\p{L}\p{N}_+-]/gu, '')
  return segment ? `${host}/${segment}` : host
}

/**
 * A pasted list → normalized entries, deduped against each other and against
 * what is already stored, in the order given. Lines and commas both separate,
 * because admins paste from both.
 */
export const parseEntries = (
  input: string,
  normalize: (raw: string) => string | null,
  existing: readonly string[] = []
): string[] => {
  const seen = new Set(existing)
  const out: string[] = []
  for (const part of input.split(/[\n,;]+/)) {
    const entry = normalize(part)
    if (entry === null || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

const parseFlood = (raw: unknown): FloodLimit | null => {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return FLOOD_PRESETS.find((p) => p.messages === r['messages'] && p.seconds === r['seconds']) ?? null
}

/**
 * Settings as stored → settings as used. The document is admin-written through
 * our own buttons, but it is still input: an unknown script left behind by a
 * later rename, a duplicate, a non-array must degrade to "that entry is off",
 * never to a crash on every message in the chat.
 */
export const normalizeFilters = (raw: unknown): ChatFilters => {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_FILTERS }
  const r = raw as Record<string, unknown>
  const list = <T extends string>(all: readonly T[], v: unknown): T[] =>
    Array.isArray(v) ? all.filter((item) => v.includes(item)) : []
  const strings = (v: unknown, normalize: (s: string) => string | null, max: number): string[] =>
    Array.isArray(v)
      ? parseEntries(v.filter((x): x is string => typeof x === 'string').join('\n'), normalize).slice(0, max)
      : []
  return {
    scripts: list(FILTERABLE_SCRIPTS, r['scripts']),
    nameScripts: r['nameScripts'] === true,
    locks: list(LOCK_KINDS, r['locks']),
    words: strings(r['words'], normalizeWord, MAX_WORDS),
    domains: strings(r['domains'], normalizeDomain, MAX_DOMAINS),
    flood: parseFlood(r['flood']),
    action: isOneOf(FILTER_ACTIONS, r['action']) ? r['action'] : 'delete',
    newcomersOnly: r['newcomersOnly'] === true
  }
}

/** Toggle one entry of a list setting, keeping the catalogue's order. */
export const toggleIn = <T extends string>(all: readonly T[], current: readonly T[], item: T): T[] =>
  all.filter((x) => (x === item) !== current.includes(x))

/** Share of letters the blocked scripts must hold — "more than half". */
export const SCRIPT_FILTER_MIN_SHARE = 0.5

/**
 * Content the blocked letters must carry, in `informativeLength` units: two Han
 * characters, four Arabic letters. Below it a message is an emoji with a stray
 * character, a name quoted in passing — not a message written in that script.
 */
export const SCRIPT_FILTER_MIN_CONTENT = 4

/**
 * The bar, in letters, for a message with no letters outside the blocked
 * scripts: a one-word reply is still written in that script when it is all
 * there is. A lone character beside an emoji stays below it.
 */
export const SCRIPT_FILTER_MIN_LETTERS_PURE = 2

const TG_HOST = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)(?:\/|$)|^tg:\/\//i

/** Host and first path segment of a link, the shape `normalizeDomain` stores. */
const linkKey = (url: string): { host: string; path: string } | null => {
  const key = normalizeDomain(url)
  if (key === null) return null
  const [host = '', path = ''] = key.split('/')
  return { host, path }
}

/**
 * Whether the chat lets this link through. A host entry allows the host and its
 * subdomains; a `host/segment` entry allows that one page and what is under it.
 */
const allowedLink = (url: string, domains: readonly string[]): boolean => {
  if (domains.length === 0) return false
  const link = linkKey(url)
  if (link === null) return false
  return domains.some((entry) => {
    const [host = '', path = ''] = entry.split('/')
    const hostOk = link.host === host || link.host.endsWith(`.${host}`)
    return hostOk && (path === '' || link.path === path)
  })
}

const MEDIA_KINDS = new Set(['photo', 'video', 'audio', 'document', 'paid_media', 'video_stream'])

const lockMatches = (lock: LockKind, m: NormalizedMessage, domains: readonly string[]): boolean => {
  const kinds = new Set(m.attachments.map((a) => a.kind))
  const targets = [
    ...m.urls.map((u) => u.target),
    ...m.inlineButtons.flatMap((b) => (b.url === null ? [] : [b.url]))
  ].filter((url) => !allowedLink(url, domains))
  switch (lock) {
    case 'links': return targets.length > 0
    case 'tg_links': return targets.some((url) => TG_HOST.test(url))
    case 'forwards': return m.forward !== null
    case 'channel_forwards': return m.forward?.kind === 'channel'
    case 'buttons': return m.inlineButtons.length > 0
    case 'media': return [...kinds].some((k) => MEDIA_KINDS.has(k))
    case 'stickers': return kinds.has('sticker')
    case 'gifs': return kinds.has('animation')
    case 'voice': return kinds.has('voice')
    case 'video_notes': return kinds.has('video_note')
    case 'stories': return kinds.has('story')
    case 'contacts': return kinds.has('contact')
    case 'polls': return kinds.has('poll') || kinds.has('todo')
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-word match of one stop-word, case-insensitive, Unicode-aware (JS `\b` is
 * ASCII-only and would let Cyrillic words match inside others). A trailing `*`
 * accepts any ending — `заробіт*` is every case of the noun.
 */
const wordRegex = (word: string): RegExp => {
  const prefix = word.endsWith('*')
  const body = escapeRegExp(prefix ? word.slice(0, -1) : word).replace(/ /g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${prefix ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])'}`, 'iu')
}

/**
 * The stop-word the text contains, or null. Matched on the text as written and
 * again with look-alike letters folded on both sides, so `кaзинo` with two
 * Latin letters is still `казино`. The fold never stands alone as evidence
 * elsewhere in this codebase; here it is the admin's own word on both sides.
 */
export const matchStopWord = (text: string, words: readonly string[]): string | null => {
  if (words.length === 0 || text.length === 0) return null
  const folded = foldConfusables(text.toLowerCase())
  for (const word of words) {
    if (wordRegex(word).test(text)) return word
    if (wordRegex(foldConfusables(word)).test(folded)) return word
  }
  return null
}

export type FilterHit =
  | { kind: 'lock'; lock: LockKind }
  | { kind: 'word'; word: string }
  | { kind: 'script'; script: ScriptName; share: number }
  | { kind: 'name_script'; script: ScriptName; share: number }
  | { kind: 'flood'; count: number }

const KANA_ONLY: ReadonlySet<ScriptName> = new Set(['kana'])

/**
 * Japanese is kana AND Han: a sentence is often more kanji than kana, so a chat
 * refusing Japanese by its kana alone would let most Japanese through. Han is
 * therefore counted as blocked whenever the text carries kana — which Chinese
 * never does, so a chat that blocks Japanese still accepts Chinese.
 */
const effectiveBlocked = (text: string, blocked: ReadonlySet<ScriptName>): ReadonlySet<ScriptName> =>
  blocked.has('kana') && !blocked.has('han') && blockedScriptShare(text, KANA_ONLY).content > 0
    ? new Set([...blocked, 'han'])
    : blocked

const scriptHit = (text: string, blockedSet: ReadonlySet<ScriptName>): { script: ScriptName; share: number } | null => {
  const blocked = effectiveBlocked(text, blockedSet)
  const raw = blockedScriptShare(text, blocked)
  // Named by the script the admin chose: Han swept in with kana is Japanese.
  const top = raw.top === 'han' && !blockedSet.has('han') ? 'kana' : raw.top
  const { share, content, letters } = raw
  const enough = content >= SCRIPT_FILTER_MIN_CONTENT || (share >= 1 && letters >= SCRIPT_FILTER_MIN_LETTERS_PURE)
  if (top === null || share <= SCRIPT_FILTER_MIN_SHARE || !enough) return null
  return { script: top, share: Math.round(share * 100) / 100 }
}

/**
 * The first filter this message breaks, or null.
 *
 * Exact checks first — locks, then stop-words — then the text's script, then
 * the name, then the rate. The name is judged for newcomers only, whatever
 * `newcomersOnly` says: a name is who somebody is, not what they wrote, and a
 * member the chat already knows has shown what they write.
 *
 * `recentCount` is how many messages this sender posted in this chat inside the
 * flood window, this one included; the app layer keeps that count. Absent means
 * unknown, and an unknown rate is never a flood.
 */
export const matchFilters = (
  filters: ChatFilters,
  subject: { message: NormalizedMessage; displayName: string; newcomer: boolean; recentCount?: number | null }
): FilterHit | null => {
  if (filters.newcomersOnly && !subject.newcomer) return null
  for (const lock of filters.locks) {
    if (lockMatches(lock, subject.message, filters.domains)) return { kind: 'lock', lock }
  }
  const word = matchStopWord(subject.message.text, filters.words)
  if (word !== null) return { kind: 'word', word }
  if (filters.scripts.length > 0) {
    const blocked = new Set<ScriptName>(filters.scripts)
    const inText = scriptHit(subject.message.text, blocked)
    if (inText) return { kind: 'script', ...inText }
    if (filters.nameScripts && subject.newcomer) {
      const inName = scriptHit(subject.displayName, blocked)
      if (inName) return { kind: 'name_script', ...inName }
    }
  }
  const count = subject.recentCount
  if (filters.flood !== null && typeof count === 'number' && count > filters.flood.messages) {
    return { kind: 'flood', count }
  }
  return null
}

/** Reason code per hit kind — what the notice and the "Why?" card name. */
export const filterReasonCode = (hit: FilterHit): string => {
  switch (hit.kind) {
    case 'lock': return 'filter_lock'
    case 'word': return 'filter_word'
    case 'script': return 'filter_script'
    case 'name_script': return 'filter_name'
    case 'flood': return 'filter_flood'
  }
}

/** Rule id: which filter, precisely enough to count hits per filter. */
export const filterRuleId = (hit: FilterHit): string => {
  switch (hit.kind) {
    case 'lock': return `filter:lock:${hit.lock}`
    // Not the word itself: rule ids are logged and aggregated, and a chat's
    // stop-list is its own business.
    case 'word': return 'filter:word'
    case 'script': return `filter:script:${hit.script}`
    case 'name_script': return `filter:name_script:${hit.script}`
    case 'flood': return 'filter:flood'
  }
}

/**
 * The action a hit takes against this sender.
 *
 * The configured one for a newcomer; `delete` for anybody with standing. A
 * channel identity is never muted or warned — `mute` on a channel is a ban by
 * construction, and a warning count on a posting identity has no person to
 * address — so it gets the delete unless the chat asked for bans.
 */
export const filterActionFor = (
  configured: FilterAction,
  sender: { newcomer: boolean; isChannel: boolean }
): FilterAction => {
  if (!sender.newcomer) return 'delete'
  if (sender.isChannel && (configured === 'mute' || configured === 'warn')) return 'delete'
  return configured
}

/** A verdict that came from a chat filter — a house rule, not a spam finding. */
export const isChatFilterVerdict = (v: Pick<Verdict, 'decidedBy'>): boolean =>
  v.decidedBy === 'chat_filter'
