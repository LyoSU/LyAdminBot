import { describe, expect, it } from 'vitest'
import { extractBioSignals, BIO_PROMO_SIGNALS } from './bio.js'
import { SIGNALS } from './registry.js'

const names = (bio: string | null): string[] => extractBioSignals(bio).map((s) => s.name)

describe('extractBioSignals', () => {
  it('flags a promo link in the bio', () => {
    expect(names('менеджер по работе https://example.com/job')).toContain('promo_in_bio')
    expect(names('пиши в wa.me/79991234567')).toContain('promo_in_bio')
  })

  it('names a private invite apart from any other link', () => {
    // The two are not the same claim and are no longer priced as one: measured
    // over 3797 stored bios on 2026-08-25, a bio holding a private invite was
    // 62.5% known-bad against 22.1% for one holding an ordinary website — which
    // is itself below the 24.6% baseline for a bio holding no link at all.
    expect(names('Заработок! пиши в t.me/+abcdef')).toEqual(['private_invite_in_bio'])
    expect(names('joinchat: https://t.me/joinchat/AAAAAA')).toEqual(['private_invite_in_bio'])
    expect(names('менеджер по работе https://example.com/job')).not.toContain('private_invite_in_bio')
  })

  it('reads the strongest thing the profile advertises, not the first', () => {
    // Typing order is the author's choice, so it cannot decide what the bio is
    // charged for: a profile offering both a website and a way into a closed
    // channel is advertising the channel.
    expect(names('сайт example.com, вхід t.me/+abcdefghij'))
      .toEqual(['private_invite_in_bio'])
  })

  it('flags a phone or cashtag apart from a link', () => {
    // Not a link but a way to be reached or paid off-platform, and kept at the
    // weight the merged signal had: the corpus that re-priced the URL branch
    // said nothing about this one.
    expect(names('звони +7 999 123 45 67')).toEqual(['contact_in_bio'])
    expect(names('to the moon $BTC $ETH')).toEqual(['contact_in_bio'])
  })

  it('does not flag a plain telegram profile link (internal, not promo)', () => {
    expect(names('my profile t.me/durov')).toEqual([])
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
    expect(signals.map((s) => s.name)).toEqual(['private_invite_in_bio'])
    expect(signals[0]?.evidence).toContain('business')

    // The bio still wins the evidence line when it is the one carrying promo.
    expect(extractBioSignals('пиши t.me/+abcdefghij', ['звичайне привітання'])[0]?.evidence)
      .toContain('bio')
  })

  it('BIO_PROMO_SIGNALS is exactly what this function can raise', () => {
    // Two readers outside this file ask "does the profile advertise anything?"
    // — a deterministic rule and the fact sheet the LLM is shown. Before the
    // 2026-08-25 split each compared against a single literal name, so splitting
    // one signal into three would have silently narrowed both of them. This
    // pins the set to the raiser: a fourth branch fails here first.
    const raised = new Set([
      'сайт example.com', 'wa.me/79991234567', 'вхід t.me/+abcdefghij',
      'joinchat/AAAAAA — https://t.me/joinchat/AAAAAA', '+7 999 123 45 67', '$BTC',
      'звичайне біо без нічого', 't.me/durov'
    ].flatMap((bio) => extractBioSignals(bio).map((s) => s.name)))

    expect([...raised].sort()).toEqual([...BIO_PROMO_SIGNALS].sort())
  })

  it('every bio signal is shape, and they cap as one profile', () => {
    // A profile is never evidence about a message however heavy it gets, and one
    // profile advertised in several fields is still one profile.
    for (const name of BIO_PROMO_SIGNALS) {
      const spec = SIGNALS[name as keyof typeof SIGNALS] as
        { kind: string; group?: string }
      expect(spec.kind, name).toBe('shape')
      expect(spec.group, name).toBe('profile_promo')
    }
  })

  it('raises the signal once however many places carry promo', () => {
    // One profile advertised in three fields is one fact about one profile.
    expect(extractBioSignals('t.me/+aaaaaaaaaa', ['t.me/+bbbbbbbbbb', 'example.com']))
      .toHaveLength(1)
  })
})
