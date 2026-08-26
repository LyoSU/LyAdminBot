import { describe, expect, it } from 'vitest'
import { accountScreenAllowed, hardVerdictSourceOf } from './account-screen-policy.js'

const chat = (over: Partial<Parameters<typeof accountScreenAllowed>[1]> = {}) => ({
  enabled: true, captchaEnabled: true, externalBanEnabled: true, trustedUserIds: [], ...over
})
const user = (over: Partial<Parameters<typeof accountScreenAllowed>[2]> = {}) => ({
  id: 42, messagesGlobal: 0, ...over
})

/**
 * The asymmetry this function exists to make deliberate.
 *
 * `screenAccount` had two outcomes: a ten-minute gate undone by one tap, and a
 * thirty-day ban. The gate ran five chat-level checks; the ban ran none, because
 * the checks lived inside `gateAccount` and the ban was written inline three
 * lines above the call to it. The milder action was guarded and the severe one
 * was not — visible nowhere, because nothing in the shape of the code said the
 * guards belonged to the function rather than to the decision.
 *
 * Found by an independent review on 2026-08-26. Note what is NOT restored here:
 * trust and standing still do not shield a hard verdict, because `executor.ts`
 * decided that deliberately on 2026-07-30 — one misclick on the override button
 * would otherwise buy permanent immunity in that chat, including against a
 * Telegram scam flag. That asymmetry is a decision; the missing `enabled` check
 * was an accident. The point of one shared function is that the difference is
 * now written down instead of implied by where a line happens to sit.
 */
describe('accountScreenAllowed', () => {
  it('lets an ordinary screen through', () => {
    expect(accountScreenAllowed('gate', chat(), user())).toBe('allow')
    expect(accountScreenAllowed('ban', chat(), user())).toBe('allow')
  })

  /**
   * The fix. A chat that turned the pipeline off did not ask to be policed at
   * all — and until now `/report` could still ban somebody there for 30 days.
   */
  it('REGRESSION: a chat with anti-spam off gets neither action', () => {
    expect(accountScreenAllowed('ban', chat({ enabled: false }), user())).toBe('antispam_off')
    expect(accountScreenAllowed('gate', chat({ enabled: false }), user())).toBe('antispam_off')
  })

  /**
   * `externalBanEnabled` is the chat saying it does not honour lols/CAS. A ban
   * that rests only on those lists is that chat's setting being overruled by a
   * report from one of its members.
   */
  it('REGRESSION: a chat that declines the ban lists is not banned from them', () => {
    expect(accountScreenAllowed('ban', chat({ externalBanEnabled: false }), user(), 'third_party'))
      .toBe('external_ban_off')
    // Telegram's own scam flag is not a third party, and that setting says
    // nothing about it.
    expect(accountScreenAllowed('ban', chat({ externalBanEnabled: false }), user(), 'platform'))
      .toBe('allow')
  })

  it('gates only where a captcha is wanted; a ban is not a captcha', () => {
    expect(accountScreenAllowed('gate', chat({ captchaEnabled: false }), user())).toBe('captcha_off')
    expect(accountScreenAllowed('ban', chat({ captchaEnabled: false }), user())).toBe('allow')
  })

  it('spares a trusted member the gate, and does not shield them from a hard verdict', () => {
    expect(accountScreenAllowed('gate', chat({ trustedUserIds: [42] }), user())).toBe('trusted')
    expect(accountScreenAllowed('ban', chat({ trustedUserIds: [42] }), user())).toBe('allow')
  })

  it('spares an established member the gate, on the same terms', () => {
    expect(accountScreenAllowed('gate', chat(), user({ messagesGlobal: 5000 }))).toBe('established')
    expect(accountScreenAllowed('ban', chat(), user({ messagesGlobal: 5000 }))).toBe('allow')
  })

  /** The master switch outranks everything, so its answer is the one reported. */
  it('names the master switch first when several would refuse', () => {
    expect(accountScreenAllowed('gate', chat({ enabled: false, captchaEnabled: false }), user()))
      .toBe('antispam_off')
  })
})

describe('hardVerdictSourceOf', () => {
  const sig = (...names: string[]) => names.map((name) => ({ name }))

  it('names the external lists when the listing is the whole case', () => {
    expect(hardVerdictSourceOf(sig('external_ban', 'new_globally'))).toBe('third_party')
  })

  /**
   * A chat that declined lols/CAS said nothing about Telegram's own flag, so an
   * account carrying both is not something that setting may wave through.
   */
  it('prefers the platform when both are present', () => {
    expect(hardVerdictSourceOf(sig('external_ban', 'scam_flag'))).toBe('platform')
  })

  it('falls back to our own reading of the account', () => {
    expect(hardVerdictSourceOf(sig('unofficial_client_risk'))).toBe('integrity')
    expect(hardVerdictSourceOf([])).toBe('integrity')
  })
})
