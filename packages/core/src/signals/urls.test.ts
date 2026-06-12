import { describe, expect, it } from 'vitest'
import { classifyUrl } from './urls.js'

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
