import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, FILTERABLE_SCRIPTS, LOCK_KINDS, type ChatFilters, type Verdict } from '@lyadmin/core'
import {
  filtersPanel, filterScriptsPanel, filterLocksPanel, filterListPanel, entryTag, warnPanel, warnNotice,
  rulesPanel, rulesView, settingsPanel, whyView, LOCALES
} from './views.js'

/** The longest chat id Telegram issues, so every button is measured at its worst. */
const CHAT = -1009999999999

const everything: ChatFilters = {
  scripts: [...FILTERABLE_SCRIPTS], locks: [...LOCK_KINDS], nameScripts: true,
  words: ['казино', 'заробіт*'], domains: ['example.com', 't.me/mychannel'],
  flood: { messages: 5, seconds: 10 }, action: 'ban', newcomersOnly: true
}

const screens = (f: ChatFilters) => Object.values(LOCALES).flatMap((locale) => [
  filtersPanel(locale, CHAT, f), filterScriptsPanel(locale, CHAT, f), filterLocksPanel(locale, CHAT, f)
])

describe('filters screens', () => {
  it('every button fits Telegram’s 64-byte callback limit, in every locale', () => {
    for (const view of screens(everything)) {
      for (const row of view.buttons) for (const b of row) {
        if (b.data) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })

  it('every screen leads back, and the lists lead back to the filters screen', () => {
    for (const locale of Object.values(LOCALES)) {
      const last = (v: ReturnType<typeof filtersPanel>) => v.buttons.at(-1)![0]!.data
      expect(last(filtersPanel(locale, CHAT, DEFAULT_FILTERS))).toBe(`set:${CHAT}:root`)
      expect(last(filterScriptsPanel(locale, CHAT, DEFAULT_FILTERS))).toBe(`set:${CHAT}:flt`)
      expect(last(filterLocksPanel(locale, CHAT, DEFAULT_FILTERS))).toBe(`set:${CHAT}:flt`)
    }
  })

  it('marks exactly the entries that are on', () => {
    const uk = LOCALES['uk']!
    const f: ChatFilters = { ...DEFAULT_FILTERS, scripts: ['arabic', 'han'] }
    const marked = filterScriptsPanel(uk, CHAT, f).buttons.flat().filter((b) => b.text.startsWith('✓ '))
    expect(marked.map((b) => b.data)).toEqual([`set:${CHAT}:flt_s:arabic`, `set:${CHAT}:flt_s:han`])
    expect(filtersPanel(uk, CHAT, f).text).toContain('Арабська, фарсі, Китайська')
  })

  it('the root panel names the filters and opens them', () => {
    const uk = LOCALES['uk']!
    const state = {
      enabled: true, preset: 'standard' as const, captchaEnabled: true, votingEnabled: true,
      externalBanEnabled: true, quietMode: false, bananDefaultSeconds: 600, locale: 'uk'
    }
    expect(settingsPanel(uk, CHAT, state).text).toContain('Фільтри: вимкнено')
    const on = settingsPanel(uk, CHAT, { ...state, filters: { ...DEFAULT_FILTERS, scripts: ['han'], locks: ['gifs', 'voice'] } })
    expect(on.text).toContain('Фільтри: мови 1, заборони 2')
    expect(on.buttons.flat().some((b) => b.data === `set:${CHAT}:flt`)).toBe(true)
  })
})

describe('a filter verdict on the "Why?" card', () => {
  const verdict: Verdict = {
    pSpam: 0, action: 'delete', needsVote: false, banDurationSeconds: null,
    decidedBy: 'chat_filter', ruleId: 'filter:script:arabic', signals: [],
    reasonCode: 'filter_script', reasonEvidence: 'سلام دوستان', meta: {}
  }

  it('states the rule, never a spam percentage', () => {
    for (const locale of Object.values(LOCALES)) {
      const text = whyView(locale, verdict)
      expect(text).toContain(locale.reasons['filter_script']!)
      expect(text).not.toMatch(/\d+%/)
    }
  })
})

describe('list editors, warnings, rules', () => {
  const uk = LOCALES['uk']!
  const longWords = Array.from({ length: 25 }, (_, i) => `дужедовгеслово${i}`.repeat(3))

  it('every button of every new screen fits 64 bytes, in every locale', () => {
    for (const locale of Object.values(LOCALES)) {
      const views = [
        filterListPanel(locale, CHAT, 'words', longWords, 2),
        filterListPanel(locale, CHAT, 'domains', ['example.com'], 0),
        warnPanel(locale, CHAT, { limit: 3, action: 'ban' }),
        rulesPanel(locale, CHAT, 'Без спаму', true),
        warnNotice(locale, { chatId: CHAT, userId: 9_999_999_999, userLabel: 'X', count: 1, limit: 3, reason: null })
      ]
      for (const view of views) for (const row of view.buttons) for (const b of row) {
        if (b.data) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })

  it('a remove button names its entry by index and fingerprint', () => {
    const view = filterListPanel(uk, CHAT, 'words', ['казино', 'ставки'], 0)
    const remove = view.buttons.flat().filter((b) => b.data?.includes(':flt_wx:'))
    expect(remove.map((b) => b.data)).toEqual([
      `set:${CHAT}:flt_wx:0.${entryTag('казино')}`,
      `set:${CHAT}:flt_wx:1.${entryTag('ставки')}`
    ])
    expect(entryTag('казино')).not.toBe(entryTag('ставки'))
  })

  it('pages a long list and offers clear only when there is something to clear', () => {
    const page = filterListPanel(uk, CHAT, 'words', longWords, 1)
    expect(page.text).toContain('11.')
    expect(page.text).not.toContain('\n1. ')
    expect(page.buttons.flat().some((b) => b.text === '2/3')).toBe(true)
    const empty = filterListPanel(uk, CHAT, 'words', [], 0)
    expect(empty.buttons.flat().some((b) => b.data?.endsWith(':flt_wc'))).toBe(false)
  })

  it('escapes whatever an admin or a stranger typed', () => {
    expect(filterListPanel(uk, CHAT, 'words', ['<b>x</b>'], 0).text).toContain('&lt;b&gt;')
    expect(rulesPanel(uk, CHAT, '<script>', true).text).toContain('&lt;script&gt;')
    expect(rulesView(uk, 'a < b').text).toContain('a &lt; b')
    expect(warnNotice(uk, { chatId: CHAT, userId: 1, userLabel: 'X', count: 1, limit: 3, reason: '<i>' }).text)
      .toContain('&lt;i&gt;')
  })

  it('rules: write when there are none, edit and delete when there are', () => {
    const none = rulesPanel(uk, CHAT, null, true).buttons.flat().map((b) => b.text)
    expect(none).toContain(uk.rules.writeButton)
    expect(none).not.toContain(uk.rules.deleteButton)
    const some = rulesPanel(uk, CHAT, 'Без спаму', false).buttons.flat().map((b) => b.text)
    expect(some).toEqual(expect.arrayContaining([uk.rules.editButton, uk.rules.deleteButton]))
  })
})
