/**
 * Pure list operations for welcome texts / gifs. Storage lives in mongo.ts;
 * these helpers own the add-with-limit/dedup and remove-by-index logic so it
 * stays unit-testable away from the DB. v1 kept multiple texts and gifs with
 * random rotation — v2 regressed to a single overwritten slot; this restores
 * the multi-item behaviour.
 */

export const MAX_WELCOME_TEXTS = 20
export const MAX_WELCOME_GIFS = 20
export const MAX_WELCOME_TEXT_LEN = 1000

export type AddReason = 'empty' | 'too_long' | 'duplicate' | 'limit'
export interface AddResult {
  list: string[]
  added: boolean
  reason?: AddReason
}

/**
 * Append an item (welcome text or gif file id) to a list, enforcing trim,
 * optional max length, de-duplication, and a hard cap. Returns the new list
 * plus a machine-readable reason when nothing was added — the caller maps that
 * to a localized toast.
 */
export const addWelcomeItem = (
  list: string[],
  item: string,
  opts: { max: number; maxLen?: number }
): AddResult => {
  const trimmed = item.trim()
  if (!trimmed) return { list, added: false, reason: 'empty' }
  if (opts.maxLen !== undefined && trimmed.length > opts.maxLen) {
    return { list, added: false, reason: 'too_long' }
  }
  if (list.includes(trimmed)) return { list, added: false, reason: 'duplicate' }
  if (list.length >= opts.max) return { list, added: false, reason: 'limit' }
  return { list: [...list, trimmed], added: true }
}

/** Remove the item at `index`; a no-op (returns the same list) when out of range. */
export const removeAt = (list: string[], index: number): string[] =>
  index >= 0 && index < list.length
    ? [...list.slice(0, index), ...list.slice(index + 1)]
    : list

/**
 * Build the HTML-safe greeting body from a raw admin-authored template and a
 * pre-escaped `names` fragment (already wrapped in <b>…</b>). The template is
 * user-controlled, so it MUST be escaped before it touches the HTML parser —
 * an unescaped `<` or stray `&` in a welcome text used to throw inside mtcute's
 * html() and get swallowed, so newcomers saw the default greeting (or nothing).
 * `%name%` is our own placeholder, substituted AFTER escaping with the safe
 * names fragment. Returns text with `\n` preserved (the caller maps it to <br>).
 */
export const buildWelcomeGreeting = (
  template: string | null | undefined,
  safeNames: string,
  fallback: string
): string => {
  if (!template) return fallback
  return escapeForHtml(template).replace(/%name%/g, safeNames)
}

const escapeForHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
