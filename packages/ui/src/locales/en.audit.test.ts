import { describe, expect, it } from 'vitest'
import { en } from './en.js'

/** Every plain string leaf of the locale, with its key path. */
const leaves = (node: unknown, path = ''): [string, string][] => {
  if (typeof node === 'string') return [[path, node]]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
  }
  return []
}

/**
 * English copy audit (2026-10-15): one spelling per term, no internal jargon in
 * the decision card, counts that agree and read with thousands separators.
 */
describe('en copy audit', () => {
  it('spells GIF in capitals everywhere', () => {
    const texts = [
      ...leaves(en).map(([, v]) => v),
      en.welcome.editor.title('on', 2, 3),
      en.extra.editor.promptContent('rules')
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/\bgifs?\b/)
      expect(text).not.toMatch(/\bGifs\b/)
    }
  })

  it('names the missing right by the action it blocks and agrees the count', () => {
    const banBlocked = (accounts: number): string =>
      en.notification.missingRights({ deleteBlocked: false, senderBlocked: true, accounts })
    expect(banBlocked(0)).toContain('cannot ban the spammers')
    expect(banBlocked(0)).not.toContain('could not remove')
    expect(banBlocked(1)).toContain(' could not remove 1 account.')
    expect(banBlocked(21)).toContain(' could not remove 21 accounts.')
    const both = en.notification.missingRights({ deleteBlocked: true, senderBlocked: true, accounts: 5 })
    expect(both).toContain('I found spam')
    expect(both).toContain('could not remove 5 accounts')
  })

  it('groups thousands in the personal stats', () => {
    expect(en.stats.global(1287)).toBe('Messages everywhere: 1,287')
    expect(en.stats.inChat(1284, null)).toBe('Messages in this chat: 1,284')
    expect(en.stats.inChat(1284, 'Chat')).toBe('Messages in Chat: 1,284')
    expect(en.stats.bananCaught(1000)).toContain('1,000')
  })

  it('keeps internal jargon out of the decision card', () => {
    const card = [...leaves(en.why.decidedBy), ...leaves(en.why.signalLabels), ...leaves(en.reasons)]
      .map(([, v]) => v).join('\n')
    for (const jargon of ['deterministic', 'velocity', 'a run of', 'looks like it', 'standing in for']) {
      expect(card).not.toContain(jargon)
    }
  })

  it('tells the kick apart from the delete and says vote, not ballot', () => {
    expect(en.actions.kick).toContain('kicked from the chat')
    expect(en.actions.kick).not.toContain('removed')
    expect(en.vote.voters.span('4m')).toBe('⏱ first to last vote: 4m')
    expect(en.trust.grantedBy('Admin', '2d', 'vote')).not.toContain('ballot')
  })
})
