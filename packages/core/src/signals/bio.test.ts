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
})
