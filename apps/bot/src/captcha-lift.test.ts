import { describe, expect, it } from 'vitest'
import { CAPTCHA_LIFT_SLACK_MS, captchaLift, readMemberRestriction } from './captcha-lift.js'

const MIN = 60 * 1000
const issued = 1_000_000_000_000
/** The gate's own expiry: 2 min grace + 60 min mute + 10 min slack. */
const gateExpires = issued + 72 * MIN

const restricted = (untilMs: number | null, allSendBlocked = true) =>
  ({ status: 'restricted', untilMs, allSendBlocked })

describe('captchaLift', () => {
  it('lifts our own mutes: the ten-minute gate hold and the ignored-gate hour', () => {
    expect(captchaLift(restricted(issued + 10 * MIN), gateExpires)).toEqual({ kind: 'lift' })
    expect(captchaLift(restricted(issued + 2 * MIN + 60 * MIN + 5000), gateExpires)).toEqual({ kind: 'lift' })
  })

  it('tolerates clock disagreement up to the slack', () => {
    expect(captchaLift(restricted(gateExpires + CAPTCHA_LIFT_SLACK_MS), gateExpires)).toEqual({ kind: 'lift' })
  })

  it('leaves an admin mute that outlasts the gate', () => {
    expect(captchaLift(restricted(issued + 24 * 60 * MIN), gateExpires))
      .toEqual({ kind: 'foreign', reason: 'outlasts_gate' })
  })

  it('leaves a mute with no end — Telegram\'s "forever"', () => {
    expect(captchaLift(restricted(null), gateExpires)).toEqual({ kind: 'foreign', reason: 'no_expiry' })
  })

  it('leaves a partial restriction, which the gate never imposes', () => {
    expect(captchaLift(restricted(issued + 10 * MIN, false), gateExpires))
      .toEqual({ kind: 'foreign', reason: 'partial' })
  })

  it('nothing to lift when no restriction is in force', () => {
    for (const status of ['member', 'admin', 'creator', 'left', 'banned']) {
      expect(captchaLift({ status, untilMs: null, allSendBlocked: false }, gateExpires), status)
        .toEqual({ kind: 'nothing' })
    }
  })

  it('a failed read lifts nothing', () => {
    expect(captchaLift(null, gateExpires)).toEqual({ kind: 'unreadable' })
  })
})

describe('readMemberRestriction', () => {
  const all = {
    canSendMessages: false, canSendMedia: false, canSendStickers: false, canSendGifs: false,
    canSendGames: false, canUseInline: false, canAddWebPreviews: false, canSendPolls: false,
    canSendPhotos: false, canSendVideos: false, canSendRoundVideos: false, canSendAudios: false,
    canSendVoices: false, canSendFiles: false, canSendText: false
  }

  it('reads our mute', () => {
    const until = new Date(issued + 10 * MIN)
    expect(readMemberRestriction({ status: 'restricted', restrictions: { ...all, untilDate: until } }))
      .toEqual({ status: 'restricted', untilMs: until.getTime(), allSendBlocked: true })
  })

  it('a single send right left open is a partial restriction', () => {
    expect(readMemberRestriction({ status: 'restricted', restrictions: { ...all, canSendText: true, untilDate: null } }))
      .toEqual({ status: 'restricted', untilMs: null, allSendBlocked: false })
  })

  it('an empty answer is "not here", with nothing of ours on it', () => {
    expect(captchaLift(readMemberRestriction(null), gateExpires)).toEqual({ kind: 'nothing' })
  })

  it('a plain member has no restrictions', () => {
    expect(readMemberRestriction({ status: 'member', restrictions: null }))
      .toEqual({ status: 'member', untilMs: null, allSendBlocked: false })
  })
})
