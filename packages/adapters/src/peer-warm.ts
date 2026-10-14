/**
 * Make an account addressable before acting on it by id alone.
 *
 * Every restriction mtcute sends names the account by `inputPeerUser`, which
 * carries an access hash, and the hash comes from the client's peer cache. That
 * cache lives on disk next to the session, and the deploy does not keep it: on
 * 2026-10-14 each redeploy started with an empty cache, while a community vote
 * stays open for up to six hours (`VOTE_WINDOW_SECONDS`). Three of the four
 * votes that straddled a deploy that day deleted the message and then failed
 * the mute with `MtPeerNotFoundError`; the fourth landed only because its author
 * had posted again in the meantime, which refilled the cache.
 *
 * A bot cannot look an account up by id (`users.getUsers` with a zero hash
 * answers nothing for it) and `contacts.resolveUsername` costs a 46-minute flood
 * wait, so the hash has to come from something Telegram hands a bot in full:
 *
 * 1. the message the decision is about — `channels.getMessages` returns its
 *    author with the hash, and mtcute files every peer in every result. This
 *    has to run BEFORE the message is deleted; afterwards it answers nothing.
 * 2. the chat's member list, searched by the name we stored with the vote —
 *    the same route `findChatMemberByUsername` already takes for a handle the
 *    cache has forgotten. Only for a person: a channel sender is no member.
 *
 * Neither failing is final — the action is still attempted, and its own error
 * is what gets reported. What this returns says which route, if any, filled the
 * cache, so a mute that still fails can be told apart from one that never had a
 * chance.
 */
import type { TelegramClient } from '@mtcute/node'

/** The slice of the client this needs. */
export interface PeerWarmTransport {
  storage: { peers: Pick<TelegramClient['storage']['peers'], 'getById'> }
  getMessages: (chatId: number, messageIds: number[]) => Promise<unknown>
  getChatMembers: (
    chatId: number,
    params: { type: 'all'; query: string; limit: number }
  ) => Promise<ReadonlyArray<{ user: { id: number } }>>
}

/**
 * - `cached`: the account was already addressable; nothing was asked.
 * - `message`: the message the decision is about put it there.
 * - `members`: the chat's member search did.
 * - `unresolved`: neither did; the action will most likely fail.
 */
export type PeerWarmSource = 'cached' | 'message' | 'members' | 'unresolved'

export interface PeerWarmResult {
  source: PeerWarmSource
  /** The first lookup that threw, when one did — for the caller to name. */
  error: unknown
}

/** How many members a name search may return before we give up on it. */
const MEMBER_SEARCH_LIMIT = 50

/**
 * The search term for a stored display name: its first word.
 *
 * Telegram matches a member search against the start of a name's words, and a
 * whole "first last" string is a narrower bet than its first word. The match
 * itself is by id, so a broader query costs nothing in precision.
 */
export const memberSearchTerm = (label: string | null | undefined): string | null => {
  const first = (label ?? '').trim().split(/\s+/u)[0] ?? ''
  return first.length > 0 ? first : null
}

const isCached = async (tg: PeerWarmTransport, userId: number): Promise<boolean> =>
  (await tg.storage.peers.getById(userId).catch(() => null)) !== null

export const warmPeer = async (tg: PeerWarmTransport, params: {
  chatId: number
  userId: number
  /** The message the decision is about, while it still exists. */
  messageId: number | null
  /** The display name stored with the decision, for the member search. */
  nameHint?: string | null | undefined
}): Promise<PeerWarmResult> => {
  if (await isCached(tg, params.userId)) return { source: 'cached', error: undefined }
  let error: unknown
  if (params.messageId !== null) {
    try {
      await tg.getMessages(params.chatId, [params.messageId])
    } catch (err) {
      error = err
    }
    if (await isCached(tg, params.userId)) return { source: 'message', error: undefined }
  }
  const term = params.userId > 0 ? memberSearchTerm(params.nameHint) : null
  if (term !== null) {
    try {
      const found = await tg.getChatMembers(params.chatId, { type: 'all', query: term, limit: MEMBER_SEARCH_LIMIT })
      if (found.some((m) => m.user.id === params.userId) && await isCached(tg, params.userId)) {
        return { source: 'members', error: undefined }
      }
    } catch (err) {
      error ??= err
    }
  }
  return { source: 'unresolved', error }
}
