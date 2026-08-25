import { describe, expect, it } from 'vitest'
import type { MessageAttachmentInfo } from './types.js'
import { mediaCategoryOf } from './media.js'

const one = (kind: MessageAttachmentInfo['kind']): MessageAttachmentInfo[] =>
  [{ kind, fileUniqueId: null }]

describe('mediaCategoryOf', () => {
  it('says nothing when there is nothing to say', () => {
    // Not `other`: a text message has no medium, and calling that "attachment"
    // in a ballot would be describing something that is not there.
    expect(mediaCategoryOf([])).toBeNull()
  })

  it('keeps the distinctions a reader judges by', () => {
    expect(mediaCategoryOf(one('photo'))).toBe('photo')
    expect(mediaCategoryOf(one('sticker'))).toBe('sticker')
    expect(mediaCategoryOf(one('voice'))).toBe('voice')
    expect(mediaCategoryOf(one('document'))).toBe('file')
  })

  it('collapses kinds that differ only in transport', () => {
    // A round video and a plain one are the same claim to somebody voting.
    expect(mediaCategoryOf(one('video_note'))).toBe('video')
    expect(mediaCategoryOf(one('video'))).toBe('video')
    // An animation is a sticker in every way that matters here.
    expect(mediaCategoryOf(one('animation'))).toBe('sticker')
  })

  it('never drops an unmapped kind on the floor', () => {
    // The normalizer promises never to lose media silently; neither does this.
    expect(mediaCategoryOf(one('unknown'))).toBe('other')
    expect(mediaCategoryOf(one('invoice'))).toBe('other')
    expect(mediaCategoryOf(one('giveaway'))).toBe('other')
  })

  it('headlines the first attachment, not the most alarming one', () => {
    // Guessing which of a mixed set to name would be inventing a claim.
    expect(mediaCategoryOf([
      { kind: 'sticker', fileUniqueId: null },
      { kind: 'photo', fileUniqueId: null }
    ])).toBe('sticker')
  })
})
