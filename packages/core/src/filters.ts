/**
 * Chat filters: rules an admin sets for their own chat, applied as written.
 *
 * Everything else in this package estimates whether a message is spam. A
 * filter does not. "No Chinese here", "no stickers from newcomers" are house
 * rules, and a message breaking one is removed whether or not it is spam — so a
 * filter verdict must never be read as a finding about the sender anywhere a
 * spam verdict would be: it teaches no signature, feeds no forward reputation,
 * debits no standing and carries to no other chat. `isChatFilterVerdict` is the
 * one test every such consumer asks.
 *
 * Two families:
 *  - writing systems: the message (or a newcomer's name) is mostly written in a
 *    script the chat refuses. Scripts, not languages: a script is a property of
 *    the characters and is read exactly; telling Farsi from Arabic or Chinese
 *    from Japanese kanji on a ten-character message is a guess, and a house rule
 *    that fires on a guess is not the rule the admin set.
 *  - locks: a kind of message the chat does not accept (stickers, links,
 *    forwards…). Read off the normalized message, never inferred.
 *
 * Pure and IO-free like the rest of core, so a replay sees what production saw.
 */
import type { NormalizedMessage, Verdict } from './types.js'
import { blockedScriptShare, type ScriptName } from './text/script.js'

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
 * one sticker in a sticker-free chat is not grounds to ban a regular.
 */
export type FilterAction = 'delete' | 'mute' | 'ban'
export const FILTER_ACTIONS: readonly FilterAction[] = ['delete', 'mute', 'ban']

export interface ChatFilters {
  scripts: FilterableScript[]
  /** Also judge a newcomer's display name by `scripts`. */
  nameScripts: boolean
  locks: LockKind[]
  action: FilterAction
  /** Filters touch newcomers only; members with standing are not filtered at all. */
  newcomersOnly: boolean
}

export const DEFAULT_FILTERS: ChatFilters = {
  scripts: [], nameScripts: false, locks: [], action: 'delete', newcomersOnly: false
}

/** Whether any filter is switched on — the pipeline skips the stage otherwise. */
export const hasActiveFilters = (f: ChatFilters | undefined): f is ChatFilters =>
  f !== undefined && (f.scripts.length > 0 || f.locks.length > 0)

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

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
  return {
    scripts: list(FILTERABLE_SCRIPTS, r['scripts']),
    nameScripts: r['nameScripts'] === true,
    locks: list(LOCK_KINDS, r['locks']),
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

const TG_HOST = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)(?:\/|$)|^tg:\/\//i

const MEDIA_KINDS = new Set(['photo', 'video', 'audio', 'document', 'paid_media', 'video_stream'])

const lockMatches = (lock: LockKind, m: NormalizedMessage): boolean => {
  const kinds = new Set(m.attachments.map((a) => a.kind))
  switch (lock) {
    case 'links': return m.urls.length > 0 || m.inlineButtons.some((b) => b.url !== null)
    case 'tg_links':
      return m.urls.some((u) => TG_HOST.test(u.target) || TG_HOST.test(u.visible)) ||
        m.inlineButtons.some((b) => b.url !== null && TG_HOST.test(b.url))
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

export type FilterHit =
  | { kind: 'lock'; lock: LockKind }
  | { kind: 'script'; script: ScriptName; share: number }
  | { kind: 'name_script'; script: ScriptName; share: number }

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
  const { share, content } = raw
  if (top === null || share <= SCRIPT_FILTER_MIN_SHARE || content < SCRIPT_FILTER_MIN_CONTENT) return null
  return { script: top, share: Math.round(share * 100) / 100 }
}

/**
 * The first filter this message breaks, or null.
 *
 * Locks first — they are exact and cheapest — then the text, then the name. The
 * name is judged for newcomers only, whatever `newcomersOnly` says: a name is
 * who somebody is, not what they wrote, and a member the chat already knows has
 * shown what they write.
 */
export const matchFilters = (
  filters: ChatFilters,
  subject: { message: NormalizedMessage; displayName: string; newcomer: boolean }
): FilterHit | null => {
  if (filters.newcomersOnly && !subject.newcomer) return null
  for (const lock of filters.locks) {
    if (lockMatches(lock, subject.message)) return { kind: 'lock', lock }
  }
  if (filters.scripts.length === 0) return null
  const blocked = new Set<ScriptName>(filters.scripts)
  const inText = scriptHit(subject.message.text, blocked)
  if (inText) return { kind: 'script', ...inText }
  if (filters.nameScripts && subject.newcomer) {
    const inName = scriptHit(subject.displayName, blocked)
    if (inName) return { kind: 'name_script', ...inName }
  }
  return null
}

/** Reason code per hit kind — what the notice and the "Why?" card name. */
export const filterReasonCode = (hit: FilterHit): string =>
  hit.kind === 'lock' ? 'filter_lock' : hit.kind === 'script' ? 'filter_script' : 'filter_name'

/** Rule id: which filter, precisely enough to count hits per filter. */
export const filterRuleId = (hit: FilterHit): string =>
  hit.kind === 'lock' ? `filter:lock:${hit.lock}` : `filter:${hit.kind}:${hit.script}`

/**
 * The action a hit takes against this sender.
 *
 * The configured one for a newcomer; `delete` for anybody with standing. A
 * channel identity is never muted — `mute` on a channel is a ban by
 * construction — so it gets the delete unless the chat asked for bans.
 */
export const filterActionFor = (
  configured: FilterAction,
  sender: { newcomer: boolean; isChannel: boolean }
): FilterAction => {
  if (!sender.newcomer) return 'delete'
  if (sender.isChannel && configured === 'mute') return 'delete'
  return configured
}

/** A verdict that came from a chat filter — a house rule, not a spam finding. */
export const isChatFilterVerdict = (v: Pick<Verdict, 'decidedBy'>): boolean =>
  v.decidedBy === 'chat_filter'
