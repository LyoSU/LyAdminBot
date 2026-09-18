import { describe, it, expect } from 'vitest'
import { parseCommand } from './command.js'

describe('parseCommand', () => {
  it('reads a bare command and one addressed to us, in any case', () => {
    expect(parseCommand('/mystats', 'LyAdminBot')).toEqual({ name: 'mystats', args: '' })
    expect(parseCommand('/mystats@lyadminbot', 'LyAdminBot')).toEqual({ name: 'mystats', args: '' })
    expect(parseCommand('/MyStats@LyAdminBot', 'LyAdminBot')).toEqual({ name: 'mystats', args: '' })
  })

  it('ignores a command addressed to another bot', () => {
    expect(parseCommand('/mystats@OtherBot', 'LyAdminBot')).toBeNull()
    expect(parseCommand('/banan@OtherBot 1h', 'LyAdminBot')).toBeNull()
  })

  it('ignores an addressed command until it knows its own name', () => {
    expect(parseCommand('/mystats@LyAdminBot', null)).toBeNull()
    expect(parseCommand('/mystats', null)).toEqual({ name: 'mystats', args: '' })
  })

  it('does not read a longer word as a shorter command', () => {
    expect(parseCommand('/helpme', 'LyAdminBot')?.name).toBe('helpme')
    expect(parseCommand('/stats!', 'LyAdminBot')).toBeNull()
  })

  it('splits arguments and keeps the dash in /top-banan', () => {
    expect(parseCommand('/banan  2h ', 'LyAdminBot')).toEqual({ name: 'banan', args: '2h' })
    expect(parseCommand('/welcome@LyAdminBot hi\nthere', 'LyAdminBot')).toEqual({ name: 'welcome', args: 'hi\nthere' })
    expect(parseCommand('/top-banan', 'LyAdminBot')).toEqual({ name: 'top-banan', args: '' })
  })

  it('is not a command unless it starts with one', () => {
    expect(parseCommand('hello /mystats', 'LyAdminBot')).toBeNull()
    expect(parseCommand('/', 'LyAdminBot')).toBeNull()
    expect(parseCommand('', 'LyAdminBot')).toBeNull()
  })
})
