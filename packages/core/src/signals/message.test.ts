import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../types.js'
import { isTrustSignal } from './registry.js'
import { extractMessageSignals } from './message.js'

const makeMsg = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -100123,
  messageId: 1,
  threadId: null,
  date: 1_780_000_000,
  isEdit: false,
  text: '',
  urls: [],
  mentions: [],
  attachments: [],
  inlineButtons: [],
  forward: null,
  replyTo: null,
  channelComment: null,
  editDelta: null,
  customEmoji: [],
  guestBot: null,
  ...overrides
})

const names = (msg: NormalizedMessage): string[] =>
  extractMessageSignals(msg).map((s) => s.name)

const suspicious = (msg: NormalizedMessage): string[] =>
  extractMessageSignals(msg).filter((s) => !isTrustSignal(s.name)).map((s) => s.name)

describe('extractMessageSignals — suspicious signals', () => {
  it('flags forwards from hidden users', () => {
    expect(names(makeMsg({ forward: { kind: 'hidden_user', title: null } }))).toContain('forward_hidden_user')
  })

  it('does NOT flag channel forwards (news forwarding is routine)', () => {
    expect(names(makeMsg({ forward: { kind: 'channel', title: 'News' } }))).not.toContain('forward_hidden_user')
  })

  it('flags 3+ URL buttons, not a single one', () => {
    const threeButtons = makeMsg({
      inlineButtons: [
        { text: 'a', url: 'https://x.com/1' },
        { text: 'b', url: 'https://x.com/2' },
        { text: 'c', url: 'https://x.com/3' }
      ]
    })
    expect(names(threeButtons)).toContain('many_url_buttons')
    const oneButton = makeMsg({ inlineButtons: [{ text: 'a', url: 'https://x.com/1' }] })
    expect(names(oneButton)).not.toContain('many_url_buttons')
  })

  it('flags deceptive hidden urls (visible text looks like a different URL)', () => {
    const msg = makeMsg({
      text: 'go to https://google.com now',
      urls: [{ visible: 'https://google.com', target: 'https://scam.example', hidden: true }]
    })
    expect(names(msg)).toContain('hidden_url')
  })

  it('does not flag a text_link whose visible text is plain words', () => {
    const msg = makeMsg({
      text: 'читай тут',
      urls: [{ visible: 'тут', target: 'https://example.com/article', hidden: true }]
    })
    expect(names(msg)).not.toContain('hidden_url')
  })

  it('classifies url kinds into distinct signals', () => {
    const invite = makeMsg({ urls: [{ visible: 't.me/+abc', target: 't.me/+abc', hidden: false }] })
    expect(names(invite)).toContain('private_invite_link')
    const short = makeMsg({ urls: [{ visible: 'bit.ly/x', target: 'bit.ly/x', hidden: false }] })
    expect(names(short)).toContain('url_shortener')
    const deeplink = makeMsg({ urls: [{ visible: 't.me/spambot?start=x', target: 't.me/spambot?start=x', hidden: false }] })
    expect(names(deeplink)).toContain('bot_deeplink')
    const ext = makeMsg({ urls: [{ visible: 'https://shop.example', target: 'https://shop.example', hidden: false }] })
    expect(names(ext)).toContain('external_url')
  })

  it('flags phone numbers and cashtags from raw text', () => {
    expect(names(makeMsg({ text: 'пиши +380 99 123 45 67' }))).toContain('phone_number')
    expect(names(makeMsg({ text: 'купуй $BTC зараз' }))).toContain('cashtag')
    expect(names(makeMsg({ text: 'ціна 100 грн' }))).not.toContain('phone_number')
  })

  it('flags long promotional text', () => {
    expect(names(makeMsg({ text: 'а'.repeat(250) }))).toContain('long_text')
    expect(names(makeMsg({ text: 'коротко' }))).not.toContain('long_text')
  })

  it('flags invisible characters injected inside words (job-scam obfuscation)', () => {
    // U+2060 WORD JOINER inside a word — an obfuscation seen in production
    expect(names(makeMsg({ text: 'Доб\u2060рого дня! Потрібні люди' }))).toContain('invisible_in_word')
    // ZWJ in emoji sequences must NOT trigger it
    expect(names(makeMsg({ text: 'сімʼя 👨‍👩‍👧' }))).not.toContain('invisible_in_word')
  })

  it('does NOT flag typographic artefacts of copied text', () => {
    // At weight 2.0 this signal single-handedly clears the bar for removing the
    // sender, with no stage having read the message. A SOFT HYPHEN (U+00AD)
    // inside a word is what pasting hyphenated text out of a PDF, a document
    // editor or a justified web page produces, and a BOM (U+FEFF) is what a
    // broken encoding pipeline leaves behind — neither is evidence of intent.
    //
    // Nothing is lost by ignoring them: `stripInvisible` removes every \p{Cf}
    // before hashing and embedding, so this class of character cannot evade the
    // signature or vector layers in the first place. The signal's only job is to
    // register deliberate obfuscation.
    expect(names(makeMsg({ text: 'Потріб\u00ADні люди на роботу' }))).not.toContain('invisible_in_word')
    expect(names(makeMsg({ text: 'Потріб\uFEFFні люди на роботу' }))).not.toContain('invisible_in_word')
    // Zero-width space stays: it has no typographic use in chat text.
    expect(names(makeMsg({ text: 'Потріб\u200Bні люди на роботу' }))).toContain('invisible_in_word')
  })

  it('flags mixed-script words (homoglyph evasion), not legit bilingual text', () => {
    // Latin "a"/"o" inside a Cyrillic word
    expect(names(makeMsg({ text: 'Зaрaбoтoк для всіх' }))).toContain('mixed_script_word')
    expect(names(makeMsg({ text: 'дивись відео на YouTube українською' }))).not.toContain('mixed_script_word')
  })

  it('flags a GREEK homoglyph inside a Cyrillic word', () => {
    // Production 2026-07-31 10:11: an advert whose every substitution came from
    // Greek (omicron, kappa, rho) raised nothing, while a second advert from the
    // same campaign an hour later happened to include one Latin letter and was
    // flagged. The evasion is identical; only the donor alphabet differed.
    expect(names(makeMsg({ text: 'Ищем οтветственнοго менеджера' }))).toContain('mixed_script_word')
    expect(names(makeMsg({ text: 'обработκа тρафика' }))).toContain('mixed_script_word')
  })

  it('does NOT flag scripts that are written together by design', () => {
    // The trap in generalising to "more than one script per word": Japanese and
    // Korean mix scripts inside a word and put no spaces between words, so
    // counting scripts would charge 1.5 to every message written in them —
    // exactly the messages the pipeline is least equipped to read.
    expect(names(makeMsg({ text: '日本語のテキストです' }))).not.toContain('mixed_script_word')
    expect(names(makeMsg({ text: '한국어 텍스트 漢字 포함' }))).not.toContain('mixed_script_word')
  })

  it('flags custom-emoji-heavy messages with alt evidence', () => {
    const msg = makeMsg({
      text: 'звичайний текст',
      customEmoji: [
        { id: '1', alt: '8' }, { id: '2', alt: '0' }, { id: '3', alt: '0' }, { id: '4', alt: '☎' }
      ]
    })
    const signal = extractMessageSignals(msg).find((s) => s.name === 'custom_emoji_heavy')
    expect(signal).toBeDefined()
    expect(signal?.evidence).toContain('800')
  })

  it('flags spam-relevant media kinds', () => {
    expect(names(makeMsg({ attachments: [{ kind: 'paid_media', fileUniqueId: null }] }))).toContain('paid_media')
    expect(names(makeMsg({ attachments: [{ kind: 'giveaway', fileUniqueId: null }] }))).toContain('giveaway_media')
    expect(names(makeMsg({ attachments: [{ kind: 'story', fileUniqueId: null }] }))).toContain('story_share')
    expect(names(makeMsg({ attachments: [{ kind: 'unknown', fileUniqueId: null }] }))).toContain('unknown_media')
  })

  it('flags guest-bot delivery', () => {
    const msg = makeMsg({ guestBot: { botId: 7, botUsername: 'promo_bot', callerId: 42 } })
    expect(names(msg)).toContain('guest_bot_delivery')
  })

  it('flags edits and promo-injecting edits separately', () => {
    expect(names(makeMsg({ isEdit: true }))).toContain('edited_message')
    const injecting = makeMsg({
      isEdit: true,
      editDelta: { injectedUrls: 1, injectedMentions: 0, injectedInvisibles: 0 }
    })
    expect(names(injecting)).toContain('edit_injected_promo')
    const benignEdit = makeMsg({
      isEdit: true,
      editDelta: { injectedUrls: 0, injectedMentions: 0, injectedInvisibles: 0 }
    })
    expect(names(benignEdit)).not.toContain('edit_injected_promo')
  })
})

describe('extractMessageSignals — trust signals (negative)', () => {
  const trust = (msg: NormalizedMessage): string[] =>
    extractMessageSignals(msg).filter((s) => isTrustSignal(s.name)).map((s) => s.name)

  it('treats replies to others as trust, replies to self as nothing', () => {
    const reply = makeMsg({
      text: 'згоден',
      replyTo: { authorId: 9, isSelf: false, ageSeconds: 120, textPreview: 'питання' }
    })
    expect(trust(reply)).toContain('is_reply')
    expect(trust(reply)).toContain('recent_reply')
    const selfReply = makeMsg({
      text: 'і ще',
      replyTo: { authorId: 1, isSelf: true, ageSeconds: 10, textPreview: null }
    })
    expect(trust(selfReply)).not.toContain('is_reply')
  })

  it('reply to an old message is is_reply but not recent_reply', () => {
    const oldReply = makeMsg({
      text: 'так',
      replyTo: { authorId: 9, isSelf: false, ageSeconds: 90_000, textPreview: null }
    })
    expect(trust(oldReply)).toContain('is_reply')
    expect(trust(oldReply)).not.toContain('recent_reply')
  })

  it('sticker/GIF without text is media_only trust', () => {
    expect(trust(makeMsg({ attachments: [{ kind: 'sticker', fileUniqueId: 'u1' }] }))).toContain('media_only')
    expect(trust(makeMsg({ text: 'купи', attachments: [{ kind: 'sticker', fileUniqueId: 'u1' }] }))).not.toContain('media_only')
  })

  it('emoji-only text is trust', () => {
    expect(trust(makeMsg({ text: '😂😂😂' }))).toContain('emoji_only')
  })

  it('short message with no suspicious signals is trust', () => {
    expect(trust(makeMsg({ text: 'дякую за відповідь' }))).toContain('short_message')
    expect(trust(makeMsg({ text: 'дякую bit.ly/x', urls: [{ visible: 'bit.ly/x', target: 'bit.ly/x', hidden: false }] }))).not.toContain('short_message')
  })

  it('never crashes on a fully empty message', () => {
    expect(() => extractMessageSignals(makeMsg())).not.toThrow()
  })

  it('suspicious helper sanity: empty message has no suspicious signals', () => {
    expect(suspicious(makeMsg())).toEqual([])
  })
})
