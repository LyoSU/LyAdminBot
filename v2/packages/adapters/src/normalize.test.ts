import { describe, expect, it } from 'vitest'
import { Long, Message, PeersIndex } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import { normalizeMessage } from './normalize.js'

const long = (n: number): Long => Long.fromNumber(n)

// ── fixture builders ──────────────────────────────────────────────────

const makePeers = (): PeersIndex => {
  const peers = new PeersIndex()
  peers.users.set(42, {
    _: 'user', id: 42, accessHash: 1n, firstName: 'Sender', username: 'sender'
  } as unknown as tl.RawUser)
  peers.users.set(99, {
    _: 'user', id: 99, accessHash: 1n, firstName: 'Other'
  } as unknown as tl.RawUser)
  peers.users.set(777, {
    _: 'user', id: 777, accessHash: 1n, firstName: 'GuestBot', username: 'guest_bot', bot: true
  } as unknown as tl.RawUser)
  peers.chats.set(123, {
    _: 'channel', id: 123, accessHash: 1n, title: 'Group', megagroup: true
  } as unknown as tl.RawChannel)
  peers.chats.set(555, {
    _: 'channel', id: 555, accessHash: 1n, title: 'News Channel', broadcast: true
  } as unknown as tl.RawChannel)
  return peers
}

const makeRaw = (overrides: Partial<tl.RawMessage> = {}): tl.RawMessage => ({
  _: 'message',
  id: 10,
  peerId: { _: 'peerChannel', channelId: 123 },
  fromId: { _: 'peerUser', userId: 42 },
  date: 1_780_000_000,
  message: '',
  ...overrides
} as tl.RawMessage)

const makeMessage = (overrides: Partial<tl.RawMessage> = {}): Message =>
  new Message(makeRaw(overrides), makePeers())

// ── tests ─────────────────────────────────────────────────────────────

describe('normalizeMessage — basics', () => {
  it('maps ids, date and text', () => {
    const n = normalizeMessage(makeMessage({ message: 'привіт' }))
    expect(n.chatId).toBe(-1000000000123)
    expect(n.messageId).toBe(10)
    expect(n.date).toBe(1_780_000_000)
    expect(n.text).toBe('привіт')
    expect(n.isEdit).toBe(false)
  })

  it('extracts urls from url and text_link entities', () => {
    const msg = makeMessage({
      message: 'тут https://example.com і тут',
      entities: [
        { _: 'messageEntityUrl', offset: 4, length: 19 },
        { _: 'messageEntityTextUrl', offset: 26, length: 3, url: 'https://hidden.example' }
      ]
    })
    const n = normalizeMessage(msg)
    expect(n.urls).toContainEqual({ visible: 'https://example.com', target: 'https://example.com', hidden: false })
    expect(n.urls).toContainEqual({ visible: 'тут', target: 'https://hidden.example', hidden: true })
  })

  it('catches plain-text t.me links even without entities (spammer trick)', () => {
    const n = normalizeMessage(makeMessage({ message: 'заходь t.me/+AbCdEf тут' }))
    expect(n.urls.some((u) => u.target.includes('t.me/+AbCdEf'))).toBe(true)
  })

  it('extracts mentions without the @ prefix', () => {
    const msg = makeMessage({
      message: 'привіт @sender і @other_user',
      entities: [
        { _: 'messageEntityMention', offset: 7, length: 7 },
        { _: 'messageEntityMention', offset: 17, length: 11 }
      ]
    })
    expect(normalizeMessage(msg).mentions).toEqual(['sender', 'other_user'])
  })

  it('extracts custom emoji with their alt characters', () => {
    const msg = makeMessage({
      message: 'дзвони 8',
      entities: [{ _: 'messageEntityCustomEmoji', offset: 7, length: 1, documentId: long(555) }]
    })
    const n = normalizeMessage(msg)
    expect(n.customEmoji).toEqual([{ id: '555', alt: '8' }])
  })

  it('extracts inline buttons with urls', () => {
    const msg = makeMessage({
      message: 'тисни',
      replyMarkup: {
        _: 'replyInlineMarkup',
        rows: [{
          _: 'keyboardButtonRow',
          buttons: [
            { _: 'keyboardButtonUrl', text: 'GO', url: 'https://x.example' },
            { _: 'keyboardButtonCallback', text: 'ok', data: new Uint8Array() }
          ]
        }]
      }
    })
    const n = normalizeMessage(msg)
    expect(n.inlineButtons).toEqual([
      { text: 'GO', url: 'https://x.example' },
      { text: 'ok', url: null }
    ])
  })
})

describe('normalizeMessage — forwards & replies', () => {
  it('maps hidden-user forwards', () => {
    const msg = makeMessage({
      fwdFrom: { _: 'messageFwdHeader', fromName: 'Someone Hidden', date: 1_779_000_000 }
    })
    expect(normalizeMessage(msg).forward).toEqual({ kind: 'hidden_user', title: 'Someone Hidden' })
  })

  it('maps channel forwards', () => {
    const msg = makeMessage({
      fwdFrom: { _: 'messageFwdHeader', fromId: { _: 'peerChannel', channelId: 555 }, date: 1_779_000_000 }
    })
    expect(normalizeMessage(msg).forward?.kind).toBe('channel')
  })

  it('keeps reply info minimal when the replied message was not fetched', () => {
    const msg = makeMessage({
      replyTo: { _: 'messageReplyHeader', replyToMsgId: 5 }
    })
    const n = normalizeMessage(msg)
    expect(n.replyTo).toEqual({ authorId: null, isSelf: false, ageSeconds: null, textPreview: null })
  })

  it('fills reply details from the fetched replied message', () => {
    const replied = new Message(
      makeRaw({ id: 5, fromId: { _: 'peerUser', userId: 99 }, date: 1_779_999_900, message: 'оригінал' }),
      makePeers()
    )
    const msg = makeMessage({ replyTo: { _: 'messageReplyHeader', replyToMsgId: 5 }, message: 'відповідь' })
    const n = normalizeMessage(msg, { repliedMessage: replied })
    expect(n.replyTo).toEqual({ authorId: 99, isSelf: false, ageSeconds: 100, textPreview: 'оригінал' })
  })

  it('detects replies to self', () => {
    const replied = new Message(makeRaw({ id: 5, date: 1_779_999_000, message: 'перше' }), makePeers())
    const msg = makeMessage({ replyTo: { _: 'messageReplyHeader', replyToMsgId: 5 } })
    expect(normalizeMessage(msg, { repliedMessage: replied }).replyTo?.isSelf).toBe(true)
  })

  it('detects channel-post comments (discussion groups)', () => {
    const post = new Message(
      makeRaw({
        id: 5,
        fromId: { _: 'peerChannel', channelId: 555 },
        date: 1_779_999_000,
        message: 'Текст посту в каналі'
      }),
      makePeers()
    )
    const msg = makeMessage({ replyTo: { _: 'messageReplyHeader', replyToMsgId: 5 }, message: 'коментар' })
    const n = normalizeMessage(msg, { repliedMessage: post })
    expect(n.channelComment?.channelTitle).toBe('News Channel')
    expect(n.channelComment?.postPreview).toContain('Текст посту')
  })

  it('extracts the thread id', () => {
    const msg = makeMessage({
      replyTo: { _: 'messageReplyHeader', replyToMsgId: 7, replyToTopId: 3 }
    })
    expect(normalizeMessage(msg).threadId).toBe(3)
  })
})

describe('normalizeMessage — media', () => {
  it('maps photos with file ids', () => {
    const msg = makeMessage({
      media: {
        _: 'messageMediaPhoto',
        photo: {
          _: 'photo', id: long(1), accessHash: long(1), fileReference: new Uint8Array(),
          date: 1_780_000_000, sizes: [{ _: 'photoSize', type: 'x', w: 100, h: 100, size: 1000 }], dcId: 2
        }
      }
    })
    const n = normalizeMessage(msg)
    expect(n.attachments[0]?.kind).toBe('photo')
  })

  it('maps paid media (content invisible until paid — strong signal)', () => {
    const msg = makeMessage({
      media: { _: 'messageMediaPaidMedia', starsAmount: long(50), extendedMedia: [] }
    })
    expect(normalizeMessage(msg).attachments[0]?.kind).toBe('paid_media')
  })

  it('maps giveaways even though mtcute high-level ignores them', () => {
    const msg = makeMessage({
      media: {
        _: 'messageMediaGiveaway', channels: [555], quantity: 10, months: 3, untilDate: 1_790_000_000
      }
    })
    expect(normalizeMessage(msg).attachments[0]?.kind).toBe('giveaway')
  })

  it('maps todo checklists AND extracts task texts into text (human-parity)', () => {
    const msg = makeMessage({
      message: '',
      media: {
        _: 'messageMediaToDo',
        todo: {
          _: 'todoList',
          title: { _: 'textWithEntities', text: 'Заробіток', entities: [] },
          list: [
            { _: 'todoItem', id: 1, title: { _: 'textWithEntities', text: 'Пиши в особисті', entities: [] } },
            { _: 'todoItem', id: 2, title: { _: 'textWithEntities', text: 'Отримай 500$', entities: [] } }
          ]
        }
      }
    })
    const n = normalizeMessage(msg)
    expect(n.attachments[0]?.kind).toBe('todo')
    expect(n.text).toContain('Заробіток')
    expect(n.text).toContain('Пиши в особисті')
    expect(n.text).toContain('Отримай 500$')
  })

  it('maps unknown media constructors to kind unknown (never drop silently)', () => {
    const msg = makeMessage({
      media: { _: 'messageMediaFancyFutureThing' } as unknown as tl.TypeMessageMedia
    })
    expect(normalizeMessage(msg).attachments[0]?.kind).toBe('unknown')
  })

  it('adds webpage preview url as a hidden url when not present in text', () => {
    const msg = makeMessage({
      message: 'просто текст',
      media: {
        _: 'messageMediaWebPage',
        webpage: { _: 'webPage', id: long(1), url: 'https://sneaky.example', displayUrl: 'sneaky.example', hash: 0 }
      }
    })
    const n = normalizeMessage(msg)
    expect(n.urls.some((u) => u.target === 'https://sneaky.example' && u.hidden)).toBe(true)
  })
})

describe('normalizeMessage — guest bots & edits', () => {
  it('detects guest-bot deliveries via guestchatViaFrom', () => {
    const msg = makeMessage({
      fromId: { _: 'peerUser', userId: 777 },
      guestchatViaFrom: { _: 'peerUser', userId: 42 },
      message: 'я гостьовий бот'
    } as Partial<tl.RawMessage>)
    const n = normalizeMessage(msg)
    expect(n.guestBot).toEqual({ botId: 777, botUsername: 'guest_bot', callerId: 42 })
  })

  it('computes the edit delta against the previous normalization', () => {
    const before = normalizeMessage(makeMessage({ message: 'чистий текст без нічого' }))
    const after = normalizeMessage(
      makeMessage({
        message: 'чистий текст без нічого і лінк https://spam.example',
        entities: [{ _: 'messageEntityUrl', offset: 31, length: 21 }],
        editDate: 1_780_000_100
      }),
      { isEdit: true, previous: before }
    )
    expect(after.isEdit).toBe(true)
    expect(after.editDelta).toEqual({ injectedUrls: 1, injectedMentions: 0, injectedInvisibles: 0 })
  })

  it('counts injected invisible characters on edit', () => {
    const before = normalizeMessage(makeMessage({ message: 'Доброго дня' }))
    const after = normalizeMessage(
      makeMessage({ message: 'Доб⁠рого дня', editDate: 1_780_000_100 }),
      { isEdit: true, previous: before }
    )
    expect(after.editDelta?.injectedInvisibles).toBe(1)
  })
})
