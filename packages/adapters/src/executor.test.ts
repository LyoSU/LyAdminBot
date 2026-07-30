import { describe, expect, it, vi } from 'vitest'
import type { Verdict } from '@lyadmin/core'
import { applyVerdict, withFloodWait, type ModerationActions } from './executor.js'

const makeVerdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.9, action: 'delete', needsVote: false, banDurationSeconds: null, decidedBy: 'llm',
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
    kick: vi.fn(async () => { calls.push('kick') }),
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

  it('kick deletes and removes, leaving the door open', async () => {
    const actions = makeActions()
    const result = await applyVerdict(makeVerdict({ action: 'kick' }), target, noGuards, actions)
    expect(result.applied).toBe(true)
    expect(actions.calls).toEqual(['delete', 'kick'])
    // A kick must never restrict: it removes, it does not silence.
    expect(actions.mute).not.toHaveBeenCalled()
    expect(actions.ban).not.toHaveBeenCalled()
  })

  it('ban deletes and bans', async () => {
    const actions = makeActions()
    await applyVerdict(makeVerdict({ action: 'ban' }), target, noGuards, actions)
    expect(actions.calls).toEqual(['delete', 'ban'])
  })

  it('passes the ban duration straight through to the API call', async () => {
    const actions = makeActions()
    await applyVerdict(
      makeVerdict({ action: 'ban', banDurationSeconds: 2_592_000 }), target, noGuards, actions)
    expect(actions.ban).toHaveBeenCalledWith(target.chatId, target.userId, 2_592_000)
  })

  it('a null duration means a permanent ban, not a zero-length one', async () => {
    const actions = makeActions()
    await applyVerdict(
      makeVerdict({ action: 'ban', banDurationSeconds: null }), target, noGuards, actions)
    expect(actions.ban).toHaveBeenCalledWith(target.chatId, target.userId, null)
  })

  it('continues to kick even when the message is already gone', async () => {
    const actions = makeActions()
    actions.deleteMessage = vi.fn(async () => { throw new Error('MESSAGE_DELETE_FORBIDDEN') })
    const result = await applyVerdict(makeVerdict({ action: 'kick' }), target, noGuards, actions)
    expect(result.applied).toBe(true)
    expect(actions.calls).toEqual(['kick'])
  })

  it('captcha restricts temporarily and asks the app to prompt', async () => {
    const actions = makeActions()
    const result = await applyVerdict(makeVerdict({ action: 'captcha' }), target, noGuards, actions)
    expect(actions.calls).toEqual(['mute'])
    expect(result.captchaRequired).toBe(true)
  })

  it('a captcha whose restriction failed is not announced', async () => {
    // Prompting here would ask the user to unlock a door that never closed.
    const actions = makeActions()
    actions.mute = vi.fn(async () => { throw new Error('CHAT_ADMIN_REQUIRED') })
    const result = await applyVerdict(makeVerdict({ action: 'captcha' }), target, noGuards, actions)
    expect(result.captchaRequired).toBe(false)
    expect(result.applied).toBe(false)
  })

  it('delete + requireCaptcha removes the message and gates the sender', async () => {
    // The uncertain-verdict shape: we act on the message, not on the person.
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'delete', requireCaptcha: true }), target, noGuards, actions)
    expect(actions.calls).toEqual(['delete', 'mute'])
    expect(result.applied).toBe(true)
    expect(result.captchaRequired).toBe(true)
    expect(actions.kick).not.toHaveBeenCalled()
    expect(actions.ban).not.toHaveBeenCalled()
  })

  it('a plain delete never restricts anybody', async () => {
    const actions = makeActions()
    const result = await applyVerdict(makeVerdict({ action: 'delete' }), target, noGuards, actions)
    expect(result.captchaRequired).toBe(false)
    expect(actions.mute).not.toHaveBeenCalled()
  })

  it('trust does not shield an account Telegram itself flagged (2026-07-30)', async () => {
    // Trust is granted by one tap and never expires, so treating it as absolute
    // meant a misclick bought permanent immunity — including for the
    // sold/compromised long-time account in the threat model.
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'ban', signals: [{ name: 'scam_flag' }] }),
      target, { ...noGuards, senderIsTrusted: true }, actions)
    expect(result.applied).toBe(true)
    expect(actions.calls).toEqual(['delete', 'ban'])
  })

  it.each(['external_ban', 'fake_flag', 'restricted_for_spam'])(
    'trust yields to %s as well', async (name) => {
      const actions = makeActions()
      const result = await applyVerdict(
        makeVerdict({ action: 'mute', signals: [{ name }] }),
        target, { ...noGuards, senderIsTrusted: true }, actions)
      expect(result.applied).toBe(true)
    })

  it('trust still shields against our OWN judgement', async () => {
    // The whole point of the trusted list: a pipeline mistake on a regular.
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'delete', pSpam: 0.99, signals: [{ name: 'external_url' }, { name: 'sleeper_awakened' }] }),
      target, { ...noGuards, senderIsTrusted: true }, actions)
    expect(result.skippedReason).toBe('senderIsTrusted')
    expect(actions.calls).toEqual([])
  })

  it('an admin is never actioned, hard verdict or not', async () => {
    // Admins outrank every signal: acting on them is how a bot loses its rights.
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'ban', signals: [{ name: 'scam_flag' }] }),
      target, { ...noGuards, senderIsAdmin: true }, actions)
    expect(result.skippedReason).toBe('senderIsAdmin')
    expect(actions.calls).toEqual([])
  })

  it('requireCaptcha on a guarded sender still restricts nobody', async () => {
    const actions = makeActions()
    const result = await applyVerdict(
      makeVerdict({ action: 'delete', requireCaptcha: true }), target,
      { ...noGuards, senderIsAdmin: true }, actions)
    expect(result.captchaRequired).toBe(false)
    expect(actions.calls).toEqual([])
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

  // The guards used to be discovered by iterating Object.entries(guards), so
  // this asserts every enforcing action is covered by every guard rather than
  // just the one combination the original test happened to pick.
  it.each(['captcha', 'delete', 'kick', 'mute', 'ban'] as const)(
    'no guarded sender is ever %sed', async (action) => {
      for (const guard of ['senderIsAdmin', 'senderIsSelf', 'senderIsTrusted']) {
        const actions = makeActions()
        const result = await applyVerdict(
          makeVerdict({ action, pSpam: 0.99 }), target, { ...noGuards, [guard]: true }, actions)
        expect(result.applied, `${action} / ${guard}`).toBe(false)
        expect(result.captchaRequired).toBe(false)
        expect(actions.calls, `${action} / ${guard}`).toEqual([])
      }
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
