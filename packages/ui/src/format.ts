/**
 * Number typography for the cards.
 *
 * Separators live here rather than in the view because they are a property of
 * the language, not of the layout: a locale file picks its own and the view
 * never has to know which. The grouping space is NBSP on purpose — Telegram
 * wraps on ordinary spaces, and a count that breaks across two lines reads as
 * two counts.
 */
export const NBSP = ' '

/** 220509 → "220 509" (grouped by threes with `sep`). */
export const groupDigits = (n: number, sep: string = NBSP): string => {
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n)
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  return rounded < 0 ? `-${digits}` : digits
}

/**
 * 97.5987 → "97,6". One decimal, and the point dropped when it is a whole
 * number — "100,0%" is a percentage nobody writes by hand.
 */
export const decimal1 = (n: number, sep: string = ','): string => {
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', sep)
}
