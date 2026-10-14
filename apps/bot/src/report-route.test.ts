import { describe, expect, it } from 'vitest'
import { reportVoteRoute, rulesFirst } from './report-route.js'

describe('reportVoteRoute', () => {
  it('an admin on an open vote resolves it, as before', () => {
    expect(reportVoteRoute({ status: 'open', tallySpam: true, reporterIsAdmin: true })).toBe('resolve')
  })

  it('an open vote without a spam outcome goes to the community', () => {
    for (const reporterIsAdmin of [false, true]) {
      expect(reportVoteRoute({ status: 'open', tallySpam: false, reporterIsAdmin })).toBe('community')
    }
  })

  it('a closed or expired vote is never silently dropped', () => {
    for (const status of ['expired', 'ham', 'spam']) {
      expect(reportVoteRoute({ status, tallySpam: false, reporterIsAdmin: true }), status).toBe('rerule')
      expect(reportVoteRoute({ status, tallySpam: false, reporterIsAdmin: false }), status).toBe('closed')
    }
  })

  it('an unreadable vote is not claimed to be closed', () => {
    expect(reportVoteRoute({ status: null, tallySpam: false, reporterIsAdmin: true })).toBe('community')
    expect(reportVoteRoute({ status: null, tallySpam: false, reporterIsAdmin: false })).toBe('community')
  })
})

describe('rulesFirst', () => {
  it('a question that already closed as spam is not counted twice', () => {
    expect(rulesFirst('spam')).toBe(false)
    expect(rulesFirst('expired')).toBe(true)
    expect(rulesFirst('ham')).toBe(true)
  })
})
