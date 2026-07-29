/**
 * Re-sending media we only know by file id.
 *
 * Extras and welcome gifs keep a bare Telegram file id in Mongo, most of them
 * written years ago by the telegraf-era bot. Raw MTProto cannot replay those.
 * A file id embeds a `file_reference` that Telegram expires, and ids minted
 * before the 2019 format change carry none at all — mtcute then refuses the
 * send locally with "Expected document to have file reference". The Bot API
 * server keeps its own file store and re-resolves references on our behalf,
 * which is why v1 could replay the same ids for years.
 *
 * So: MTProto first (one connection, no HTTP hop), Bot API as the fallback for
 * exactly the errors that mean "this id is too old" — never for errors that
 * could mean the message already went out.
 */
import { parseFileId, tdFileId } from '@mtcute/file-id'

/** The Bot API send* methods that take a file id we may have on record. */
export type BotApiMediaKind =
  | 'photo' | 'video' | 'animation' | 'audio' | 'voice' | 'video_note' | 'sticker' | 'document'

interface SendSpec {
  method: string
  /** Request field the file id goes under (mirrors the method name). */
  field: string
  acceptsCaption: boolean
}

const SEND_SPEC: Record<BotApiMediaKind, SendSpec> = {
  photo: { method: 'sendPhoto', field: 'photo', acceptsCaption: true },
  video: { method: 'sendVideo', field: 'video', acceptsCaption: true },
  animation: { method: 'sendAnimation', field: 'animation', acceptsCaption: true },
  audio: { method: 'sendAudio', field: 'audio', acceptsCaption: true },
  voice: { method: 'sendVoice', field: 'voice', acceptsCaption: true },
  document: { method: 'sendDocument', field: 'document', acceptsCaption: true },
  // Bot API rejects `caption` on these two outright.
  sticker: { method: 'sendSticker', field: 'sticker', acceptsCaption: false },
  video_note: { method: 'sendVideoNote', field: 'video_note', acceptsCaption: false }
}

const KIND_BY_FILE_TYPE: Partial<Record<number, BotApiMediaKind>> = {
  [tdFileId.FileType.Photo]: 'photo',
  [tdFileId.FileType.Thumbnail]: 'photo',
  [tdFileId.FileType.ProfilePhoto]: 'photo',
  [tdFileId.FileType.Video]: 'video',
  [tdFileId.FileType.Animation]: 'animation',
  [tdFileId.FileType.Audio]: 'audio',
  [tdFileId.FileType.VoiceNote]: 'voice',
  [tdFileId.FileType.VideoNote]: 'video_note',
  [tdFileId.FileType.Sticker]: 'sticker',
  [tdFileId.FileType.Document]: 'document',
  [tdFileId.FileType.DocumentAsFile]: 'document'
}

const isKnownKind = (v: string): v is BotApiMediaKind => Object.hasOwn(SEND_SPEC, v)

/**
 * Which send* method fits this file id. The id itself is authoritative — it
 * encodes what Telegram thinks the file is — so a v1 extra stored as
 * "document" while holding a GIF correctly resolves to sendAnimation. The hint
 * (v1's stored media type) only covers ids too mangled to parse.
 */
export const botApiMediaKind = (fileId: string, hint?: string | null): BotApiMediaKind => {
  const fallback = hint && isKnownKind(hint) ? hint : 'document'
  try {
    return KIND_BY_FILE_TYPE[parseFileId(fileId).type] ?? fallback
  } catch {
    return fallback
  }
}

/**
 * RPC errors that mean Telegram rejected the *file*, so the message provably
 * never landed. Deliberately narrow: see isStaleFileIdError.
 */
const STALE_FILE_RPC_ERROR = /FILE_REFERENCE_\w+|FILE_ID_INVALID|MEDIA_EMPTY|PHOTO_INVALID/

/**
 * True when a send failed *because of the file id* and definitively did not
 * reach the chat. Anything else (missing rights, flood wait, timeout) must
 * propagate: retrying those over HTTP risks posting the extra twice.
 */
export const isStaleFileIdError = (err: unknown): boolean => {
  if (
    err instanceof tdFileId.InvalidFileIdError
    || err instanceof tdFileId.ConversionError
    || err instanceof tdFileId.UnsupportedError
  ) return true
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return STALE_FILE_RPC_ERROR.test(text)
}

export interface ResendResult {
  id: number
  /** The caption could not ride along (sticker / video note) — send it separately. */
  captionOmitted: boolean
}

export interface BotApiSendParams {
  token: string
  chatId: number
  fileId: string
  kind: BotApiMediaKind
  /** Bot API HTML: real newlines, not the `<br>` mtcute's parser wants. */
  caption?: string | undefined
  replyTo?: number | undefined
  /** Injection point for tests. */
  fetchImpl?: typeof fetch
}

/** One Bot API send of an already-uploaded file. Throws unless Telegram says ok. */
export const sendMediaByFileId = async (params: BotApiSendParams): Promise<ResendResult> => {
  const spec = SEND_SPEC[params.kind]
  const body: Record<string, unknown> = { chat_id: params.chatId, [spec.field]: params.fileId }
  const captionOmitted = Boolean(params.caption) && !spec.acceptsCaption
  if (params.caption && spec.acceptsCaption) {
    body['caption'] = params.caption
    body['parse_mode'] = 'HTML'
  }
  if (params.replyTo !== undefined) {
    // allow_sending_without_reply: the trigger may be gone by now (deleted, or
    // removed by our own spam verdict) — the media should still land.
    body['reply_parameters'] = { message_id: params.replyTo, allow_sending_without_reply: true }
  }
  const doFetch = params.fetchImpl ?? fetch
  const res = await doFetch(`https://api.telegram.org/bot${params.token}/${spec.method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => null) as
    { ok?: boolean; description?: string; result?: { message_id?: number } } | null
  const messageId = json?.result?.message_id
  if (json?.ok !== true || typeof messageId !== 'number') {
    throw new Error(`bot api ${spec.method} failed: ${json?.description ?? `http ${res.status}`}`)
  }
  return { id: messageId, captionOmitted }
}

export interface ResendDeps {
  viaMtproto: () => Promise<{ id: number }>
  viaBotApi: () => Promise<ResendResult>
}

/**
 * MTProto with a Bot API fallback for stale file ids. When both legs fail the
 * error names each one, so logs say why rather than just "failed".
 */
export const resendStoredMedia = async (deps: ResendDeps): Promise<ResendResult> => {
  let mtprotoErr: unknown
  try {
    const sent = await deps.viaMtproto()
    return { id: sent.id, captionOmitted: false }
  } catch (err) {
    if (!isStaleFileIdError(err)) throw err
    mtprotoErr = err
  }
  try {
    return await deps.viaBotApi()
  } catch (botApiErr) {
    throw new Error(`mtproto: ${String(mtprotoErr)}; bot api: ${String(botApiErr)}`)
  }
}
