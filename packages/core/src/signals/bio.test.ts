import { describe, expect, it } from 'vitest'
import { extractBioSignals } from './bio.js'

const names = (bio: string | null): string[] => extractBioSignals(bio).map((s) => s.name)

describe('extractBioSignals', () => {
  it('flags a promo link in the bio', () => {
    expect(names('Заработок! пиши в t.me/+abcdef')).toContain('promo_in_bio')
    expect(names('менеджер по работе https://example.com/job')).toContain('promo_in_bio')
    expect(names('пиши в wa.me/79991234567')).toContain('promo_in_bio')
  })

  it('flags a phone or cashtag in the bio', () => {
    expect(names('звони +7 999 123 45 67')).toContain('promo_in_bio')
    expect(names('to the moon $BTC $ETH')).toContain('promo_in_bio')
  })

  it('does not flag a plain telegram profile link (internal, not promo)', () => {
    expect(names('my profile t.me/durov')).not.toContain('promo_in_bio')
  })

  it('does not flag a plain text bio', () => {
    expect(names('Люблю котів і каву')).toEqual([])
    expect(names(null)).toEqual([])
    expect(names('')).toEqual([])
  })

  it('reads the business texts the same way as the bio', () => {
    // Telegram Business greeting/away/intro are Premium-only, so they are rare
    // — but they are unmoderated text the account wrote about itself, sent
    // automatically to everyone who writes in. That is what a bio is, and the
    // hiding place is better precisely because nothing ever looked there.
    const signals = extractBioSignals('Люблю котів', ['Прайс і умови — t.me/+abcdefghij'])
    expect(signals.map((s) => s.name)).toEqual(['promo_in_bio'])
    expect(signals[0]?.evidence).toContain('business')

    // The bio still wins the evidence line when it is the one carrying promo.
    expect(extractBioSignals('пиши t.me/+abcdefghij', ['звичайне привітання'])[0]?.evidence)
      .toContain('bio')
  })

  it('raises the signal once however many places carry promo', () => {
    // One profile advertised in three fields is one fact about one profile.
    expect(extractBioSignals('t.me/+aaaaaaaaaa', ['t.me/+bbbbbbbbbb', 'example.com']))
      .toHaveLength(1)
  })
})
