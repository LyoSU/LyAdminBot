import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, FILTERABLE_SCRIPTS, LOCK_KINDS, type ChatFilters, type Verdict } from '@lyadmin/core'
import { filtersPanel, filterScriptsPanel, filterLocksPanel, settingsPanel, whyView, LOCALES } from './views.js'

/** The longest chat id Telegram issues, so every button is measured at its worst. */
const CHAT = -1009999999999

const everything: ChatFilters = {
  scripts: [...FILTERABLE_SCRIPTS], locks: [...LOCK_KINDS], nameScripts: true,
  action: 'ban', newcomersOnly: true
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
