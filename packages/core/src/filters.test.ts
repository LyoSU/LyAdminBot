import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { NormalizedMessage } from './types.js'
import {
  DEFAULT_FILTERS, FILTERABLE_SCRIPTS, LOCK_KINDS, filterActionFor, filterReasonCode, filterRuleId,
  hasActiveFilters, isChatFilterVerdict, matchFilters, normalizeFilters, toggleIn,
  type ChatFilters
} from './filters.js'

const msg = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  chatId: -1, messageId: 1, threadId: null, date: 0, isEdit: false, editDate: 0,
  text: '', urls: [], mentions: [], attachments: [], inlineButtons: [],
  forward: null, replyTo: null, channelComment: null, editDelta: null,
  customEmoji: [], guestBot: null,
  ...over
})

const filters = (over: Partial<ChatFilters> = {}): ChatFilters => ({ ...DEFAULT_FILTERS, ...over })

const check = (f: ChatFilters, text: string, extra: { name?: string; newcomer?: boolean; m?: Partial<NormalizedMessage> } = {}) =>
  matchFilters(f, {
    message: msg({ text, ...extra.m }),
    displayName: extra.name ?? 'Member',
    newcomer: extra.newcomer ?? true
  })

describe('script filter', () => {
  const arabic = filters({ scripts: ['arabic'] })

  it('removes a message written mostly in a blocked script (Farsi)', () => {
    expect(check(arabic, 'سلام دوستان، کار آنلاین با درآمد عالی')).toMatchObject({ kind: 'script', script: 'arabic' })
  })

  it('leaves a message where the blocked script is the minority', () => {
    expect(check(arabic, 'Привіт усім, хтось знає як перекласти слово سلام правильно?')).toBeNull()
  })

  it('needs more than half, not half', () => {
    // 4 Arabic letters against 4 Latin ones: exactly half.
    expect(check(arabic, 'سلام abcd')).toBeNull()
  })

  it('ignores a stray character below the content bar', () => {
    expect(check(filters({ scripts: ['han'] }), '好 👍')).toBeNull()
  })

  it('counts two Han characters as enough content', () => {
    expect(check(filters({ scripts: ['han'] }), '你好')).toMatchObject({ kind: 'script', script: 'han' })
  })

  it('does not let links and handles outvote the text', () => {
    expect(check(filters({ scripts: ['han'] }), '加我微信赚钱 https://example.com/very/long/latin/path @somehandle'))
      .toMatchObject({ kind: 'script', script: 'han' })
  })

  it('sums every blocked script, so a mixed alien message still counts', () => {
    const f = filters({ scripts: ['arabic', 'hebrew'] })
    expect(check(f, 'سلام שלום abc')).toMatchObject({ kind: 'script' })
  })

  it('blocking Japanese catches kanji-heavy Japanese and spares Chinese', () => {
    const japanese = filters({ scripts: ['kana'] })
    // More kanji than kana — kana alone would be a minority.
    expect(check(japanese, '日本語学習者募集中です')).toMatchObject({ kind: 'script', script: 'kana' })
    expect(check(japanese, '欢迎大家来到这个群组')).toBeNull()
  })

  it('judges a newcomer’s name only when asked to, and only a newcomer’s', () => {
    const named = filters({ scripts: ['arabic'], nameScripts: true })
    expect(check(filters({ scripts: ['arabic'] }), 'Привіт', { name: 'محمد رضا' })).toBeNull()
    expect(check(named, 'Привіт', { name: 'محمد رضا' })).toMatchObject({ kind: 'name_script' })
    expect(check(named, 'Привіт', { name: 'محمد رضا', newcomer: false })).toBeNull()
  })

  it('text-only scripts: no letters at all is never a hit', () => {
    expect(check(filters({ scripts: [...FILTERABLE_SCRIPTS] }), '👍👍 123 !!!')).toBeNull()
    expect(check(filters({ scripts: [...FILTERABLE_SCRIPTS] }), '')).toBeNull()
  })
})

describe('locks', () => {
  it.each([
    ['stickers', { attachments: [{ kind: 'sticker', fileUniqueId: null }] }],
    ['gifs', { attachments: [{ kind: 'animation', fileUniqueId: null }] }],
    ['voice', { attachments: [{ kind: 'voice', fileUniqueId: null }] }],
    ['video_notes', { attachments: [{ kind: 'video_note', fileUniqueId: null }] }],
    ['media', { attachments: [{ kind: 'photo', fileUniqueId: null }] }],
    ['stories', { attachments: [{ kind: 'story', fileUniqueId: null }] }],
    ['contacts', { attachments: [{ kind: 'contact', fileUniqueId: null }] }],
    ['polls', { attachments: [{ kind: 'poll', fileUniqueId: null }] }],
    ['forwards', { forward: { kind: 'user', title: null } }],
    ['channel_forwards', { forward: { kind: 'channel', title: 'X' } }],
    ['buttons', { inlineButtons: [{ text: 'Go', url: null }] }],
    ['links', { urls: [{ visible: 'example.com', target: 'https://example.com', hidden: false }] }],
    ['tg_links', { urls: [{ visible: 'here', target: 'https://t.me/+abc', hidden: true }] }]
  ] as const)('%s catches its own kind', (lock, m) => {
    expect(check(filters({ locks: [lock] }), 'text', { m: m as Partial<NormalizedMessage> }))
      .toEqual({ kind: 'lock', lock })
  })

  it('a link that is not Telegram does not trip the t.me lock', () => {
    expect(check(filters({ locks: ['tg_links'] }), 'x', {
      m: { urls: [{ visible: 'example.com', target: 'https://example.com', hidden: false }] }
    })).toBeNull()
  })

  it('a user forward does not trip the channel-forward lock', () => {
    expect(check(filters({ locks: ['channel_forwards'] }), 'x', { m: { forward: { kind: 'user', title: null } } }))
      .toBeNull()
  })

  it('a plain text message trips no lock at all', () => {
    expect(check(filters({ locks: [...LOCK_KINDS] }), 'Звичайне повідомлення')).toBeNull()
  })
})

describe('scope and action', () => {
  it('newcomers-only spares a member with standing entirely', () => {
    const f = filters({ locks: ['stickers'], newcomersOnly: true })
    const sticker = { attachments: [{ kind: 'sticker' as const, fileUniqueId: null }] }
    expect(check(f, '', { m: sticker, newcomer: false })).toBeNull()
    expect(check(f, '', { m: sticker, newcomer: true })).not.toBeNull()
  })

  it('a member with standing only ever loses the message', () => {
    for (const action of ['delete', 'mute', 'ban'] as const) {
      expect(filterActionFor(action, { newcomer: false, isChannel: false })).toBe('delete')
    }
  })

  it('a newcomer gets what the chat configured; a channel is never muted', () => {
    expect(filterActionFor('ban', { newcomer: true, isChannel: false })).toBe('ban')
    expect(filterActionFor('mute', { newcomer: true, isChannel: false })).toBe('mute')
    expect(filterActionFor('mute', { newcomer: true, isChannel: true })).toBe('delete')
    expect(filterActionFor('ban', { newcomer: true, isChannel: true })).toBe('ban')
  })

  it('names each hit for the record', () => {
    expect(filterRuleId({ kind: 'lock', lock: 'gifs' })).toBe('filter:lock:gifs')
    expect(filterRuleId({ kind: 'script', script: 'han', share: 1 })).toBe('filter:script:han')
    expect(filterReasonCode({ kind: 'name_script', script: 'arabic', share: 1 })).toBe('filter_name')
    expect(isChatFilterVerdict({ decidedBy: 'chat_filter' })).toBe(true)
    expect(isChatFilterVerdict({ decidedBy: 'custom_rule' })).toBe(false)
  })
})

describe('stored settings', () => {
  it('reads anything at all without throwing, degrading to off', () => {
    for (const raw of [null, undefined, 1, 'x', [], { scripts: 'arabic' }, { locks: [1, null] }]) {
      expect(normalizeFilters(raw)).toEqual(DEFAULT_FILTERS)
    }
  })

  it('drops unknown entries and duplicates, keeps known ones in catalogue order', () => {
    expect(normalizeFilters({
      scripts: ['han', 'klingon', 'arabic', 'han'], locks: ['gifs', 'stickers'], action: 'nuke', nameScripts: 'yes'
    })).toEqual({ ...DEFAULT_FILTERS, scripts: ['arabic', 'han'], locks: ['stickers', 'gifs'] })
  })

  it('toggling twice is the identity, for every entry', () => {
    const start = ['arabic', 'thai'] as const
    for (const s of FILTERABLE_SCRIPTS) {
      expect(toggleIn(FILTERABLE_SCRIPTS, toggleIn(FILTERABLE_SCRIPTS, start, s), s)).toEqual([...start])
    }
  })

  it('a filter set with nothing on is inactive', () => {
    expect(hasActiveFilters(undefined)).toBe(false)
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false)
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, nameScripts: true })).toBe(false)
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, locks: ['gifs'] })).toBe(true)
  })
})

describe('properties', () => {
  const everything = filters({ scripts: [...FILTERABLE_SCRIPTS], locks: [...LOCK_KINDS], nameScripts: true })

  it('never throws, whatever the text and name', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (text, name) => {
      check(everything, text, { name })
    }))
  })

  it('nothing switched on never hits', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => {
      expect(check(DEFAULT_FILTERS, text)).toBeNull()
    }))
  })

  it('appending Cyrillic never turns an allowed message into a blocked one', () => {
    const f = filters({ scripts: ['arabic', 'han'] })
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.stringMatching(/^[а-яії ]{1,40}$/), (text, tail) => {
      if (check(f, text) === null) expect(check(f, `${text} ${tail}`)).toBeNull()
    }))
  })
})
