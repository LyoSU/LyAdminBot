import { describe, expect, it } from 'vitest'
import { channelReportRoute, isThreadRoot, reportPath, reportVoteRoute, rulesFirst } from './report-route.js'

describe('channelReportRoute', () => {
  const base = { senderId: -1002, chatId: -1001, isAutomaticForward: false, judgeable: true }

  it('an admin reporting a channel identity bans it; anybody else is told why not', () => {
    expect(channelReportRoute({ ...base, reporterIsAdmin: true })).toBe('ban')
    expect(channelReportRoute({ ...base, reporterIsAdmin: false })).toBe('explain')
  })

  it('the group posting as itself is an admin, never a target', () => {
    for (const reporterIsAdmin of [true, false]) {
      expect(channelReportRoute({ ...base, senderId: -1001, reporterIsAdmin })).toBe('admin_post')
    }
  })

  it('the linked channel\'s mirrored post is the thread root, never banned', () => {
    expect(channelReportRoute({ ...base, isAutomaticForward: true, judgeable: false, reporterIsAdmin: true }))
      .toBe('thread_root')
    expect(channelReportRoute({ ...base, judgeable: false, reporterIsAdmin: true })).toBe('thread_root')
  })
})

describe('reportPath', () => {
  const plain = { isAutomaticForward: false, actionType: null }
  const channelRoot = { isAutomaticForward: true, actionType: null }
  const topicRoot = { isAutomaticForward: false, actionType: 'topic_created' }

  it('no reply at all is the named form', () => {
    expect(reportPath(null, '')).toBe('named')
    expect(reportPath(null, '@someone')).toBe('named')
  })

  it('a reply to an ordinary message is about that message, whatever follows', () => {
    expect(reportPath(plain, '')).toBe('reply')
    expect(reportPath(plain, '@someone spams')).toBe('reply')
  })

  it('the implicit reply to a thread root does not swallow a named report', () => {
    expect(reportPath(channelRoot, '@someone')).toBe('named')
    expect(reportPath(topicRoot, '123456789')).toBe('named')
  })

  it('a bare report on a thread root stays a reply', () => {
    expect(reportPath(channelRoot, '')).toBe('reply')
    expect(reportPath(topicRoot, '   ')).toBe('reply')
  })

  it('other service lines are not thread roots', () => {
    expect(isThreadRoot({ isAutomaticForward: false, actionType: 'user_joined_link' })).toBe(false)
  })
})

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
