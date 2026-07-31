/**
 * The chat's own description — what its admins say the chat is for.
 *
 * Why this exists: every stage that judges a message was told the chat's TITLE
 * and nothing more. In a chat whose purpose is job advertisements, "job scam" is
 * at once the dominant spam class and the dominant legitimate class, and a title
 * cannot separate them — production 2026-07-31 classified a specific local job
 * ad (address, office hours, named district) as a scam at 0.96. Whether a post
 * being an advertisement is itself unusual depends on what the chat is for.
 *
 * It is read through a cache because a description changes perhaps never, while
 * messages arrive constantly: one MTProto call per chat per TTL window instead
 * of one per message. The absence of a description is cached too — most chats
 * have none, and that is exactly the case that would otherwise pay on every
 * single message.
 */
import type { TelegramClient } from '@mtcute/node'

/**
 * A description is edited rarely; six hours bounds how long a stale one can
 * mislead the classifier while keeping the call count negligible.
 */
export const CHAT_DESCRIPTION_TTL_MS = 6 * 60 * 60 * 1000

/** The bot's chat count is not bounded by anything, so the cache must be. */
const DEFAULT_MAX_CHATS = 500

export interface ChatDescriptionCache {
  /** The chat's description, or null when it has none or the lookup failed. */
  get(chatId: number): Promise<string | null>
  size(): number
}

export interface ChatDescriptionCacheOptions {
  ttlMs?: number
  maxChats?: number
  now?: () => number
}

/** Blank is the same as absent — an empty purpose line teaches nothing. */
const clean = (raw: string | null): string | null => {
  const trimmed = raw?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export const createChatDescriptionCache = (
  fetch: (chatId: number) => Promise<string | null>,
  options: ChatDescriptionCacheOptions = {}
): ChatDescriptionCache => {
  const ttlMs = options.ttlMs ?? CHAT_DESCRIPTION_TTL_MS
  const maxChats = options.maxChats ?? DEFAULT_MAX_CHATS
  const now = options.now ?? (() => Date.now())

  const entries = new Map<number, { value: string | null; expiresAt: number }>()
  /**
   * Lookups already on the wire. A chat under a spam wave delivers a burst of
   * messages that all miss the cache at once, and without this every one of them
   * would issue the same call — the shape that produced repeated
   * `photos.getUserPhotos resulted in a flood wait` on the avatar path.
   */
  const inFlight = new Map<number, Promise<string | null>>()

  const remember = (chatId: number, value: string | null): void => {
    // Insertion order is eviction order: re-inserting moves a chat to the back,
    // so the entry dropped is the one least recently refreshed.
    entries.delete(chatId)
    entries.set(chatId, { value, expiresAt: now() + ttlMs })
    while (entries.size > maxChats) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  return {
    async get(chatId) {
      const hit = entries.get(chatId)
      if (hit && hit.expiresAt > now()) return hit.value

      const existing = inFlight.get(chatId)
      if (existing) return await existing

      // A failure is cached like any other answer, so an error does not cost a
      // call per message; it expires with the entry, so rights granted later or
      // a transient failure resolve without a restart.
      const pending = fetch(chatId)
        .then((raw) => clean(raw))
        .catch(() => null)
        .then((value) => {
          remember(chatId, value)
          inFlight.delete(chatId)
          return value
        })

      inFlight.set(chatId, pending)
      return await pending
    },
    size: () => entries.size
  }
}

/**
 * Read the description over MTProto. `FullChat.bio` is Telegram's field for a
 * supergroup or channel description; a plain group's is the same field.
 */
export const fetchChatDescription = async (
  tg: TelegramClient,
  chatId: number
): Promise<string | null> => {
  const full = await tg.getFullChat(chatId)
  return clean(full.bio ?? null)
}
