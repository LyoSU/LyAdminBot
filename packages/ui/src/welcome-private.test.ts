import { describe, it, expect } from 'vitest'
import { LOCALES, welcomeEditor, parseCallback } from './index.js'

const acts = (enable: boolean, priv?: boolean): string[] =>
  welcomeEditor(LOCALES['uk']!, -100123, { enable, textsCount: 1, gifsCount: 0, ...(priv === undefined ? {} : { private: priv }) })
    .buttons.flat().map((b) => parseCallback(b.data ?? '').parts[1] ?? '')

describe('welcome editor: private greeting toggle', () => {
  it('offers the toggle only while greetings are on', () => {
    expect(acts(false)).not.toContain('priv')
    expect(acts(true)).toContain('priv')
  })

  it('labels the current state, defaulting to public for chats set up before it existed', () => {
    const uk = LOCALES['uk']!
    const label = (priv?: boolean): string | undefined =>
      welcomeEditor(uk, -100123, { enable: true, textsCount: 1, gifsCount: 0, ...(priv === undefined ? {} : { private: priv }) })
        .buttons.flat().find((b) => b.data?.endsWith(':priv'))?.text
    expect(label()).toBe(uk.welcome.editor.privateButton(false))
    expect(label(true)).toBe(uk.welcome.editor.privateButton(true))
  })

  it('has the muted-member notice in every locale', () => {
    for (const l of Object.values(LOCALES)) {
      expect(l.mutedYou.text('Chat', '1 h')).toContain('Chat')
      expect(l.mutedYou.button.length).toBeGreaterThan(0)
    }
  })
})
