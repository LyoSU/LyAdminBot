import { describe, expect, it, vi } from 'vitest'
import { Long } from '@mtcute/node'
import { tdFileId, toFileId } from '@mtcute/file-id'
import {
  botApiMediaKind, isStaleFileIdError, resendStoredMedia, sendMediaByFileId
} from './media-resend.js'

const { FileType } = tdFileId

/** A synthetic file id of a given type, with or without a file reference. */
const fileIdOf = (type: number, ref: Uint8Array | null): string =>
  toFileId({
    dcId: 2,
    type,
    fileReference: ref,
    location: type === FileType.Photo
      ? {
          _: 'photo',
          id: Long.fromNumber(42),
          accessHash: Long.fromNumber(7),
          source: { _: 'thumbnail', fileType: FileType.Photo, thumbnailType: 'x' }
        }
      : { _: 'common', id: Long.fromNumber(42), accessHash: Long.fromNumber(7) }
  })

const REF = new Uint8Array([1, 2, 3, 4])

describe('botApiMediaKind', () => {
  it('reads the kind out of the file id itself, reference or not', () => {
    const cases: [number, string][] = [
      [FileType.Photo, 'photo'],
      [FileType.Video, 'video'],
      [FileType.Animation, 'animation'],
      [FileType.Audio, 'audio'],
      [FileType.VoiceNote, 'voice'],
      [FileType.VideoNote, 'video_note'],
      [FileType.Sticker, 'sticker'],
      [FileType.Document, 'document']
    ]
    for (const [type, kind] of cases) {
      expect(botApiMediaKind(fileIdOf(type, REF))).toBe(kind)
      // The legacy ids we actually have on record carry no reference at all.
      expect(botApiMediaKind(fileIdOf(type, null))).toBe(kind)
    }
  })

  it('prefers the id over the stored hint (a v1 "document" holding a GIF is an animation)', () => {
    expect(botApiMediaKind(fileIdOf(FileType.Animation, null), 'document')).toBe('animation')
  })

  it('falls back to the stored v1 hint when the id will not parse', () => {
    expect(botApiMediaKind('not-a-file-id', 'voice')).toBe('voice')
    expect(botApiMediaKind('not-a-file-id', 'nonsense')).toBe('document')
    expect(botApiMediaKind('not-a-file-id', null)).toBe('document')
  })
})

describe('isStaleFileIdError', () => {
  it('accepts the errors that mean "this id is too old to send"', () => {
    expect(isStaleFileIdError(new tdFileId.InvalidFileIdError('Expected document to have file reference'))).toBe(true)
    expect(isStaleFileIdError(new tdFileId.ConversionError('inputDocument'))).toBe(true)
    expect(isStaleFileIdError(new tdFileId.UnsupportedError('Unsupported file type: 99'))).toBe(true)
    expect(isStaleFileIdError(new Error('FILE_REFERENCE_EXPIRED'))).toBe(true)
    expect(isStaleFileIdError(new Error('RpcError: 400 FILE_REFERENCE_INVALID'))).toBe(true)
  })

  it('rejects failures that might mean the message already went out', () => {
    expect(isStaleFileIdError(new Error('CHAT_WRITE_FORBIDDEN'))).toBe(false)
    expect(isStaleFileIdError(new Error('FLOOD_WAIT_42'))).toBe(false)
    expect(isStaleFileIdError(new Error('TIMEOUT'))).toBe(false)
  })
})

describe('sendMediaByFileId', () => {
  const okFetch = (messageId = 555): typeof fetch =>
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch

  it('posts the file id under the field its send method expects', async () => {
    const fetchImpl = okFetch()
    const res = await sendMediaByFileId({
      token: 'T', chatId: -100, fileId: 'FID', kind: 'animation', caption: 'hi\n<b>there</b>', replyTo: 9, fetchImpl
    })
    expect(res).toEqual({ id: 555, captionOmitted: false })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/botT/sendAnimation')
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: -100,
      animation: 'FID',
      caption: 'hi\n<b>there</b>',
      parse_mode: 'HTML',
      reply_parameters: { message_id: 9, allow_sending_without_reply: true }
    })
  })

  it('drops the caption for kinds Bot API refuses it on, and says so', async () => {
    const fetchImpl = okFetch()
    const res = await sendMediaByFileId({ token: 'T', chatId: 1, fileId: 'FID', kind: 'sticker', caption: 'text', fetchImpl })
    expect(res).toEqual({ id: 555, captionOmitted: true })
    const body = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ chat_id: 1, sticker: 'FID' })
  })

  it('surfaces the Bot API description on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, description: 'Bad Request: wrong file_id' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch
    await expect(sendMediaByFileId({ token: 'T', chatId: 1, fileId: 'FID', kind: 'photo', fetchImpl }))
      .rejects.toThrow(/wrong file_id/)
  })
})

describe('resendStoredMedia', () => {
  it('uses MTProto alone when it works', async () => {
    const viaBotApi = vi.fn()
    const res = await resendStoredMedia({ viaMtproto: async () => ({ id: 1 }), viaBotApi })
    expect(res).toEqual({ id: 1, captionOmitted: false })
    expect(viaBotApi).not.toHaveBeenCalled()
  })

  it('falls back to Bot API for a file id MTProto cannot convert', async () => {
    const res = await resendStoredMedia({
      viaMtproto: async () => { throw new tdFileId.InvalidFileIdError('Expected document to have file reference') },
      viaBotApi: async () => ({ id: 2, captionOmitted: false })
    })
    expect(res).toEqual({ id: 2, captionOmitted: false })
  })

  it('never retries over HTTP when the MTProto failure was not about the file id', async () => {
    const viaBotApi = vi.fn()
    await expect(resendStoredMedia({
      viaMtproto: async () => { throw new Error('CHAT_WRITE_FORBIDDEN') },
      viaBotApi
    })).rejects.toThrow(/CHAT_WRITE_FORBIDDEN/)
    // A duplicate message is worse than a missing one.
    expect(viaBotApi).not.toHaveBeenCalled()
  })

  it('reports both legs when the fallback fails too', async () => {
    await expect(resendStoredMedia({
      viaMtproto: async () => { throw new tdFileId.InvalidFileIdError('no file reference') },
      viaBotApi: async () => { throw new Error('wrong file_id') }
    })).rejects.toThrow(/no file reference.*wrong file_id/s)
  })
})
