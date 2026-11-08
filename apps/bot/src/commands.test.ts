import { describe, it, expect } from 'vitest'
import { LOCALES } from '@lyadmin/ui'
import { SCOPES, buildCommands } from './commands.js'
import { EPHEMERAL_COMMANDS } from './ephemeral-commands.js'

const locale = LOCALES['en']!

const menu = (scope: string): { command: string; ephemeral: boolean }[] => {
  const entry = SCOPES.find((s) => s.scope._ === scope)!
  return buildCommands(locale, entry.keys, entry.group)
    .map((c) => ({ command: c.command, ephemeral: c.ephemeral === true }))
}

describe('command menu', () => {
  it('flags only lookups as ephemeral, and only in group scopes', () => {
    for (const { scope, keys, group } of SCOPES) {
      for (const c of buildCommands(locale, keys, group)) {
        if (c.ephemeral) {
          expect(group, `${scope._}: /${c.command}`).toBe(true)
          expect(EPHEMERAL_COMMANDS.has(c.command)).toBe(true)
        }
      }
    }
  })

  it('never hides an act that changes the chat', () => {
    // Moderation is seen to happen; /report is public by decision.
    for (const { keys, group } of SCOPES) {
      for (const c of buildCommands(locale, keys, group)) {
        if (['report', 'banan', 'kick', 'del', 'untrust'].includes(c.command)) {
          expect(c.ephemeral, `/${c.command}`).not.toBe(true)
        }
      }
    }
  })

  it('gives an admin the help they lose to the narrower scope', () => {
    // Telegram serves the admins' list INSTEAD of the members' one.
    expect(menu('botCommandScopeChatAdmins').map((c) => c.command)).toContain('help')
  })

  it('keeps the members menu short and led by /report', () => {
    expect(menu('botCommandScopeChats')).toEqual([
      { command: 'report', ephemeral: false },
      { command: 'mystats', ephemeral: true },
      { command: 'stats', ephemeral: true },
      { command: 'help', ephemeral: true }
    ])
  })

  it('has a description for every listed command in every shipped locale', () => {
    for (const l of Object.values(LOCALES)) {
      for (const { keys, group } of SCOPES) {
        for (const c of buildCommands(l, keys, group)) expect(c.description.length).toBeGreaterThan(0)
      }
    }
  })
})
