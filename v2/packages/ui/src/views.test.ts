import { describe, expect, it } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { callbackData, captchaPrompt, compactNotification, parseCallback, resolveLocale, settingsDeepLink, settingsPanel, whyView, LOCALES } from './views.js'
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

describe('locales', () => {
  it('uk and en cover the same reason codes (no missing translations)', () => {
    expect(Object.keys(LOCALES['uk']!.reasons).sort()).toEqual(Object.keys(LOCALES['en']!.reasons).sort())
  })

  it('language names contain no flag emoji', () => {
    for (const locale of Object.values(LOCALES)) {
      expect(locale.languageName).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u)
    }
  })

  it('resolveLocale falls back to en and supports uk', () => {
    expect(resolveLocale('uk').languageName).toBe('Українська')
    expect(resolveLocale('de').languageName).toBe('English')
    expect(resolveLocale(null).languageName).toBe('English')
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
