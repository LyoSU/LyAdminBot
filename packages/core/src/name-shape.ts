/**
 * The shape of a name and its handle — recorded, not weighed.
 *
 * Seen 2026-09-17 in another tool's sweep of one chat's member list: about a
 * quarter of the accounts it called clean wore names cut from one template — a
 * Latin first word, sometimes two words run together with an inner capital,
 * beside a Cyrillic word, and a handle that repeats the first word in lower
 * case, optionally a filler word, then two or three digits. Bare profiles, the
 * newest id block, nothing for any profile stage to find: what the accounts in
 * `profile-recheck.ts` look like before they dress.
 *
 * Whether the shape separates anything could not be measured. v2 stores no
 * names: of 5665 accounts in the newest id block 598 had one on record, and the
 * decision record carries none. So the shape is written down — four small
 * facts, never the name itself — and a week of rows says what each is worth
 * against the regulars, who pick name-plus-digits handles too.
 */
export interface NameShape {
  handle: 'name_digits' | 'name_user_digits' | null
  /** How many digits close the handle; null unless `handle` has the shape. */
  digits: number | null
  camel: boolean
  mixedWords: boolean
}

const LATIN_WORD = /^\p{Script=Latin}+$/u
const CYRILLIC_WORD = /^\p{Script=Cyrillic}+$/u

export const nameShapeOf = (displayName: string, username: string | null): NameShape => {
  const name = String(displayName ?? '')
  const first = name.match(/^[A-Za-z]+/)?.[0] ?? ''

  let handle: NameShape['handle'] = null
  const parts = typeof username === 'string' ? username.toLowerCase().match(/^([a-z]+)(\d{2,4})$/) : null
  const letters = parts?.[1]
  if (letters && first.length >= 3) {
    const stem = first.toLowerCase()
    // Compared whole rather than parsed apart, so a name that itself ends in
    // the filler word is still read as the name.
    if (letters === stem) handle = 'name_digits'
    else if (letters === `${stem}user`) handle = 'name_user_digits'
  }

  const words = name.split(/[^\p{L}]+/u).filter(Boolean)
  return {
    handle,
    digits: handle !== null ? parts![2]!.length : null,
    camel: /^[A-Z][a-z]{2,}[A-Z][a-z]{2,}/.test(first),
    mixedWords: words.some((w) => LATIN_WORD.test(w)) && words.some((w) => CYRILLIC_WORD.test(w))
  }
}
