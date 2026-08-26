import { describe, expect, it } from 'vitest'
import { chatScriptProfile, confusableScriptMix, dominantScript, informativeLength } from './script.js'

describe('dominantScript', () => {
  it('names the script the text is actually written in', () => {
    expect(dominantScript('Доброго дня, шукаю роботу')).toBe('cyrillic')
    expect(dominantScript('looking for work in Warsaw')).toBe('latin')
    expect(dominantScript('酒店投放摄像头一台')).toBe('han')
  })

  it('ignores digits, punctuation and emoji when deciding', () => {
    expect(dominantScript('!!! 2500$ 🔥🔥 робота 🔥')).toBe('cyrillic')
  })

  it('is null when no script holds a majority — mixed text names no language', () => {
    expect(dominantScript('абвгд abcde')).toBe(null)
  })

  it('is null when there are no letters at all', () => {
    expect(dominantScript('2500 $$$ 🔥')).toBe(null)
    expect(dominantScript('')).toBe(null)
  })

  it('a handful of Latin brand characters does not relabel a CJK message', () => {
    // The pattern in the message that prompted this: logographic text with a
    // couple of Latin letters wedged in to break naive matching.
    expect(dominantScript('会洗mi的来 日入上w')).toBe('han')
  })
})

describe('informativeLength', () => {
  it('counts alphabetic scripts one per character', () => {
    expect(informativeLength('роботаробота')).toBe(12)
    expect(informativeLength('abcdefghij')).toBe(10)
  })

  it('counts logographic characters as the words they are', () => {
    // Eight Han characters plus two Latin: a complete sentence, not a greeting.
    // At one-per-codepoint this measured 10 and every length gate called it
    // uninformative (2026-07-31).
    expect(informativeLength('会洗mi的来日入上w')).toBeGreaterThanOrEqual(20)
  })

  it('still treats a genuinely short logographic message as short', () => {
    // "thank you" in Chinese must stay below any reasonable gate: the point is
    // to measure content, not to declare every CJK message informative.
    expect(informativeLength('谢谢')).toBeLessThan(20)
    expect(informativeLength('你好吗')).toBeLessThan(20)
  })

  it('counts syllabic scripts between the two', () => {
    expect(informativeLength('ありがとう')).toBeLessThan(20)
    expect(informativeLength('안녕하세요')).toBeLessThan(20)
  })
})

describe('chatScriptProfile', () => {
  const lines = (...previews: string[]): { textPreview: string | null }[] =>
    previews.map((textPreview) => ({ textPreview }))

  it('always tolerates the scripts of the locales the bot ships', () => {
    const profile = chatScriptProfile({ topLanguage: null, title: '' }, [])
    expect(profile.has('latin')).toBe(true)
    expect(profile.has('cyrillic')).toBe(true)
    expect(profile.has('han')).toBe(false)
  })

  it('learns a chat\'s script from what people actually write in it', () => {
    const profile = chatScriptProfile({ topLanguage: null, title: '' },
      lines('酒店的房间很好', '我明天过来看看', '好的没问题谢谢你'))
    expect(profile.has('han')).toBe(true)
  })

  it('does not learn a script from one stray line in a chat that speaks another', () => {
    // Sample is well over the size bar; it is dominance that rejects Han here.
    const profile = chatScriptProfile({ topLanguage: null, title: 'Робота' },
      lines('谢谢', 'дякую за відповідь, дуже допомогло', 'а коли буде наступна зустріч'))
    expect(profile.has('han')).toBe(false)
    expect(profile.has('cyrillic')).toBe(true)
  })

  it('takes the chat title as evidence too — a quiet chat still has a name', () => {
    const profile = chatScriptProfile({ topLanguage: null, title: '日本語チャットへようこそ' }, [])
    expect(profile.has('kana')).toBe(true)
  })

  it('never shrinks: every source only adds tolerated scripts', () => {
    // A Latin-titled chat where people write Cyrillic must not have Cyrillic
    // taken away from it — the profile is a union, so no source can veto.
    const profile = chatScriptProfile({ topLanguage: 'en', title: 'JS Liberty' },
      lines('привіт, хтось знає як це зробити'))
    expect(profile.has('cyrillic')).toBe(true)
    expect(profile.has('latin')).toBe(true)
  })
})

describe('chatScriptProfile — the chat description as a language sample', () => {
  it('learns the script the chat describes itself in', () => {
    // The description is admin-authored and usually far longer than the title,
    // so it clears the sample bar the title rarely does. It joins the union like
    // every other source, meaning it can only ever ADD tolerance — a description
    // in an unexpected script cannot take a script away from a chat.
    const profile = chatScriptProfile({
      topLanguage: null,
      title: 'Group',
      description: '本群讨论摄影与旅行，欢迎大家分享作品和经验，请勿发布广告内容。'
    }, [])
    expect(profile.has('han')).toBe(true)
    expect(profile.has('cyrillic')).toBe(true)
  })

  it('a passing mention in the description teaches nothing', () => {
    const profile = chatScriptProfile({
      topLanguage: null,
      title: 'Чат',
      description: 'Спільнота українців. Слоган: 加油'
    }, [])
    expect(profile.has('han')).toBe(false)
  })

  it('works without a description, as before', () => {
    const profile = chatScriptProfile({ topLanguage: 'uk', title: 'Чат', description: null }, [])
    expect(profile.has('cyrillic')).toBe(true)
    expect(profile.has('han')).toBe(false)
  })
})


/**
 * Which look-alike alphabets a word borrows from, not merely whether it borrows.
 *
 * Measured 2026-08-26 over 3680 unacted decisions and 1182 acted ones: a word
 * mixing GREEK into Cyrillic appeared twice among the unacted (both adverts),
 * eleven times among the acted, and zero times among the 1293 unacted whose
 * sender carried standing or trust. A word mixing LATIN into Cyrillic appeared
 * nine times among the unacted and most of those are people typing — `пiдкрутка`,
 * `Цитата обрiзана`, `interessно`. One signal charged both at the same weight.
 */
describe('confusableScriptMix', () => {
  it('names the alphabets, so the caller can tell a habit from an evasion', () => {
    expect(confusableScriptMix('πеρеписке').sort()).toEqual(['cyrillic', 'greek'])
    expect(confusableScriptMix('пiдкрутка').sort()).toEqual(['cyrillic', 'latin'])
  })

  it('is empty when one alphabet does all the work', () => {
    expect(confusableScriptMix('переписке')).toEqual([])
    expect(confusableScriptMix('correspondence')).toEqual([])
    // Greek written as Greek is a language, not a disguise.
    expect(confusableScriptMix('παραλία')).toEqual([])
  })
})
