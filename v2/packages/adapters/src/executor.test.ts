import { describe, expect, it, vi } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { applyVerdict, withFloodWait, type ModerationActions } from './executor.js'

const makeVerdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.9, action: 'delete', needsVote: false, decidedBy: 'llm',
  ruleId: null, signals: [], reasonCode: 'job_scam', reasonEvidence: null, meta: {},
  ...overrides
})

const target = { chatId: -100123, userId: 42, messageId: 7 }
const noGuards = { senderIsAdmin: false, senderIsSelf: false, senderIsTrusted: false }

const makeActions = (): ModerationActions & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    deleteMessage: vi.fn(async () => { calls.push('delete') }),
    mute: vi.fn(async () => { calls.push('mute') }),
    ban: vi.fn(async () => { calls.push('ban') })
  }
}

describe('applyVerdict', () => {
  it('does nothing for none/observe', async () => {
    const actions = makeActions()
    for (const action of ['none', 'observe'] as const) {
      const result = await applyVerdict(makeVerdict({ action }), target, noGuards, actions)
      expect(result.applied).toBe(false)
    }
    expect(actions.calls).toEqual([])
  })

  it('delete removes only the message', async () => {
    const actions = makeActions()
    const result = await applyVerdict(makeVerdict({ action: 'delete' }), target, noGuards, actions)
    expect(result.applied).toBe(true)
    expect(actions.calls).toEqual(['delete'])
  })

  it('mute deletes and mutes', async () => {
    const actions = makeActions()
    await applyVerdict(makeVerdict({ action: 'mute' }), target, noGuards, actions)
    expect(actions.calls).toEqual(['delete', 'mute'])
  })

  it('ban deletes and bans', async () => {
    const actions = makeActions()
    await applyVerdict(makeVerdict({ action: 'ban' }), target, noGuards, actions)
    expect(actions.calls).toEqual(['delete', 'ban'])
  })

  it('captcha restricts temporarily and asks the app to prompt', async () => {
    const actions = makeActions()
    const result = await applyVerdict(makeVerdict({ action: 'captcha' }), target, noGuards, actions)
    expect(actions.calls).toEqual(['mute'])
    expect(result.captchaRequired).toBe(true)
  })

  it.each([
    ['senderIsAdmin'], ['senderIsSelf'], ['senderIsTrusted']
  ])('NEVER acts when %s (safety invariant)', async (guard) => {
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'ban', pSpam: 0.99 }),
      target,
      { ...noGuards, [guard]: true },
      actions
    )
    expect(result.applied).toBe(false)
    expect(result.skippedReason).toBe(guard)
    expect(actions.calls).toEqual([])
  })

  it('continues to mute/ban even when delete fails (already deleted)', async () => {
    const actions = makeActions()
    actions.deleteMessage = vi.fn(async () => { throw new Error('MESSAGE_DELETE_FORBIDDEN') })
    const result = await applyVerdict(makeVerdict({ action: 'ban' }), target, noGuards, actions)
    expect(result.applied).toBe(true)
    expect(actions.calls).toEqual(['ban'])
    expect(result.errors).toHaveLength(1)
  })
})

describe('withFloodWait', () => {
  it('passes through successful calls', async () => {
    expect(await withFloodWait(async () => 5)).toBe(5)
  })

  it('retries once after a short FLOOD_WAIT', async () => {
    let attempts = 0
    const result = await withFloodWait(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('FLOOD_WAIT_1'), { text: 'FLOOD_WAIT_1', seconds: 0 })
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('rethrows long FLOOD_WAITs instead of blocking the queue', async () => {
    await expect(withFloodWait(async () => {
      throw Object.assign(new Error('FLOOD_WAIT_300'), { text: 'FLOOD_WAIT_300', seconds: 300 })
    })).rejects.toThrow('FLOOD_WAIT_300')
  })

  it('rethrows non-flood errors untouched', async () => {
    await expect(withFloodWait(async () => { throw new Error('CHAT_ADMIN_REQUIRED') }))
      .rejects.toThrow('CHAT_ADMIN_REQUIRED')
  })
})
