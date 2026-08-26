import { describe, expect, it } from 'vitest'
import { accountVerdict, ACCOUNT_GATE_MIN_WEIGHT } from './account-verdict.js'
import type { Signal } from '../types.js'

const sig = (...names: string[]): Signal[] =>
  names.map((name) => ({ name, evidence: null } as unknown as Signal))

const clean = { hardAccountVerdict: false }

describe('accountVerdict', () => {
  it('bans an account another authority has already judged', () => {
    expect(accountVerdict([], { hardAccountVerdict: true })).toBe('ban')
    // And regardless of what the profile says — the ban does not need it.
    expect(accountVerdict(sig('promo_in_bio'), { hardAccountVerdict: true })).toBe('ban')
  })

  /**
   * The join gate's own bar, kept identical on purpose: an explicitly
   * pornographic profile picture is enough to ask, wherever it is noticed.
   */
  it('gates an explicit avatar on its own', () => {
    expect(accountVerdict(sig('nsfw_avatar'), clean)).toBe('gate')
  })

  it('gates a profile that advertises', () => {
    expect(accountVerdict(sig('private_invite_in_bio'), clean)).toBe('gate')
    expect(accountVerdict(sig('promo_in_name'), clean)).toBe('gate')
  })

  /**
   * Two accounts wearing one photograph is the one fact in this pipeline that
   * is not a judgement, so it carries on its own.
   */
  it('gates a photograph shared with other accounts', () => {
    expect(accountVerdict(sig('avatar_shared_with_accounts'), clean)).toBe('gate')
  })

  /**
   * The tier below explicit must not gate anybody. `suggestive_profile_media`
   * is what put a member through a captcha twice on 2026-08-25 for saying "ну и
   * ладно" — honest people put suggestive pictures on their profiles.
   */
  it('does nothing about a merely suggestive profile', () => {
    expect(accountVerdict(sig('suggestive_profile_media'), clean)).toBe('none')
  })

  it('does nothing about a single middling fact', () => {
    expect(accountVerdict(sig('sole_avatar_replaced'), clean)).toBe('none')
    expect(accountVerdict(sig('contact_in_bio'), clean)).toBe('none')
  })

  /**
   * Crumbs do not add up to a reason. Same rule the removal bar already
   * applies: 2026-07-30 saw a political comment kicked on three sub-threshold
   * signals summing past a bar, and the chat voted it ham within minutes.
   */
  it('refuses to stack sub-threshold nudges into a gate', () => {
    expect(accountVerdict(sig('promo_in_bio', 'personal_channel', 'avatar_recently_set'), clean))
      .toBe('none')
  })

  /**
   * The correlation ceiling applies here too: one profile advertised in three
   * places is one finding, not three.
   */
  it('caps a correlated group rather than counting it repeatedly', () => {
    const promo = sig('private_invite_in_bio', 'contact_in_bio', 'promo_in_linked_channel')
    // Still a gate — but by the cap, and never more than a gate.
    expect(accountVerdict(promo, clean)).toBe('gate')
  })

  /** Nothing about the message can reach this: it is a verdict about a person. */
  it('ignores message signals entirely', () => {
    expect(accountVerdict(sig('private_invite_link', 'flood', 'long_text'), clean)).toBe('none')
  })

  it('ignores newness, which is not evidence of anything', () => {
    expect(accountVerdict(sig('new_globally', 'new_in_chat', 'sleeper_awakened'), clean)).toBe('none')
  })

  it('ignores an unknown signal name rather than guessing a weight', () => {
    expect(accountVerdict(sig('not_a_real_signal'), clean)).toBe('none')
  })

  it('never returns anything but the three documented answers', () => {
    for (const names of [[], ['nsfw_avatar'], ['promo_in_name'], ['emoji_only']]) {
      expect(['ban', 'gate', 'none']).toContain(accountVerdict(sig(...names), clean))
    }
  })

  it('states its bar as a number the tests above rely on', () => {
    expect(ACCOUNT_GATE_MIN_WEIGHT).toBe(1.5)
  })
})
