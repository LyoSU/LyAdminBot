import { describe, expect, it } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { callbackData, captchaPrompt, compactNotification, parseCallback, resolveLocale, settingsDeepLink, settingsPanel, topList, votePrompt, whyCard, whyDeepLink, whyView, LOCALES } from './views.js'
import { uk } from './locales/uk.js'

const makeVerdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.93, action: 'mute', needsVote: false, decidedBy: 'llm',
  ruleId: null, signals: [{ name: 'external_url' }, { name: 'is_reply', negative: true }],
  reasonCode: 'job_scam', reasonEvidence: 'оплата щодня', meta: {},
  ...overrides
})

const target = { chatId: -100123, messageId: 7, userId: 42, userLabel: 'Іван' }

describe('compactNotification', () => {
  it('is exactly one line with two buttons', () => {
    const view = compactNotification(uk, makeVerdict(), target)
    expect(view.text).toBe('🔇 мут · Іван')
    expect(view.text).not.toContain('\n')
    expect(view.buttons[0]).toHaveLength(2)
  })

  it('never contains em-dash or « » (AI-slop markers)', () => {
    for (const action of ['delete', 'mute', 'ban'] as const) {
      const view = compactNotification(uk, makeVerdict({ action }), target)
      expect(view.text).not.toMatch(/—|«|»/)
    }
  })

  it('callback payloads stay within the 64-byte Telegram limit', () => {
    const view = compactNotification(uk, makeVerdict(), {
      chatId: -1001234567890123, messageId: 999999999, userId: 9876543210, userLabel: 'X'
    })
    for (const button of view.buttons.flat()) {
      expect(Buffer.byteLength(button.data ?? '')).toBeLessThanOrEqual(64)
    }
  })

  it('refuses to render non-enforcement verdicts', () => {
    expect(() => compactNotification(uk, makeVerdict({ action: 'observe' }), target)).toThrow()
  })

  it('escapes HTML in the user label (display names are attacker-controlled)', () => {
    const view = compactNotification(uk, makeVerdict(), {
      ...target, userLabel: '<a href="https://evil.example">Іван</a>'
    })
    expect(view.text).not.toContain('<a')
    expect(view.text).toContain('&lt;a href="https://evil.example"&gt;Іван&lt;/a&gt;')
  })

  it('without botUsername the why button stays a callback', () => {
    const view = compactNotification(uk, makeVerdict(), target)
    const why = view.buttons[0]![0]!
    expect(why.data).toBe('why:-100123:7')
    expect(why.url).toBeUndefined()
  })

  it('with botUsername the why button becomes a PM deep link, override stays callback', () => {
    const view = compactNotification(uk, makeVerdict(), target, { botUsername: 'LyAdminBot' })
    const [why, override] = view.buttons[0]!
    expect(why!.url).toBe('https://t.me/LyAdminBot?start=why_-100123_7_42')
    expect(why!.data).toBeUndefined()
    expect(override!.data).toBe('ovr:-100123:7:42')
  })
})

describe('whyDeepLink', () => {
  it('encodes chat/message/user into a start payload', () => {
    expect(whyDeepLink('LyAdminBot', -1001234567890, 555, 42))
      .toBe('https://t.me/LyAdminBot?start=why_-1001234567890_555_42')
  })
})

describe('whyCard', () => {
  it('renders the why text and offers override for admins', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: true })
    expect(view.text).toContain('93%')
    expect(view.buttons[0]![0]!.data).toBe('ovr:-100123:7:42')
  })

  it('omits the override button for non-admins', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: false })
    expect(view.buttons).toHaveLength(0)
  })
})

describe('whyView', () => {
  it('localizes the reason code and never shows raw LLM text fields', () => {
    const text = whyView(uk, makeVerdict())
    expect(text).toContain('шахрайську "вакансію"')
    expect(text).toContain('93%')
    expect(text).toContain('ШІ-аналіз')
    expect(text).toContain('оплата щодня') // evidence quote is allowed
  })

  it('falls back gracefully for unknown reason codes', () => {
    const text = whyView(uk, makeVerdict({ reasonCode: 'mystery_reason_42' }))
    expect(text).toContain(uk.reasonFallback)
  })

  it('lists only suspicious signals, not trust signals', () => {
    const text = whyView(uk, makeVerdict())
    expect(text).toContain('external_url')
    expect(text).not.toContain('is_reply')
  })
})

describe('topList', () => {
  const entries = [
    { name: 'Аня', value: 120 },
    { name: 'Богдан', value: 90 },
    { name: 'Влад', value: 30 },
    { name: 'Гліб', value: 5 }
  ]

  it('medals the top three and numbers the rest', () => {
    const view = topList(uk, 'messages', entries)
    expect(view.text).toContain('🥇')
    expect(view.text).toContain('🥈')
    expect(view.text).toContain('🥉')
    expect(view.text).toContain('4.')
    expect(view.text).toContain('Аня')
    expect(view.text).toContain('120')
  })

  it('shows an empty-state line when there is no data', () => {
    const view = topList(uk, 'messages', [])
    expect(view.text).toBe(uk.top.empty)
    expect(view.buttons).toHaveLength(0)
  })

  it('escapes attacker-controlled names', () => {
    const view = topList(uk, 'banan', [{ name: '<b>x</b>', value: 3 }])
    expect(view.text).not.toContain('<b>')
    expect(view.text).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('uses the banan title and unit for the banan board', () => {
    const view = topList(uk, 'banan', entries)
    expect(view.text).toContain(uk.top.titleBanan)
  })
})

describe('locales', () => {
  it('uk and en cover the same reason codes (no missing translations)', () => {
    expect(Object.keys(LOCALES['uk']!.reasons).sort()).toEqual(Object.keys(LOCALES['en']!.reasons).sort())
  })

  it('language names contain no flag emoji', () => {
    for (const locale of Object.values(LOCALES)) {
      expect(locale.languageName).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u)
    }
  })

  it('resolveLocale falls back to en and supports uk/ru/be', () => {
    expect(resolveLocale('uk').languageName).toBe('Українська')
    expect(resolveLocale('ru').languageName).toBe('Русский')
    expect(resolveLocale('be').languageName).toBe('Русский')
    expect(resolveLocale('de').languageName).toBe('English')
    expect(resolveLocale(null).languageName).toBe('English')
  })

  it('all locales expose the same reason codes', () => {
    const reference = Object.keys(LOCALES['en']!.reasons).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(Object.keys(locale.reasons).sort(), `locale ${code}`).toEqual(reference)
    }
  })
})

describe('settings', () => {
  it('group settings view is a PM deep link, never a panel', () => {
    const view = settingsDeepLink(uk, 'LyAdminBot', -100123)
    expect(view.buttons[0]?.[0]?.url).toContain('t.me/LyAdminBot?start=settings_-100123')
    expect(view.text).toBe(uk.settings.openInPm)
  })

  it('every panel button carries the target chatId (the panel lives in PM)', () => {
    const view = settingsPanel(uk, -1001234567890, {
      enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true
    })
    const datas = view.buttons.flat().map((b) => b.data ?? '')
    expect(datas.length).toBeGreaterThan(0)
    for (const data of datas) {
      expect(data).toMatch(/^set:-1001234567890:/)
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    }
  })
})

describe('votePrompt', () => {
  it('quotes the text safely, shows live counts, buttons carry vote ids', () => {
    const view = votePrompt(uk, {
      chatId: -100123, messageId: 7, userLabel: '<i>Іра</i>', textPreview: '<b>купи</b> крипту'
    }, { spam: 2, ham: 1, outcome: 'pending' })
    expect(view.text).toContain('&lt;b&gt;купи&lt;/b&gt; крипту')
    expect(view.text).toContain('&lt;i&gt;Іра&lt;/i&gt;')
    expect(view.text).not.toMatch(/—|«|»/)
    const [spamBtn, hamBtn] = view.buttons[0] ?? []
    expect(spamBtn?.data).toBe('vt:-100123:7:s')
    expect(hamBtn?.data).toBe('vt:-100123:7:h')
    expect(spamBtn?.text).toContain('2')
    expect(hamBtn?.text).toContain('1')
    for (const btn of view.buttons.flat()) {
      expect(Buffer.byteLength(btn.data ?? '')).toBeLessThanOrEqual(64)
    }
  })
})

describe('captchaPrompt', () => {
  it('addresses the user, escapes the name, and carries chatId+userId in the button', () => {
    const view = captchaPrompt(uk, {
      chatId: -100123, userId: 42, userLabel: '<b>Іван</b>'
    })
    expect(view.text).not.toContain('<b>Іван')
    expect(view.text).toContain('&lt;b&gt;Іван&lt;/b&gt;')
    expect(view.buttons[0]?.[0]?.data).toBe(callbackData.captcha(-100123, 42))
    expect(parseCallback(callbackData.captcha(-100123, 42))).toEqual({ kind: 'cap', parts: ['-100123', '42'] })
  })
})

describe('parseCallback', () => {
  it('round-trips callback data', () => {
    expect(parseCallback('ovr:-100:7:42')).toEqual({ kind: 'ovr', parts: ['-100', '7', '42'] })
    expect(parseCallback('')).toEqual({ kind: '', parts: [] })
  })
})
