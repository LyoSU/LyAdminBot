import { describe, expect, it } from 'vitest'
import { Long, Message, PeersIndex } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import type { ChannelSenderFacts } from './normalize.js'
import { editBaselineOf, normalizeMessage, shouldScanChannelSender } from './normalize.js'

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
    expect(normalizeMessage(msg).forward).toEqual({ kind: 'hidden_user', title: 'Someone Hidden', sourceId: null })
  })

  it('maps channel forwards', () => {
    const msg = makeMessage({
      fwdFrom: { _: 'messageFwdHeader', fromId: { _: 'peerChannel', channelId: 555 }, date: 1_779_000_000 }
    })
    expect(normalizeMessage(msg).forward?.kind).toBe('channel')
  })

  it('an unverified reply is not a reply at all (2026-07-30 review)', () => {
    // A replyTo of nulls used to be emitted here, and the core reads any
    // non-null replyTo as `is_reply` — a −1.0 trust discount granted for a
    // claim nobody checked, which made "reply to anything" the cheapest
    // evasion available. No fetched target, no trust.
    const msg = makeMessage({
      replyTo: { _: 'messageReplyHeader', replyToMsgId: 5 }
    })
    expect(normalizeMessage(msg).replyTo).toBeNull()
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

  // Human-parity, continued (2026-07-30 review): the invariant was honoured for
  // todo checklists and quietly broken for every other media type that carries
  // words. A promo poll or a contact card arrived as EMPTY text, so the abstain
  // gate waved it through and no text layer ever saw it.
  it('extracts the poll question and options', () => {
    const msg = makeMessage({
      message: '',
      media: {
        _: 'messageMediaPoll',
        poll: {
          _: 'poll', id: 1n as never, question: { _: 'textWithEntities', text: 'Хочеш заробіток?', entities: [] },
          answers: [
            { _: 'pollAnswer', text: { _: 'textWithEntities', text: 'Так, пиши @promo_bot', entities: [] }, option: new Uint8Array([1]) },
            { _: 'pollAnswer', text: { _: 'textWithEntities', text: 'Ні', entities: [] }, option: new Uint8Array([2]) }
          ]
        },
        results: { _: 'pollResults' }
      } as unknown as tl.TypeMessageMedia
    })
    const n = normalizeMessage(msg)
    expect(n.attachments[0]?.kind).toBe('poll')
    expect(n.text).toContain('Хочеш заробіток?')
    expect(n.text).toContain('Так, пиши @promo_bot')
  })

  it('extracts the name and phone number of a contact card', () => {
    // A phone number reaching the chat with zero characters of message text.
    const msg = makeMessage({
      message: '',
      media: {
        _: 'messageMediaContact', phoneNumber: '380671234567',
        firstName: 'Анна', lastName: '', vcard: '', userId: 0n as never
      } as unknown as tl.TypeMessageMedia
    })
    const n = normalizeMessage(msg)
    expect(n.attachments[0]?.kind).toBe('contact')
    expect(n.text).toContain('380671234567')
    expect(n.text).toContain('Анна')
  })

  it('extracts invoice title/description and venue title/address', () => {
    const invoice = normalizeMessage(makeMessage({
      message: '',
      media: {
        _: 'messageMediaInvoice', title: 'Курс з трейдингу',
        description: 'Пиши в особисті', currency: 'USD', totalAmount: 100n as never, startParam: ''
      } as unknown as tl.TypeMessageMedia
    }))
    expect(invoice.text).toContain('Курс з трейдингу')
    expect(invoice.text).toContain('Пиши в особисті')

    const venue = normalizeMessage(makeMessage({
      message: '',
      media: {
        _: 'messageMediaVenue', geo: { _: 'geoPointEmpty' }, title: 'Казино Ліон',
        address: 'вул. Промо 1', provider: 'foursquare', venueId: 'x', venueType: ''
      } as unknown as tl.TypeMessageMedia
    }))
    expect(venue.attachments[0]?.kind).toBe('location')
    expect(venue.text).toContain('Казино Ліон')
  })

  it('extracts a giveaway prize description', () => {
    const msg = makeMessage({
      message: '',
      media: {
        _: 'messageMediaGiveaway', channels: [555], quantity: 1, months: 1,
        untilDate: 1_790_000_000, prizeDescription: 'iPhone за підписку'
      } as unknown as tl.TypeMessageMedia
    })
    expect(normalizeMessage(msg).text).toContain('iPhone за підписку')
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

  it('computes the edit delta against the previous baseline', () => {
    const before = normalizeMessage(makeMessage({ message: 'чистий текст без нічого' }))
    const after = normalizeMessage(
      makeMessage({
        message: 'чистий текст без нічого і лінк https://spam.example',
        entities: [{ _: 'messageEntityUrl', offset: 31, length: 21 }],
        editDate: 1_780_000_100
      }),
      { isEdit: true, previousBaseline: editBaselineOf(before) }
    )
    expect(after.isEdit).toBe(true)
    expect(after.editDelta).toEqual({ injectedUrls: 1, injectedMentions: 0, injectedInvisibles: 0 })
  })

  // The delta is a claim about two deliveries, so the ONLY thing that can
  // produce one is a caller that kept the first. A `null` here is what the
  // production wiring produced for every edit until 2026-08-24, with the signal
  // and its 0.93 rule fully tested and permanently unreachable.
  it('reports no delta when nothing remembers the earlier version', () => {
    const after = normalizeMessage(
      makeMessage({
        message: 'а тепер з лінком https://spam.example',
        entities: [{ _: 'messageEntityUrl', offset: 17, length: 20 }],
        editDate: 1_780_000_100
      }),
      { isEdit: true }
    )
    expect(after.isEdit).toBe(true)
    expect(after.editDelta).toBeNull()
  })

  // An edit that removes something is not an injection of a negative amount.
  it('floors the delta at zero when the edit removed content', () => {
    const before = normalizeMessage(makeMessage({
      message: 'два лінки https://a.example https://b.example',
      entities: [
        { _: 'messageEntityUrl', offset: 10, length: 17 },
        { _: 'messageEntityUrl', offset: 28, length: 17 }
      ]
    }))
    const after = normalizeMessage(
      makeMessage({ message: 'передумав', editDate: 1_780_000_100 }),
      { isEdit: true, previousBaseline: editBaselineOf(before) }
    )
    expect(after.editDelta).toEqual({ injectedUrls: 0, injectedMentions: 0, injectedInvisibles: 0 })
  })

  // A baseline is taken over the SAME string the delta is measured against —
  // text plus whatever the media contributed — or the two disagree and an
  // ordinary edit of a poll reads as an injection.
  it('takes the baseline over the media-inclusive text', () => {
    const withPoll = normalizeMessage(makeMessage({
      media: {
        _: 'messageMediaPoll',
        poll: {
          _: 'poll', id: long(1), question: { _: 'textWithEntities', text: 'Заробіток?', entities: [] },
          answers: [
            { _: 'pollAnswer', text: { _: 'textWithEntities', text: 'так', entities: [] }, option: new Uint8Array([1]) }
          ]
        },
        results: { _: 'pollResults' }
      } as unknown as tl.TypeMessageMedia
    }))
    expect(withPoll.text).toContain('Заробіток?')
    expect(editBaselineOf(withPoll)).toMatchObject({ urls: 0, mentions: 0, invisibles: 0 })
  })

  // The attack a count cannot see: the message keeps ONE link and the link is a
  // different one. Every length-based delta reports nothing injected.
  it('sees a link swapped for another link', () => {
    const before = normalizeMessage(makeMessage({
      message: 'ось стаття https://news.example/a',
      entities: [{ _: 'messageEntityUrl', offset: 11, length: 22 }]
    }))
    const after = normalizeMessage(
      makeMessage({
        message: 'ось стаття https://spam.example/x',
        entities: [{ _: 'messageEntityUrl', offset: 11, length: 22 }],
        editDate: 1_780_000_100
      }),
      { isEdit: true, previousBaseline: editBaselineOf(before) }
    )
    expect(after.editDelta?.injectedUrls).toBe(1)
  })

  // …and the other side of it: the same link written again is not an injection.
  it('does not count the same destination re-spelled', () => {
    const before = normalizeMessage(makeMessage({
      message: 'ось https://News.Example/a/',
      entities: [{ _: 'messageEntityUrl', offset: 4, length: 23 }]
    }))
    const after = normalizeMessage(
      makeMessage({
        message: 'ось https://news.example/a і ще слово',
        entities: [{ _: 'messageEntityUrl', offset: 4, length: 22 }],
        editDate: 1_780_000_100
      }),
      { isEdit: true, previousBaseline: editBaselineOf(before) }
    )
    expect(after.editDelta?.injectedUrls).toBe(0)
  })

  it('counts injected invisible characters on edit', () => {
    const before = normalizeMessage(makeMessage({ message: 'Доброго дня' }))
    const after = normalizeMessage(
      makeMessage({ message: 'Доб⁠рого дня', editDate: 1_780_000_100 }),
      { isEdit: true, previousBaseline: editBaselineOf(before) }
    )
    expect(after.editDelta?.injectedInvisibles).toBe(1)
  })
})

// ── channel senders ───────────────────────────────────────────────────

describe('normalizeMessage — albums', () => {
  const photo = (overrides: Partial<tl.RawMessage> = {}): Message => makeMessage({
    media: {
      _: 'messageMediaPhoto',
      photo: {
        _: 'photo', id: long(1), accessHash: long(1), fileReference: new Uint8Array(),
        date: 1_780_000_000, sizes: [{ _: 'photoSize', type: 'x', w: 100, h: 100, size: 1000 }], dcId: 2
      }
    } as unknown as tl.TypeMessageMedia,
    groupedId: long(7),
    ...overrides
  })

  // The whole point: a Telegram album is one post whose caption may ride on any
  // part. Judging the first part alone read a ten-photo advert as silent photos.
  it('reads a caption that rides on a later part', () => {
    const n = normalizeMessage(photo({ id: 10 }), {
      albumSiblings: [
        photo({ id: 11 }),
        photo({ id: 12, message: 'заробіток тут https://spam.example', entities: [{ _: 'messageEntityUrl', offset: 14, length: 20 }] })
      ]
    })
    expect(n.text).toContain('заробіток тут')
    expect(n.urls.map((u) => u.target)).toEqual(['https://spam.example'])
  })

  it('counts every part as an attachment', () => {
    const n = normalizeMessage(photo({ id: 10 }), {
      albumSiblings: [photo({ id: 11 }), photo({ id: 12 })]
    })
    expect(n.attachments).toHaveLength(3)
    expect(n.attachments.every((a) => a.kind === 'photo')).toBe(true)
  })

  // Identity belongs to the post, not to each part: the verdict, the decision
  // record and the deletion all address the message the album was delivered as.
  it('keeps the identity of the first part', () => {
    const n = normalizeMessage(photo({ id: 10 }), { albumSiblings: [photo({ id: 11 })] })
    expect(n.messageId).toBe(10)
  })

  // One link repeated across three photos is one link. Charging it three times
  // would double-bill the promo-URL group the correlated ceilings exist to cap.
  it('counts a link repeated across parts once', () => {
    const captioned = (id: number): Message => photo({
      id,
      message: 'дивись https://spam.example',
      entities: [{ _: 'messageEntityUrl', offset: 7, length: 20 }]
    })
    const n = normalizeMessage(captioned(10), { albumSiblings: [captioned(11), captioned(12)] })
    expect(n.urls).toHaveLength(1)
  })

  // Nothing about the ordinary single message may change: the merge is only
  // reached when the gateway actually buffered an album.
  it('leaves a lone message byte-identical to the unmerged reading', () => {
    const alone = makeMessage({ message: 'звичайне повідомлення @some_bot' })
    expect(normalizeMessage(alone, { albumSiblings: [] })).toEqual(normalizeMessage(alone))
  })
})

describe('shouldScanChannelSender', () => {
  const facts = (over: Partial<ChannelSenderFacts> = {}): ChannelSenderFacts => ({
    senderId: -1000, chatId: -2000, isAutomaticForward: false, isChannelPost: false, ...over
  })

  it('scans a member posting as a channel they own', () => {
    // The one delivery method that advertises a channel by construction, and a
    // live spam vector — it must stay judged like any other sender.
    expect(shouldScanChannelSender(facts())).toBe(true)
  })

  it('never judges the chat posting as itself', () => {
    // Production 2026-07-31: a chat's own announcement reached a ban verdict.
    // Only an anonymous administrator can send as the chat, so the target of
    // that ban would have been the chat itself.
    expect(shouldScanChannelSender(facts({ senderId: -2000, chatId: -2000 }))).toBe(false)
  })

  it('never judges the linked channel mirrored into its discussion group', () => {
    expect(shouldScanChannelSender(facts({ isAutomaticForward: true }))).toBe(false)
  })

  it('never judges a post inside a broadcast channel', () => {
    expect(shouldScanChannelSender(facts({ isChannelPost: true }))).toBe(false)
  })
})
