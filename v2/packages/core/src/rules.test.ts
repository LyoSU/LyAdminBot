import { describe, expect, it } from 'vitest'
import type { Signal } from './types.js'
import { applyDeterministicRules } from './rules.js'

const s = (...names: string[]): Signal[] => names.map((name) => ({ name }))
const t = (...names: string[]): Signal[] => names.map((name) => ({ name, negative: true }))

describe('applyDeterministicRules — spam rules', () => {
  it('scam-flagged newcomer is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('scam_flag', 'new_globally'))
    expect(verdict?.kind).toBe('spam')
    expect(verdict?.ruleId).toBe('scam_flag_new')
    expect(verdict?.pSpam).toBeGreaterThanOrEqual(0.95)
  })

  it('scam flag on an established account is NOT deterministic (could be appeal-pending)', () => {
    expect(applyDeterministicRules([...s('scam_flag'), ...t('established_user')])).toBeNull()
  })

  it('externally banned newcomer is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('external_ban', 'new_globally'))
    expect(verdict?.kind).toBe('spam')
    expect(verdict?.ruleId).toBe('external_ban_new')
  })

  it('external ban alone (established locally) falls through to scoring', () => {
    expect(applyDeterministicRules(s('external_ban'))).toBeNull()
  })

  it('edit injecting promo from a non-established user is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('edit_injected_promo', 'edited_message'))
    expect(verdict?.ruleId).toBe('edit_injected_promo')
  })

  it('edit injection from established user falls through (admins fix their links)', () => {
    expect(
      applyDeterministicRules([...s('edit_injected_promo'), ...t('established_user')])
    ).toBeNull()
  })

  it('private invite from a brand-new account is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('private_invite_link', 'new_globally'))
    expect(verdict?.ruleId).toBe('private_invite_new')
  })

  it('identity churn + fresh account + promo is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('identity_churn_24h', 'fresh_account', 'url_shortener'))
    expect(verdict?.ruleId).toBe('identity_churn_promo')
  })

  it('identity churn WITHOUT promo content falls through (prod FP: innocent question)', () => {
    expect(applyDeterministicRules(s('identity_churn_24h', 'fresh_account'))).toBeNull()
  })

  it('sleeper_awakened is NEVER deterministic (prod FP: lost-pet posts)', () => {
    expect(
      applyDeterministicRules(s('sleeper_awakened', 'external_url', 'new_in_chat', 'phone_number'))
    ).toBeNull()
  })
})

describe('applyDeterministicRules — clean rules', () => {
  it('trusted user with no suspicious signals is deterministic clean', () => {
    const verdict = applyDeterministicRules(t('trusted_reputation', 'is_reply'))
    expect(verdict?.kind).toBe('clean')
    expect(verdict?.ruleId).toBe('trusted_clean')
  })

  it('trusted user WITH promo signals falls through (compromised-account guard)', () => {
    expect(
      applyDeterministicRules([...t('trusted_reputation'), ...s('url_shortener')])
    ).toBeNull()
  })

  it('established user replying with no suspicious signals is deterministic clean', () => {
    const verdict = applyDeterministicRules(t('established_user', 'is_reply', 'recent_reply'))
    expect(verdict?.kind).toBe('clean')
    expect(verdict?.ruleId).toBe('established_reply_clean')
  })

  it('empty signal list falls through', () => {
    expect(applyDeterministicRules([])).toBeNull()
  })
})
