import { describe, expect, it } from 'vitest'
import type { ChannelPreview } from '../types.js'
import { extractLinkedChannelSignals } from './channel.js'
import { isTrustSignal, SIGNALS } from './registry.js'
import { contentEvidence, hasDecisiveSignal, mayRemoveSender } from '../score.js'

const channel = (o: Partial<ChannelPreview> = {}): ChannelPreview => ({
  source: 'personal_channel', title: 'Мій блог', description: null,
  subscribers: 1200, avatarBase64: null, ...o
})

const names = (channels: ChannelPreview[]): string[] =>
  extractLinkedChannelSignals(channels).map((s) => s.name)

describe('extractLinkedChannelSignals', () => {
  it('reads the channel blurb the way it reads a bio', () => {
    expect(names([channel({ description: 'Прайс і запис — t.me/+abcdefghij' })]))
      .toEqual(['promo_in_linked_channel'])
    expect(names([channel({ title: 'Замовити 099 123 45 67' })]))
      .toEqual(['promo_in_linked_channel'])
  })

  it('an ordinary channel is not an accusation', () => {
    expect(names([channel({ description: 'Пишу про книжки і каву' })])).toEqual([])
    expect(names([])).toEqual([])
    // A plain t.me profile link is as ambiguous here as in a bio.
    expect(names([channel({ description: 'мій другий акаунт t.me/durov' })])).toEqual([])
  })

  it('names where it looked, so a false positive can be argued with', () => {
    const [signal] = extractLinkedChannelSignals([
      channel({ source: 'bio_link', title: 'Канал', description: 'usd → wa.me/79991234567' })
    ])
    expect(signal?.evidence).toContain('channel from bio')
    expect(signal?.evidence).toContain('Канал')
  })

  it('one profile advertised in two channels is still one profile', () => {
    expect(extractLinkedChannelSignals([
      channel({ description: 't.me/+aaaaaaaaaa' }),
      channel({ source: 'bio_link', description: 'example.com' })
    ])).toHaveLength(1)
  })

  it('what the profile advertises can never convict the message', () => {
    // The doctrine this pipeline keeps relearning: profile evidence says the
    // ACCOUNT is a promo vehicle. It is a reason to read the message, and never
    // by itself a reason to act on it. Both new signals are shape, so neither
    // reaches `contentEvidence` at all.
    for (const name of ['promo_in_linked_channel', 'nsfw_linked_channel'] as const) {
      expect(SIGNALS[name].kind, name).toBe('shape')
      expect(isTrustSignal(name), name).toBe(false)
      expect(contentEvidence([{ name }]), name).toEqual({ strongest: 0, total: 0 })
      expect(hasDecisiveSignal([{ name }]), name).toBe(false)
      expect(mayRemoveSender([{ name }]), name).toBe(false)
    }
  })
})
