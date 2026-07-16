import { describe, expect, it } from 'vitest'
import { addWelcomeItem, removeAt, buildWelcomeGreeting } from './welcome.js'

describe('addWelcomeItem', () => {
  it('appends a trimmed item', () => {
    expect(addWelcomeItem(['a'], '  b  ', { max: 20 }))
      .toEqual({ list: ['a', 'b'], added: true })
  })

  it('rejects an empty / whitespace item', () => {
    expect(addWelcomeItem([], '   ', { max: 20 }))
      .toEqual({ list: [], added: false, reason: 'empty' })
  })

  it('rejects a duplicate (after trim)', () => {
    expect(addWelcomeItem(['hi'], 'hi ', { max: 20 }))
      .toEqual({ list: ['hi'], added: false, reason: 'duplicate' })
  })

  it('rejects once the cap is reached', () => {
    expect(addWelcomeItem(['x', 'y'], 'z', { max: 2 }))
      .toEqual({ list: ['x', 'y'], added: false, reason: 'limit' })
  })

  it('rejects text over maxLen', () => {
    expect(addWelcomeItem([], 'abcd', { max: 20, maxLen: 3 }))
      .toEqual({ list: [], added: false, reason: 'too_long' })
  })
})

describe('removeAt', () => {
  it('removes the item at an in-range index', () => {
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })

  it('is a no-op for an out-of-range index', () => {
    expect(removeAt(['a'], 5)).toEqual(['a'])
    expect(removeAt(['a'], -1)).toEqual(['a'])
  })
})

describe('buildWelcomeGreeting', () => {
  const names = '<b>Іван</b>'

  it('substitutes %name% with the pre-escaped names fragment', () => {
    expect(buildWelcomeGreeting('Вітаю, %name%!', names, 'fallback'))
      .toBe('Вітаю, <b>Іван</b>!')
  })

  it('escapes user-controlled markup so it cannot break the HTML parser', () => {
    expect(buildWelcomeGreeting('<script> & <b>hack</b> %name%', names, 'fallback'))
      .toBe('&lt;script&gt; &amp; &lt;b&gt;hack&lt;/b&gt; <b>Іван</b>')
  })

  it('falls back when the template is null/empty', () => {
    expect(buildWelcomeGreeting(null, names, 'default')).toBe('default')
    expect(buildWelcomeGreeting('', names, 'default')).toBe('default')
  })
})
