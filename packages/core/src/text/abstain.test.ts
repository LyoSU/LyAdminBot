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
  replyTo: null,
  ...overrides
})

/** A sender this chat has never seen — the `new_in_chat` signal. */
const stranger = { stranger: true }

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


/**
 * A handle is a pointer, and a pointer from somebody the chat has never met is
 * content — the same treatment `t.me/handle` already gets three lines above.
 *
 * Measured 2026-08-26 over one retention window: of 121 abstained messages
 * carrying a handle, 25 carried it somewhere other than the opening. Every one
 * of those 25 from a sender with `new_in_chat` was spam (16); every one from a
 * sender without it was ordinary conversation (9). The split is what the rule
 * below encodes — nothing more.
 */
describe('shouldAbstain — a trailing handle from a stranger is a pointer', () => {
  test('REGRESSION: slogan plus handle is classified, not waved through', () => {
    // Production 2026-08-26: a brand-new account's first-ever message. Stripping
    // the handle left 16 informative characters against a bar of 20, so the
    // cleanest possible advert — a slogan, an arrow and a handle — was the one
    // shape guaranteed to pass. Five characters of padding would have failed it.
    expect(shouldAbstain(msg({ text: 'ПОТУЖНАЯ работа  => @xardkorr', mentions: ['xardkorr'] }), stranger))
      .toBe(false)
    expect(shouldAbstain(msg({ text: 'Лучший канал тут @promo_chan', mentions: ['promo_chan'] }), stranger))
      .toBe(false)
  })

  test('the same message from somebody the chat knows is still addressing', () => {
    expect(shouldAbstain(msg({ text: 'Ігоре коли на пиво @Gwinbllade', mentions: ['Gwinbllade'] })))
      .toBe(true)
  })

  test('a handle that OPENS the message is a salutation, whoever sends it', () => {
    // The bare-@username roulette this gate was built for. A stranger saying
    // "@somebody альо" is asking somebody a question, and the model has no more
    // to go on than we do.
    expect(shouldAbstain(msg({ text: '@wwwrize альо', mentions: ['wwwrize'] }), stranger)).toBe(true)
    expect(shouldAbstain(msg({ text: '@Mrph_Mrph', mentions: ['Mrph_Mrph'] }), stranger)).toBe(true)
  })

  test('a handle before a handle is not content', () => {
    // Counting the first handle as the "content" that makes the second a
    // pointer would re-open the gate on exactly the bare-handle class it exists
    // to close. Tagging three people is addressing three people.
    expect(shouldAbstain(msg({ text: '@olena_kovh @petro_vas @maria_sok', mentions: ['olena_kovh', 'petro_vas', 'maria_sok'] }), stranger))
      .toBe(true)
  })

  test('decoration is not content either', () => {
    expect(shouldAbstain(msg({ text: '🧧 @promo_chan', mentions: ['promo_chan'] }), stranger)).toBe(true)
  })

  test('a reply is addressing by construction', () => {
    // Whoever they are answering is in the conversation, so the handle names
    // somebody present — which is the premise the stripping rule rests on.
    expect(shouldAbstain(
      msg({
        text: 'дякую @vasya',
        mentions: ['vasya'],
        replyTo: { authorId: 42, isSelf: false, ageSeconds: 12, textPreview: null }
      }),
      stranger
    )).toBe(true)
  })

  test('a bot command carries its target, it does not point at it', () => {
    expect(shouldAbstain(msg({ text: '/start@MissRose_bot botstart', mentions: ['MissRose_bot'] }), stranger))
      .toBe(true)
    // ...but a command with an argument and then handles is a pointer again.
    expect(shouldAbstain(msg({ text: '/start 260 @ckfj0trbot\n@utxkbbot', mentions: ['ckfj0trbot', 'utxkbbot'] }), stranger))
      .toBe(false)
  })

  test('no whitespace is needed in front of the handle', () => {
    // `(^|\s)@` would have missed this; the shared handle grammar only refuses a
    // letter, digit or `/` immediately before the `@`.
    expect(shouldAbstain(msg({ text: 'работа=>@xardkorr', mentions: ['xardkorr'] }), stranger))
      .toBe(false)
  })

  test('punctuation and bare numbers are not something somebody said', () => {
    expect(shouldAbstain(msg({ text: '=> @promo_chan', mentions: ['promo_chan'] }), stranger)).toBe(true)
    expect(shouldAbstain(msg({ text: '+1 @promo_chan', mentions: ['promo_chan'] }), stranger)).toBe(true)
  })

  test('the vocative is not a handle, so it cannot be a pointer', () => {
    // `@всім` fails Telegram's grammar — letter-leading ASCII, 5 to 32.
    expect(shouldAbstain(msg({ text: 'привіт усім @всім' }), stranger)).toBe(true)
  })

  test('an email address is not a handle either', () => {
    expect(shouldAbstain(msg({ text: 'пишіть на ivan@example.com' }), stranger)).toBe(true)
  })

  test('the sender default is the cautious one', () => {
    // Every existing caller passes no sender and must keep the old answer.
    expect(shouldAbstain(msg({ text: 'ПОТУЖНАЯ работа  => @xardkorr', mentions: ['xardkorr'] })))
      .toBe(true)
  })
})


/**
 * The complement of the rule above, and the case it structurally cannot see:
 * handle spam with no words in it at all.
 *
 * Measured 2026-08-26 across 3680 decisions the bot let stand: ten messages are
 * nothing but bot handles and a red-envelope emoji, every one from an account
 * new to its chat, none acted on. Against the 1293 of those decisions whose
 * sender carries `established_user` or `trusted_reputation` — the closest thing
 * to a known-good population — the same shape matches ZERO.
 *
 * What settles it is the contrast set: `@nictiobot @gtqo0bfxbot @jsjekxybot 🧧`
 * appears in the acted set too, banned as `guest_bot_promo`. The identical text
 * is both ban-worthy and "too little to judge" depending on which stage reaches
 * it first — the campaign rotates handles (16 across 7 combinations), so exact
 * signatures keep missing and the bot only catches it once five have piled up.
 *
 * Bots specifically, because that is what survives the obvious objection:
 * tagging three admins, listing a roster or crediting friends are all people.
 * Telegram requires a bot username to end in "bot", so the distinction is
 * readable from the text alone.
 */
describe('shouldAbstain — a message that is nothing but bot handles', () => {
  test('REGRESSION: a bot-handle drop is classified, not buffered', () => {
    expect(shouldAbstain(msg({ text: '@nictiobot @gtqo0bfxbot @jsjekxybot  🧧', mentions: ['nictiobot', 'gtqo0bfxbot', 'jsjekxybot'] }), stranger))
      .toBe(false)
    expect(shouldAbstain(msg({ text: '@asnzabot @erwtagbot @yredefbot', mentions: ['asnzabot', 'erwtagbot', 'yredefbot'] }), stranger))
      .toBe(false)
  })

  test('one bot is somebody asking a bot something', () => {
    expect(shouldAbstain(msg({ text: '@lybot', mentions: ['lybot'] }), stranger)).toBe(true)
  })

  test('a word anywhere means somebody was talking', () => {
    expect(shouldAbstain(msg({ text: 'спробуй @asnzabot @erwtagbot', mentions: ['asnzabot', 'erwtagbot'] })))
      .toBe(true)
  })

  test('people are not bots', () => {
    expect(shouldAbstain(msg({ text: '@olena_kovh @petro_vas @maria_sok', mentions: ['olena_kovh', 'petro_vas', 'maria_sok'] }), stranger))
      .toBe(true)
  })

  test('a member the chat knows may post whatever handles they like', () => {
    expect(shouldAbstain(msg({ text: '@nictiobot @gtqo0bfxbot 🧧', mentions: ['nictiobot', 'gtqo0bfxbot'] })))
      .toBe(true)
  })
})
