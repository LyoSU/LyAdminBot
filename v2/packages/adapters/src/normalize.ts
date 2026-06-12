/**
 * TL → NormalizedMessage. The single place where mtcute/Telegram shapes are
 * flattened into the core domain contract.
 *
 * Invariant (human-parity): everything a human moderator SEES when judging
 * a message must end up in NormalizedMessage — rendered text including todo
 * task titles, custom-emoji alt characters, hidden link targets, media
 * presence. Unknown TL constructors map to kind 'unknown', never dropped.
 */
import type { Message } from '@mtcute/node'
import { Chat, User } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import type { MessageAttachmentInfo, NormalizedMessage } from '@lyadmin/core'

export interface NormalizeContext {
  isEdit?: boolean
  /** The replied-to message when the gateway fetched it (budget 1 call). */
  repliedMessage?: Message | null
  /** Previous normalization of the same message — enables edit deltas. */
  previous?: NormalizedMessage | null
}

const PREVIEW_LIMIT = 120

// Plain-text URL scan: spammers send links without entities so clients
// still linkify them. Scheme-less t.me deliberately included.
const TEXT_URL_REGEX = /(?:https?:\/\/\S+|(?:^|\s)(?:t\.me|telegram\.me|wa\.me|bit\.ly|tinyurl\.com)\/\S+)/gi

// Invisible chars used for in-word obfuscation (kept in sync with core's
// invisible_in_word signal): word joiner, ZWSP, soft hyphen, BOM.
const OBFUSCATION_INVISIBLES = /[\u2060\u200B\u00AD\uFEFF]/gu

const countInvisibles = (text: string): number => (text.match(OBFUSCATION_INVISIBLES) ?? []).length

const preview = (text: string): string | null =>
  text ? text.slice(0, PREVIEW_LIMIT) : null

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
      return { attachments: one('contact'), extraText: [], previewUrl: null }
    case 'messageMediaPoll':
      return { attachments: one('poll'), extraText: [], previewUrl: null }
    case 'messageMediaGeo':
    case 'messageMediaGeoLive':
    case 'messageMediaVenue':
      return { attachments: one('location'), extraText: [], previewUrl: null }
    case 'messageMediaStory':
      return { attachments: one('story'), extraText: [], previewUrl: null }
    case 'messageMediaPaidMedia':
      return { attachments: one('paid_media'), extraText: [], previewUrl: null }
    case 'messageMediaGiveaway':
    case 'messageMediaGiveawayResults':
      return { attachments: one('giveaway'), extraText: [], previewUrl: null }
    case 'messageMediaVideoStream':
      return { attachments: one('video_stream'), extraText: [], previewUrl: null }
    case 'messageMediaInvoice':
      return { attachments: one('invoice'), extraText: [], previewUrl: null }
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

// ── main ──────────────────────────────────────────────────────────────

export const normalizeMessage = (msg: Message, ctx: NormalizeContext = {}): NormalizedMessage => {
  const raw = msg.raw._ === 'message' ? msg.raw : null
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
    } else {
      replyTo = { authorId: null, isSelf: false, ageSeconds: null, textPreview: null }
    }
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
  const isEdit = ctx.isEdit ?? false
  let editDelta: NormalizedMessage['editDelta'] = null
  if (isEdit && ctx.previous) {
    editDelta = {
      injectedUrls: Math.max(0, urls.length - ctx.previous.urls.length),
      injectedMentions: Math.max(0, mentions.length - ctx.previous.mentions.length),
      injectedInvisibles: Math.max(0, countInvisibles(text) - countInvisibles(ctx.previous.text))
    }
  }

  return {
    chatId: msg.chat.id,
    messageId: msg.id,
    threadId: rawReply && rawReply._ === 'messageReplyHeader' ? rawReply.replyToTopId ?? null : null,
    date: raw?.date ?? Math.floor(msg.date.getTime() / 1000),
    isEdit,
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
