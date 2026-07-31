import { describe, expect, test } from 'vitest'
import { shouldAbstain, type AbstainInput } from './abstain.js'

const msg = (overrides: Partial<AbstainInput> = {}): AbstainInput => ({
  text: '',
  urls: [],
  mentions: [],
  attachments: [],
  inlineButtons: [],
  forward: null,
  customEmoji: [],
  guestBot: null,
  ...overrides
})

describe('shouldAbstain — the "bare @username" class of messages', () => {
  test('abstains on a bare mention', () => {
    expect(shouldAbstain(msg({ text: '@someuser', mentions: ['someuser'] }))).toBe(true)
  })

  test('abstains on several mentions with no other content', () => {
    expect(
      shouldAbstain(msg({ text: '@a @b @c', mentions: ['a', 'b', 'c'] }))
    ).toBe(true)
  })

  test('abstains on a very short reaction-like message', () => {
    expect(shouldAbstain(msg({ text: 'ок' }))).toBe(true)
  })

  test('abstains on emoji-only text', () => {
    expect(shouldAbstain(msg({ text: '😀🔥🚀' }))).toBe(true)
  })

  test('abstains when short text is padded with invisible chars', () => {
    expect(shouldAbstain(msg({ text: '​​​хм​​​' }))).toBe(true)
  })
})

describe('shouldAbstain — length is measured in content, not codepoints', () => {
  test('a logographic sentence is classified, not waved through as too short', () => {
    // REGRESSION (2026-07-31): ten characters of Han plus a handle measured 10
    // against a bar of 20, so a complete advert was never classified at all.
    // In production this class was only ever caught when the account already
    // sat in an external ban database — the deterministic rule that reads
    // those runs before this gate.
    expect(shouldAbstain(msg({ text: '会洗mi的来 日入上w @mlstii', mentions: ['mlstii'] }))).toBe(false)
    expect(shouldAbstain(msg({ text: '酒店投放摄像头一台8q @vbtge', mentions: ['vbtge'] }))).toBe(false)
  })

  test('a short logographic courtesy still abstains', () => {
    // The gate must keep measuring content. Weighting characters up is not a
    // licence to classify every message in the script.
    expect(shouldAbstain(msg({ text: '谢谢' }))).toBe(true)
    expect(shouldAbstain(msg({ text: 'ありがとう' }))).toBe(true)
  })
})

describe('shouldAbstain — rich content always gets classified', () => {
  test('does not abstain when a URL is present, even with short text', () => {
    expect(
      shouldAbstain(msg({
        text: 'тут',
        urls: [{ visible: 't.me/x', target: 'https://t.me/x', hidden: false }]
      }))
    ).toBe(false)
  })

  test('does not abstain on media attachments', () => {
    expect(
      shouldAbstain(msg({ text: '', attachments: [{ kind: 'photo', fileUniqueId: 'abc' }] }))
    ).toBe(false)
  })

  test('does not abstain on inline url buttons', () => {
    expect(
      shouldAbstain(msg({ text: 'хм', inlineButtons: [{ text: 'click', url: 'https://x.io' }] }))
    ).toBe(false)
  })

  test('does not abstain on forwarded messages', () => {
    expect(
      shouldAbstain(msg({ text: 'глянь', forward: { kind: 'hidden_user', title: null } }))
    ).toBe(false)
  })

  test('does not abstain on a normal-length sentence', () => {
    expect(
      shouldAbstain(msg({ text: 'привіт, підкажіть де тут купити квитки на потяг' }))
    ).toBe(false)
  })

  test('does not abstain on custom-emoji-heavy messages (symbol masking)', () => {
    // Spammers render phone numbers / channel names via custom emoji while
    // the raw text looks empty — these must always reach classification
    expect(
      shouldAbstain(msg({
        text: '😀😀😀',
        customEmoji: [
          { id: '1', alt: '8' },
          { id: '2', alt: '0' },
          { id: '3', alt: '0' }
        ]
      }))
    ).toBe(false)
  })

  test('a single decorative custom emoji still abstains', () => {
    expect(
      shouldAbstain(msg({ text: 'клас 😀', customEmoji: [{ id: '1', alt: '😀' }] }))
    ).toBe(true)
  })

  test('does not abstain on guest-bot messages', () => {
    // A message delivered by a guest bot is rich content by definition —
    // the bot was summoned to post something
    expect(
      shouldAbstain(msg({
        text: 'хм',
        guestBot: { botId: 7, botUsername: 'somebot', callerId: 42 }
      }))
    ).toBe(false)
  })

  test('mention text does not count as information, but trailing text can', () => {
    // "@user дивись який заробіток пиши мені" — mention itself is noise,
    // but the remaining text is long enough to classify
    expect(
      shouldAbstain(msg({
        text: '@user дивись який заробіток пиши мені',
        mentions: ['user']
      }))
    ).toBe(false)
  })
})
