import { describe, expect, it } from 'vitest'
import { parseReportTarget } from './report-target.js'

describe('parseReportTarget', () => {
  it('reads a username in every way people paste one', () => {
    for (const args of ['@spam_bot1', 't.me/spam_bot1', 'https://t.me/spam_bot1', '@spam_bot1 спамить у коментарях']) {
      expect(parseReportTarget(args, []), args).toEqual({ kind: 'username', username: 'spam_bot1' })
    }
  })

  it('reads a numeric id, and the tg:// link a client copies', () => {
    expect(parseReportTarget('123456789', [])).toEqual({ kind: 'id', id: 123456789 })
    expect(parseReportTarget('tg://user?id=123456789', [])).toEqual({ kind: 'id', id: 123456789 })
    expect(parseReportTarget('id 123456789', [])).toEqual({ kind: 'id', id: 123456789 })
  })

  it('a person picked from the member list wins over whatever else was typed', () => {
    // A member with no username, chosen through @, arrives as an entity that
    // carries the id — the only way to name them at all.
    expect(parseReportTarget('Олена спамить', [42])).toEqual({ kind: 'id', id: 42 })
  })

  it('free words are not somebody to report', () => {
    for (const args of ['', 'спам', 'spammer', 'це спам!!!', 'ab', '@x', '-1001234567890', '0', '12']) {
      expect(parseReportTarget(args, []), args).toBeNull()
    }
  })
})
