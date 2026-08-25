import type { MessageAttachmentInfo } from './types.js'

/**
 * What a message without words is, in the terms a reader judges it by.
 *
 * The transport tells us eighteen kinds. A person deciding "is this spam"
 * needs far fewer, and needs the distinctions that change the answer: a
 * sticker from a newcomer is almost never an advert while a photo often is,
 * and a voice note is a person talking while an audio file is something
 * uploaded. Kinds that differ only in TL constructor collapse.
 *
 * `other` is not a failure. Invoices, giveaways and paid media do occur and do
 * get judged; they are simply rare enough in a ballot that naming each one
 * would cost five translations apiece to say what "attachment" already says.
 */
export type MediaCategory = 'photo' | 'sticker' | 'video' | 'voice' | 'file' | 'other'

const CATEGORY_BY_KIND: Partial<Record<MessageAttachmentInfo['kind'], MediaCategory>> = {
  photo: 'photo',
  sticker: 'sticker',
  animation: 'sticker',
  video: 'video',
  video_note: 'video',
  video_stream: 'video',
  voice: 'voice',
  audio: 'voice',
  document: 'file'
}

/**
 * The one category to name for a message, or null when there is nothing to
 * name at all.
 *
 * First attachment wins rather than the most alarming one: an album arrives as
 * siblings of the same kind, and mixed media in a single message is rare
 * enough that guessing which one to headline would be inventing a claim. Null
 * is returned for an empty list so the caller can tell "no words, but here is
 * what it was" apart from "nothing to describe" — the distinction the ballot
 * used to lose by rendering both as empty quotes.
 */
export const mediaCategoryOf = (
  attachments: readonly MessageAttachmentInfo[]
): MediaCategory | null => {
  const first = attachments[0]
  if (first === undefined) return null
  return CATEGORY_BY_KIND[first.kind] ?? 'other'
}
