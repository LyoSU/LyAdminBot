/**
 * TL → NormalizedMessage. The single place where mtcute/Telegram shapes are
 * flattened into the core domain contract.
 *
 * Invariant (human-parity): everything a human moderator SEES when judging
 * a message must end up in NormalizedMessage — rendered text including todo
 * task titles, custom-emoji alt characters, hidden link targets, media
 * presence. Unknown TL constructors map to kind 'unknown', never dropped.
 */
import { createHash } from 'node:crypto'
import type { Message } from '@mtcute/node'
import { Chat, User } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import type { EditBaseline, MessageAttachmentInfo, NormalizedMessage } from '@lyadmin/core'
import { truncate } from '@lyadmin/core'

export interface NormalizeContext {
  isEdit?: boolean
  /** The replied-to message when the gateway fetched it (budget 1 call). */
  repliedMessage?: Message | null
  /**
   * What the message carried BEFORE this edit.
   *
   * Three counters rather than the whole previous normalization, which is what
   * this parameter used to take. The delta reads exactly those three numbers,
   * and the app layer has to keep the answer between two separate deliveries of
   * one message — so what travels here has to be small enough to hold in memory
   * for every recent message and to sit in the decision record. A whole
   * `NormalizedMessage` is neither.
   */
  previousBaseline?: EditBaseline | null
  /**
   * The other messages of the same album, when the gateway buffered one.
   *
   * A Telegram album is N messages the sender composed as ONE post, and the
   * caption may ride on any of them. The gateway has buffered the siblings
   * since it was written; until they arrived here, judging an album meant
   * judging its first part alone — a ten-photo advert whose text sat on the
   * last part was read as a photo with no text at all.
   */
  albumSiblings?: readonly Message[]
}

/** What is knowable about a message sent AS a chat (Telegram's "send as"). */
export interface ChannelSenderFacts {
  senderId: number
  chatId: number
  isAutomaticForward: boolean
  isChannelPost: boolean
}

/**
 * Whether a message sent as a chat is ours to judge.
 *
 * Telegram attaches no marker saying WHICH kind of channel sender this is, so
 * the three kinds are told apart by shape — the same rule the Bot API documents
 * for `sender_chat`:
 *
 *  - `senderId === chatId` — the chat posting as itself, which only an
 *    anonymous administrator can do. Judging it means deleting an admin's own
 *    post and aiming a ban at the chat we are moderating. Production
 *    2026-07-31 reached a ban verdict on exactly that and was saved only by
 *    not holding the right to carry it out.
 *  - `isAutomaticForward` — the linked channel's post mirrored into its
 *    discussion group; same argument, that channel is the one we serve.
 *  - anything else — a member posting as a channel they own. That is the one
 *    delivery method which advertises a channel by construction and a live
 *    spam vector, so it stays judged like any other sender.
 */
export const shouldScanChannelSender = (facts: ChannelSenderFacts): boolean =>
  facts.senderId !== facts.chatId && !facts.isAutomaticForward && !facts.isChannelPost

const PREVIEW_LIMIT = 120

// Plain-text URL scan: spammers send links without entities so clients
// still linkify them. Scheme-less t.me deliberately included.
const TEXT_URL_REGEX = /(?:https?:\/\/\S+|(?:^|\s)(?:t\.me|telegram\.me|wa\.me|bit\.ly|tinyurl\.com)\/\S+)/gi

// Invisible chars used for in-word obfuscation (kept in sync with core's
// invisible_in_word signal): word joiner, ZWSP, soft hyphen, BOM.
const OBFUSCATION_INVISIBLES = /[\u2060\u200B\u00AD\uFEFF]/gu

const countInvisibles = (text: string): number => (text.match(OBFUSCATION_INVISIBLES) ?? []).length

/**
 * What has to be remembered about a message so a later edit can be measured
 * against it — see `EditBaseline` in core for why counters and not the message.
 *
 * Lives here, next to `countInvisibles`, because the third counter is only
 * meaningful in the same vocabulary the normalizer uses: the count is taken
 * over the text AFTER media captions and extracted media text are folded in,
 * which is the only string a delta can honestly be computed against.
 */
/**
 * At most this many link digests are kept. Past it the message is a link dump
 * and the counts answer well enough — a cap that stored a PARTIAL set would be
 * worse than none, since every link past the cap would read as newly injected.
 */
const BASELINE_MAX_URL_KEYS = 10

/**
 * Identity of a destination, folded so that spelling is not a difference.
 *
 * Case and a trailing slash are how the same link is written twice, not how two
 * links differ — without folding them, re-posting the identical URL after an
 * edit would count as an injection.
 */
const urlKeyOf = (target: string): string =>
  createHash('sha256')
    .update(target.trim().toLowerCase().replace(/\/+$/, ''))
    .digest('hex')
    .slice(0, 12)

export const editBaselineOf = (
  msg: Pick<NormalizedMessage, 'urls' | 'mentions' | 'text' | 'attachments' | 'editDate'>
): EditBaseline => {
  const keys = [...new Set(msg.urls.map((u) => urlKeyOf(u.target)))]
  // Sorted, NUL-joined: the key identifies WHAT the version says, not the
  // order entities were parsed in, and no section can impersonate another.
  const media = msg.attachments
    .map((a) => `${a.kind}:${a.fileUniqueId ?? ''}`)
    .sort()
  const contentKey = createHash('sha256')
    .update([msg.text, [...keys].sort().join(','), media.join(',')].join('\0'))
    .digest('hex')
    .slice(0, 12)
  return {
    urls: msg.urls.length,
    mentions: msg.mentions.length,
    invisibles: countInvisibles(msg.text),
    ...(keys.length <= BASELINE_MAX_URL_KEYS ? { urlKeys: keys } : {}),
    editDate: msg.editDate,
    contentKey
  }
}

/**
 * How many destinations this version carries that the earlier one did not.
 *
 * Falls back to the difference in counts when the earlier version kept no keys
 * (a record from before the field existed, or a link dump past the cap). That
 * reading misses a swap — one link replaced by another — which is precisely why
 * the keys exist; it is kept only because under-detecting is the safe direction
 * for a signal that weighs 2.5.
 */
const injectedUrlCount = (
  urls: NormalizedMessage['urls'],
  baseline: EditBaseline
): number => {
  if (!baseline.urlKeys) return Math.max(0, urls.length - baseline.urls)
  const before = new Set(baseline.urlKeys)
  return [...new Set(urls.map((u) => urlKeyOf(u.target)))].filter((k) => !before.has(k)).length
}

// `truncate` because a preview is cut at a fixed code-unit count and previews
// are mostly short chatty messages, i.e. dense with emoji: a plain slice
// orphans a surrogate half, which is unencodable as UTF-8 and takes down the
// whole request that carries it downstream (2026-08-07).
const preview = (text: string): string | null =>
  text ? truncate(text, PREVIEW_LIMIT) : null

const peerToUserId = (peer: tl.TypePeer | undefined): number | null =>
  peer && peer._ === 'peerUser' ? peer.userId : null

// ── media mapping ─────────────────────────────────────────────────────

const DOCUMENT_TYPE_TO_KIND: Record<string, MessageAttachmentInfo['kind']> = {
  sticker: 'sticker',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  document: 'document'
}

const mapMedia = (msg: Message): { attachments: MessageAttachmentInfo[]; extraText: string[]; previewUrl: string | null } => {
  const raw = msg.raw._ === 'message' ? msg.raw.media : undefined
  if (!raw || raw._ === 'messageMediaEmpty') {
    return { attachments: [], extraText: [], previewUrl: null }
  }

  const fileUniqueId = ((): string | null => {
    const media = msg.media as { uniqueFileId?: string } | null
    return media?.uniqueFileId ?? null
  })()

  const one = (kind: MessageAttachmentInfo['kind']): MessageAttachmentInfo[] =>
    [{ kind, fileUniqueId }]

  switch (raw._) {
    case 'messageMediaPhoto':
      return { attachments: one('photo'), extraText: [], previewUrl: null }
    case 'messageMediaDocument': {
      const media = msg.media as { type?: string; isRound?: boolean; isAnimation?: boolean } | null
      let kind: MessageAttachmentInfo['kind'] = 'document'
      if (media?.type && media.type in DOCUMENT_TYPE_TO_KIND) {
        kind = DOCUMENT_TYPE_TO_KIND[media.type] as MessageAttachmentInfo['kind']
      }
      if (media?.type === 'video') {
        if (media.isRound) kind = 'video_note'
        else if (media.isAnimation) kind = 'animation'
      }
      return { attachments: one(kind), extraText: [], previewUrl: null }
    }
    case 'messageMediaContact':
      // A contact card is how a phone number and a name reach the chat without
      // a single character of message text — invisible to every text layer
      // until it is extracted here (2026-07-30 review).
      return {
        attachments: one('contact'),
        extraText: [raw.firstName, raw.lastName, raw.phoneNumber].filter((t) => t.length > 0),
        previewUrl: null
      }
    case 'messageMediaPoll':
      // The question and the options are the whole content of a poll; a promo
      // poll ("Заробіток? / так / пиши @promo") used to arrive as empty text
      // and get waved through by the abstain gate.
      return {
        attachments: one('poll'),
        extraText: [
          raw.poll.question.text,
          ...raw.poll.answers.map((a) => a.text.text)
        ].filter((t) => t.length > 0),
        previewUrl: null
      }
    case 'messageMediaGeo':
    case 'messageMediaGeoLive':
      return { attachments: one('location'), extraText: [], previewUrl: null }
    case 'messageMediaVenue':
      return {
        attachments: one('location'),
        extraText: [raw.title, raw.address].filter((t) => t.length > 0),
        previewUrl: null
      }
    case 'messageMediaStory':
      return { attachments: one('story'), extraText: [], previewUrl: null }
    case 'messageMediaPaidMedia':
      return { attachments: one('paid_media'), extraText: [], previewUrl: null }
    case 'messageMediaGiveaway':
      return {
        attachments: one('giveaway'),
        extraText: raw.prizeDescription ? [raw.prizeDescription] : [],
        previewUrl: null
      }
    case 'messageMediaGiveawayResults':
      return { attachments: one('giveaway'), extraText: [], previewUrl: null }
    case 'messageMediaVideoStream':
      return { attachments: one('video_stream'), extraText: [], previewUrl: null }
    case 'messageMediaInvoice':
      return {
        attachments: one('invoice'),
        extraText: [raw.title, raw.description].filter((t) => t.length > 0),
        previewUrl: null
      }
    case 'messageMediaToDo': {
      // Checklist task titles are content a human reads — extract them.
      const todo = raw.todo
      const extraText: string[] = [todo.title.text]
      for (const item of todo.list) extraText.push(item.title.text)
      return { attachments: one('todo'), extraText, previewUrl: null }
    }
    case 'messageMediaWebPage': {
      const url = raw.webpage._ === 'webPage' || raw.webpage._ === 'webPagePending'
        ? (raw.webpage as { url?: string }).url ?? null
        : null
      return { attachments: [], extraText: [], previewUrl: url }
    }
    case 'messageMediaDice':
    case 'messageMediaGame':
      return { attachments: [], extraText: [], previewUrl: null }
    default:
      // Future TL constructor — surface it instead of silently dropping.
      return { attachments: one('unknown'), extraText: [], previewUrl: null }
  }
}

// ── content ───────────────────────────────────────────────────────────

/**
 * Everything a message SAYS, as opposed to what surrounds it.
 *
 * Split out from `normalizeMessage` so that the parts of an album can each be
 * read and then merged: the identity of the post (who, where, replying to what)
 * belongs to the first part, while the content belongs to all of them.
 */
interface MessageContent {
  text: string
  urls: NormalizedMessage['urls']
  mentions: string[]
  customEmoji: NormalizedMessage['customEmoji']
  attachments: MessageAttachmentInfo[]
  inlineButtons: NormalizedMessage['inlineButtons']
}

const extractContent = (msg: Message): MessageContent => {
  const baseText = msg.text ?? ''

  const { attachments, extraText, previewUrl } = mapMedia(msg)
  const text = [baseText, ...extraText].filter((t) => t.length > 0).join('\n')

  // ── urls / mentions / custom emoji from entities ───────────────────
  const urls: NormalizedMessage['urls'] = []
  const mentions: string[] = []
  const customEmoji: NormalizedMessage['customEmoji'] = []

  for (const entity of msg.entities) {
    if (entity.kind === 'url') {
      urls.push({ visible: entity.text, target: entity.text, hidden: false })
    } else if (entity.kind === 'text_link') {
      const target = (entity.params as { url?: string }).url ?? ''
      urls.push({ visible: entity.text, target, hidden: true })
    } else if (entity.kind === 'mention') {
      mentions.push(entity.text.replace(/^@/, ''))
    } else if (entity.kind === 'emoji') {
      const emojiId = (entity.params as { emojiId?: bigint }).emojiId
      customEmoji.push({ id: String(emojiId ?? ''), alt: entity.text })
    }
  }

  // Plain-text URLs that have no entity (deduped against entity urls).
  const seenTargets = new Set(urls.map((u) => u.target))
  for (const match of text.matchAll(TEXT_URL_REGEX)) {
    const candidate = (match[0] ?? '').trim()
    if (candidate && !seenTargets.has(candidate)) {
      urls.push({ visible: candidate, target: candidate, hidden: false })
      seenTargets.add(candidate)
    }
  }

  // Webpage preview pointing somewhere not present in the text — a way to
  // attach a promo link without typing it.
  if (previewUrl && !text.toLowerCase().includes(previewUrl.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '')) {
    urls.push({ visible: '', target: previewUrl, hidden: true })
  }

  // ── inline buttons ─────────────────────────────────────────────────
  const inlineButtons: NormalizedMessage['inlineButtons'] = []
  const markup = msg.markup
  if (markup && 'type' in markup && markup.type === 'inline') {
    for (const row of markup.buttons) {
      for (const button of row) {
        inlineButtons.push({
          text: 'text' in button ? button.text : '',
          url: button._ === 'keyboardButtonUrl' ? button.url : null
        })
      }
    }
  }

  return { text, urls, mentions, customEmoji, attachments, inlineButtons }
}

/**
 * One album, read as the single post the sender composed.
 *
 * Texts are joined in arrival order, which is the order the reader sees them
 * in. URLs are deduplicated by destination because the same link repeated on
 * three photos is one link — `many_url_buttons` and the promo URL classes count
 * distinct classes, and charging one destination several times would be the
 * double-billing the correlated-signal ceilings exist to stop. Mentions,
 * attachments, emoji and buttons simply accumulate: ten photos really are ten
 * photos, and three separate handles really are three.
 *
 * Only reached for an actual album — a lone message keeps its own record
 * untouched, so nothing about the ordinary path changes.
 */
const mergeContent = (parts: readonly MessageContent[]): MessageContent => {
  const urls: NormalizedMessage['urls'] = []
  const seenTargets = new Set<string>()
  const texts: string[] = []
  const merged: MessageContent = {
    text: '', urls, mentions: [], customEmoji: [], attachments: [], inlineButtons: []
  }
  for (const part of parts) {
    if (part.text.length > 0) texts.push(part.text)
    for (const url of part.urls) {
      if (seenTargets.has(url.target)) continue
      seenTargets.add(url.target)
      urls.push(url)
    }
    merged.mentions.push(...part.mentions)
    merged.customEmoji.push(...part.customEmoji)
    merged.attachments.push(...part.attachments)
    merged.inlineButtons.push(...part.inlineButtons)
  }
  merged.text = texts.join('\n')
  return merged
}

// ── main ──────────────────────────────────────────────────────────────

export const normalizeMessage = (msg: Message, ctx: NormalizeContext = {}): NormalizedMessage => {
  const raw = msg.raw._ === 'message' ? msg.raw : null

  const siblings = ctx.albumSiblings ?? []
  const content = siblings.length === 0
    ? extractContent(msg)
    : mergeContent([extractContent(msg), ...siblings.map(extractContent)])
  const { text, urls, mentions, customEmoji, attachments, inlineButtons } = content

  // ── forward ────────────────────────────────────────────────────────
  let forward: NormalizedMessage['forward'] = null
  if (msg.forward) {
    const sender = msg.forward.sender
    if (!sender || (typeof sender === 'object' && 'type' in sender && sender.type === 'anonymous')) {
      forward = { kind: 'hidden_user', title: sender?.displayName ?? null, sourceId: null }
    } else if (sender instanceof User) {
      forward = { kind: 'user', title: sender.displayName, sourceId: sender.id }
    } else if (sender instanceof Chat) {
      forward = {
        kind: sender.chatType === 'channel' ? 'channel' : 'chat',
        title: sender.title ?? null,
        sourceId: sender.id
      }
    } else {
      forward = { kind: 'hidden_user', title: null, sourceId: null }
    }
  }

  // ── reply / channel comment ────────────────────────────────────────
  let replyTo: NormalizedMessage['replyTo'] = null
  let channelComment: NormalizedMessage['channelComment'] = null
  const rawReply = raw?.replyTo
  if (rawReply && rawReply._ === 'messageReplyHeader') {
    const replied = ctx.repliedMessage ?? null
    if (replied) {
      const repliedSender = replied.sender
      const isChannelPost = repliedSender instanceof Chat && repliedSender.chatType === 'channel'
      if (isChannelPost) {
        channelComment = {
          channelTitle: repliedSender.title ?? null,
          postPreview: preview(replied.text ?? '')
        }
      } else {
        replyTo = {
          authorId: repliedSender instanceof User ? repliedSender.id : null,
          isSelf: repliedSender instanceof User && repliedSender.id === msg.sender.id,
          ageSeconds: raw && replied.raw._ === 'message' ? raw.date - replied.raw.date : null,
          textPreview: preview(replied.text ?? '')
        }
      }
    }
    // No `replied` means the fetch failed or the target is gone. It used to
    // produce a replyTo of nulls, which the core reads as `is_reply` — a −1.0
    // trust discount handed out for an unverifiable claim, and the cheapest
    // evasion in the system (reply to anything, pay nothing). It also masked
    // channel comments as ordinary replies, so the chat stopped being a
    // discussion. An unverified reply is now simply not a reply (2026-07-30).
  }

  // ── guest bot ──────────────────────────────────────────────────────
  let guestBot: NormalizedMessage['guestBot'] = null
  const guestFrom = raw ? (raw as { guestchatViaFrom?: tl.TypePeer }).guestchatViaFrom : undefined
  if (guestFrom) {
    const sender = msg.sender
    guestBot = {
      botId: sender instanceof User ? sender.id : 0,
      botUsername: sender instanceof User ? sender.username : null,
      callerId: peerToUserId(guestFrom)
    }
  }

  // ── edit delta ─────────────────────────────────────────────────────
  //
  // Null when nothing remembers the earlier version — a message from before the
  // bot restarted, or one it never judged. That is an absence of knowledge and
  // not a delta of zero, which is why the edit signals read these fields rather
  // than the `isEdit` flag.
  //
  // Known limit, ALBUMS: the baseline is kept for the post, under the id it was
  // delivered as, while Telegram delivers an edit of any single part on its own.
  // So an edit of a sibling has no baseline at all, and an edit of the first
  // part is measured against the whole post. Both under-detect and neither can
  // accuse: the count difference floors at zero, and the key difference only
  // ever names a destination the post did not carry anywhere.
  const isEdit = ctx.isEdit ?? false
  const baseline = ctx.previousBaseline ?? null
  const editDelta: NormalizedMessage['editDelta'] = isEdit && baseline
    ? {
        injectedUrls: injectedUrlCount(urls, baseline),
        injectedMentions: Math.max(0, mentions.length - baseline.mentions),
        injectedInvisibles: Math.max(0, countInvisibles(text) - baseline.invisibles)
      }
    : null

  return {
    chatId: msg.chat.id,
    messageId: msg.id,
    threadId: rawReply && rawReply._ === 'messageReplyHeader' ? rawReply.replyToTopId ?? null : null,
    date: raw?.date ?? Math.floor(msg.date.getTime() / 1000),
    isEdit,
    editDate: msg.editDate ? msg.editDate.getTime() : 0,
    text,
    urls,
    mentions,
    attachments,
    inlineButtons,
    forward,
    replyTo,
    channelComment,
    editDelta,
    customEmoji,
    guestBot
  }
}
