import { describe, expect, it } from 'vitest'
import { classifyUrl, trimUrlPunctuation, strongestTelegramLink } from './urls.js'

describe('classifyUrl', () => {
  it('classifies private invite links', () => {
    expect(classifyUrl('https://t.me/+AbCdEf123456').kind).toBe('private_invite')
    expect(classifyUrl('t.me/joinchat/AbCdEf123456').kind).toBe('private_invite')
    expect(classifyUrl('https://telegram.me/+xYz').kind).toBe('private_invite')
  })

  it('classifies bot deeplinks', () => {
    expect(classifyUrl('https://t.me/SomePromoBot?start=ref123').kind).toBe('bot_deeplink')
    expect(classifyUrl('t.me/somebot?start=abc').kind).toBe('bot_deeplink')
  })

  it('classifies plain telegram links as internal', () => {
    expect(classifyUrl('https://t.me/durov').kind).toBe('telegram_internal')
    expect(classifyUrl('t.me/some_channel/123').kind).toBe('telegram_internal')
    // bot username without start payload is still just a profile link
    expect(classifyUrl('https://t.me/somebot').kind).toBe('telegram_internal')
  })

  it('classifies url shorteners', () => {
    expect(classifyUrl('https://bit.ly/3xYzAbc').kind).toBe('shortener')
    expect(classifyUrl('http://tinyurl.com/abc').kind).toBe('shortener')
    expect(classifyUrl('https://cutt.ly/x').kind).toBe('shortener')
    expect(classifyUrl('https://clck.ru/abc').kind).toBe('shortener')
  })

  it('classifies whatsapp contact links as messenger_contact', () => {
    expect(classifyUrl('https://wa.me/79991234567').kind).toBe('messenger_contact')
  })

  it('classifies everything else as external', () => {
    expect(classifyUrl('https://example.com/page').kind).toBe('external')
    expect(classifyUrl('https://github.com/mtcute/mtcute').kind).toBe('external')
  })

  it('is robust to scheme-less and trailing-junk inputs', () => {
    expect(classifyUrl('example.com/x').kind).toBe('external')
    expect(classifyUrl('T.ME/+ABC').kind).toBe('private_invite')
  })

  it('matches known hosts behind a www. prefix', () => {
    expect(classifyUrl('https://www.bit.ly/abc').kind).toBe('shortener')
    expect(classifyUrl('www.t.me/+AbC').kind).toBe('private_invite')
  })

  it('never throws on garbage input', () => {
    expect(classifyUrl('').kind).toBe('external')
    expect(classifyUrl('ht!tp://%%%').kind).toBe('external')
    expect(classifyUrl('   ').kind).toBe('external')
  })

  it('extracts the host', () => {
    expect(classifyUrl('https://Sub.Example.COM/a').host).toBe('sub.example.com')
    expect(classifyUrl('t.me/x').host).toBe('t.me')
  })
})

describe('trimUrlPunctuation', () => {
  it('gives back what the sentence borrowed', () => {
    // `URL_TOKEN_REGEX` ends a token at the first space, so prose donates
    // whatever sat between the link and the next word.
    expect(trimUrlPunctuation('t.me/foo),')).toBe('t.me/foo')
    expect(trimUrlPunctuation('example.com.')).toBe('example.com')
    expect(trimUrlPunctuation('t.me/x?!')).toBe('t.me/x')
    expect(trimUrlPunctuation('«t.me/x»')).toBe('«t.me/x')
  })

  it('keeps a bracket the link itself opened', () => {
    expect(trimUrlPunctuation('en.wikipedia.org/wiki/Foo_(bar)')).toBe('en.wikipedia.org/wiki/Foo_(bar)')
    expect(trimUrlPunctuation('en.wikipedia.org/wiki/Foo_(bar))')).toBe('en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('leaves an ordinary link alone', () => {
    expect(trimUrlPunctuation('https://t.me/+abcdef')).toBe('https://t.me/+abcdef')
    expect(trimUrlPunctuation('')).toBe('')
  })
})

describe('strongestTelegramLink', () => {
  it('prefers the closed door over the open one', () => {
    // The rule the bio signals use: a profile offering both a website and a way
    // into a closed channel is advertising the channel, typed first or not.
    expect(strongestTelegramLink(['сайт example.com, вхід t.me/+abcdefghij']))
      .toMatchObject({ kind: 'private_invite', url: 't.me/+abcdefghij', username: null })
    expect(strongestTelegramLink(['t.me/durov і t.me/+secret'])?.kind).toBe('private_invite')
  })

  it('names who a public link points at, for identity rather than resemblance', () => {
    expect(strongestTelegramLink(['мій канал T.ME/MyChannel'])?.username).toBe('mychannel')
    expect(strongestTelegramLink(['t.me/@handle'])?.username).toBe('handle')
  })

  it('ignores everything that is not a Telegram destination', () => {
    expect(strongestTelegramLink(['сайт example.com і bit.ly/x'])).toBeNull()
    expect(strongestTelegramLink(['звичайне біо', ''])).toBeNull()
    expect(strongestTelegramLink([])).toBeNull()
  })

  it('reads every field it is given, not just the first', () => {
    // Bio and the Telegram Business texts beside it are one self-description.
    expect(strongestTelegramLink(['люблю котів', 'прайс — t.me/+abcdefghij'])?.kind)
      .toBe('private_invite')
  })

  it('hands back a fetchable token, punctuation and all removed', () => {
    expect(strongestTelegramLink(['пиши сюди (t.me/+abcdefghij), там усе'])?.url)
      .toBe('t.me/+abcdefghij')
  })
})
