import { describe, expect, it } from 'vitest'
import {
  accountScreenAllowed, accountScreenRemoves, accountScreenUnasked, hardVerdictSourceOf
} from './account-screen-policy.js'

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

/**
 * The half of an account-screen ban that did not exist until 2026-08-27.
 *
 * Production, one comment section: a message scored 0.92 and was answered with
 * a captcha (the `low_information_profile` ceiling), the captcha was
 * undeliverable to a commenter who is not a member of the discussion group, and
 * the gate came off. Five reports later the screen reached `ban` twice and
 * banned the account for a month — and the message it had been reported about
 * stayed in the chat, because this branch never goes through `executor.ts`,
 * where every removal action deletes the message as its first line.
 *
 * `screenAccount` was written for a report on an ARRIVAL, where there is no
 * message by definition, and grew the message case later. So the rule is stated
 * here rather than inferred at the call site:
 *
 *  - a gate removes nothing — it is a question, and a question that deletes the
 *    thing it is asking about has already answered itself;
 *  - a ban removes the message the screen was asked about, and only a message
 *    the TARGET sent: the arrival screen is handed Telegram's join line, which
 *    belongs to nobody and is not what anyone reported;
 *  - `0` is not a message id. It is this file's neighbour's sentinel for "no
 *    message" (`replyToMessageId ?? 0`, the card key), and a delete call built
 *    from a sentinel is a delete call aimed at whatever id 0 resolves to.
 */
describe('accountScreenRemoves', () => {
  it('a ban removes the message it was asked about', () => {
    expect(accountScreenRemoves('ban', 382656)).toBe(382656)
  })

  it('a gate removes nothing, however the screen got there', () => {
    expect(accountScreenRemoves('gate', 382656)).toBe(null)
  })

  it('a screen with no message of the target’s removes nothing', () => {
    // The `reported_arrival` path: the id it carries is Telegram's join line.
    expect(accountScreenRemoves('ban', null)).toBe(null)
  })

  it('REGRESSION: the no-message sentinel is not a message id', () => {
    expect(accountScreenRemoves('ban', 0)).toBe(null)
  })
})

/**
 * The hold a report used to lose along with the question.
 *
 * Production 2026-09-01: 19 accounts reported by people, gated by the screen,
 * and released because `ephemeral.sendMessage` answered USER_NOT_PARTICIPANT —
 * a commenter under a channel post is not a member of the discussion group.
 * Sixteen were never punished by anything; the three that were needed a second
 * human report. Every one of the nineteen already had a ballot open, which is
 * why the fallback is a hold and not another ballot.
 */
describe('accountScreenUnasked', () => {
  it('a question nobody could be asked still leaves the hold it was asked in', () => {
    expect(accountScreenUnasked(['sender_not_participant'], true)).toBe('hold')
  })

  it('a chat that cannot be asked either has no way to end a hold', () => {
    // The hold's whole justification is that the room is answering instead.
    expect(accountScreenUnasked(['sender_not_participant'], false)).toBe('none')
  })

  it('a chat that switched the captcha off did not ask for a mute instead', () => {
    // Deliberately distinct from undeliverability: the chat made a choice here,
    // and routing around it would overrule the setting rather than route past a
    // network fact.
    expect(accountScreenUnasked(['captcha_disabled'], true)).toBe('none')
    expect(accountScreenUnasked(['captcha_disabled', 'sender_not_participant'], true)).toBe('none')
  })

  it('an identity that cannot answer anything is not held either', () => {
    // `mute` on a channel sender is a ban by construction — see mayAskCaptcha.
    expect(accountScreenUnasked(['sender_is_channel'], true)).toBe('none')
  })

  it('nothing blocked it, so the gate is live and holds them itself', () => {
    expect(accountScreenUnasked([], true)).toBe('none')
  })
})
