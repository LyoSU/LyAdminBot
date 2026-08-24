import { describe, expect, it } from 'vitest'
import type { Signal } from './types.js'
import { applyDeterministicRules } from './rules.js'
import type { SignalName } from './signals/registry.js'

const s = (...names: SignalName[]): Signal[] => names.map((name) => ({ name }))
/** Trust signals: the catalogue knows they exonerate, so nothing is tagged here. */
const t = (...names: SignalName[]): Signal[] => names.map((name) => ({ name }))

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

  it('unofficial-client newcomer is deterministic spam (heaviest weight gets a rule)', () => {
    const verdict = applyDeterministicRules(s('unofficial_client_risk', 'new_globally'))
    expect(verdict?.kind).toBe('spam')
    expect(verdict?.ruleId).toBe('unofficial_client_new')
    expect(verdict?.pSpam).toBeGreaterThanOrEqual(0.95)
  })

  it('unofficial-client risk on an established account falls through to scoring', () => {
    expect(
      applyDeterministicRules([...s('unofficial_client_risk'), ...t('established_user')])
    ).toBeNull()
  })

  it('edit injecting promo from a non-established user is deterministic spam', () => {
    const verdict = applyDeterministicRules(s('edit_injected_invisibles', 'edited_message'))
    expect(verdict?.ruleId).toBe('edit_injected_invisibles')
  })

  it('edit injection from established user falls through (admins fix their links)', () => {
    expect(
      applyDeterministicRules([...s('edit_injected_invisibles'), ...t('established_user')])
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

describe('nsfw_promo_profile — the profile as the advert', () => {
  const lowInfo = { lowInformation: true }

  it('fires on explicit media plus somewhere the profile points, for a newcomer', () => {
    const v = applyDeterministicRules(s('nsfw_avatar', 'personal_channel', 'new_globally'), lowInfo)
    expect(v?.ruleId).toBe('nsfw_promo_profile')
    expect(v?.aboutAccount).toBe(true)
  })

  /**
   * The conjunction has to be TWO facts. `nsfw_linked_channel` satisfied both
   * halves in the first draft, so one observation corroborated itself and the
   * rule claimed the weight of two — the same defect `priorMatch` exists to
   * stop on the learning side.
   */
  it('does not fire on an explicit linked channel alone', () => {
    expect(applyDeterministicRules(s('nsfw_linked_channel', 'new_globally'), lowInfo)).toBeNull()
  })

  it('does not fire when the message had something to say', () => {
    // The pipeline's standing position: a promotional profile is a reason to
    // READ the message. This rule only speaks where there is nothing to read.
    expect(applyDeterministicRules(s('nsfw_avatar', 'personal_channel', 'new_globally'))).toBeNull()
  })

  it('does not fire on a profile that advertises nothing', () => {
    expect(applyDeterministicRules(s('nsfw_avatar', 'new_globally'), lowInfo)).toBeNull()
  })

  it('spares a member with standing', () => {
    expect(applyDeterministicRules(
      [...s('nsfw_avatar', 'personal_channel', 'new_globally'), ...t('established_user')], lowInfo
    )).toBeNull()
  })
})

describe('edit-to-inject — two facts, not one', () => {
  /**
   * Adding a link by editing is something members do constantly, and the
   * catalogue reserves "this alone costs you the chat" for evasion with no
   * innocent reading. Invisible characters are that; a link is not.
   */
  it('a link added by an edit reaches no deterministic verdict', () => {
    expect(applyDeterministicRules(s('edit_injected_link', 'edited_message', 'new_globally'))).toBeNull()
  })

  it('invisible characters added by an edit still decide', () => {
    expect(applyDeterministicRules(s('edit_injected_invisibles'))?.ruleId)
      .toBe('edit_injected_invisibles')
  })
})
