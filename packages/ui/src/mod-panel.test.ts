import { describe, it, expect } from 'vitest'
import { LOCALES, MOD_DONE, modPanel, parseCallback, type ModPanelInput } from './index.js'

const base: ModPanelInput = {
  chatId: -1001234567890,
  messageId: 98765432,
  author: { id: 8123456789, label: 'Spam <b>Bot</b>' },
  senderTitle: '',
  text: 'buy now https://example.com/x',
  canPunish: true,
  muteLabels: ['10m', '1d'],
  done: 0
}

const datas = (p: ModPanelInput): string[] =>
  modPanel(LOCALES['uk']!, p).buttons.flat().map((b) => b.data ?? '')

describe('modPanel', () => {
  it('leads with delete, then the punishments, then profile and close', () => {
    const rows = modPanel(LOCALES['en']!, base).buttons.map((r) => r.map((b) => parseCallback(b.data!).parts[3]))
    expect(rows).toEqual([['d'], ['m', 'M', 'k'], ['p', 'x']])
  })

  it('drops a done act and keeps the rest of the sequence on the same panel', () => {
    const afterDelete = modPanel(LOCALES['en']!, { ...base, done: MOD_DONE.deleted })
    expect(afterDelete.buttons.flat().map((b) => parseCallback(b.data!).parts[3])).toEqual(['m', 'M', 'k', 'p', 'x'])
    expect(afterDelete.text).toContain(LOCALES['en']!.mod.deleted)
    // Every button carries the new state forward.
    for (const b of afterDelete.buttons.flat()) expect(parseCallback(b.data!).parts[4]).toBe(String(MOD_DONE.deleted))
  })

  it('offers to lift a mute instead of stacking another, and nothing after a kick', () => {
    const muted = modPanel(LOCALES['en']!, { ...base, done: MOD_DONE.muted })
    expect(muted.buttons[1]!.map((b) => parseCallback(b.data!).parts[3])).toEqual(['u', 'k'])
    const kicked = modPanel(LOCALES['en']!, { ...base, done: MOD_DONE.kicked | MOD_DONE.deleted })
    expect(kicked.buttons.flat().map((b) => parseCallback(b.data!).parts[3])).toEqual(['p', 'x'])
  })

  it('says why mute and kick are missing for an admin or a channel', () => {
    const admin = modPanel(LOCALES['en']!, { ...base, canPunish: false })
    expect(admin.text).toContain(LOCALES['en']!.mod.limited)
    expect(admin.buttons.flat().some((b) => ['m', 'M', 'k'].includes(parseCallback(b.data!).parts[3]!))).toBe(false)
    const channel = modPanel(LOCALES['en']!, { ...base, author: null, senderTitle: 'News & <Co>', canPunish: false })
    expect(channel.text).toContain('News &amp; &lt;Co&gt;')
    expect(channel.buttons.flat().some((b) => parseCallback(b.data!).parts[3] === 'p')).toBe(false)
  })

  it('escapes the author and defuses links in the quote', () => {
    const view = modPanel(LOCALES['en']!, base)
    expect(view.text).not.toContain('<b>Bot</b>')
    expect(view.text).not.toContain('https://example.com')
  })

  it('keeps every payload within Telegram\'s 64 bytes at the widest ids', () => {
    const widest = { ...base, chatId: -1009999999999, messageId: 2147483647, author: { id: 9999999999, label: 'x' }, done: 7 }
    for (const d of datas(widest)) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64)
  })

  it('renders in every shipped locale', () => {
    for (const locale of Object.values(LOCALES)) {
      const view = modPanel(locale, base)
      expect(view.text.length).toBeGreaterThan(0)
      for (const b of view.buttons.flat()) expect(b.text.length).toBeGreaterThan(0)
    }
  })
})
