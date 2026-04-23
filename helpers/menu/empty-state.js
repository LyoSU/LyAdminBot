// Shared renderer for "nothing here yet" screens (§17 of the UX spec).
//
// Produces a small `{ text, keyboard }` pair callers can splice directly into
// a menu-screen render result. Callers decide what CTAs to surface (if any)
// and what the back-destination is.
//
// Shape:
//
//   {emoji} {Title}
//
//   {description}
//
//   [ ➕ CTA_primary ]  [ ➕ CTA_secondary ]
//   [ ← Back ]
//
// Locale contract: `titleKey` and `descKey` resolve to already-localized
// HTML strings. The helper does no translation itself — that keeps the unit
// tests trivial and the output predictable.

const { row, btn, backBtn } = require('./keyboard')

/**
 * @param {object} i18n - Telegraf-i18n instance (must have t())
 * @param {object} opts
 * @param {string} [opts.icon] - Optional leading emoji (e.g. '📝'). If the
 *   title already starts with an emoji you can omit this.
 * @param {string} opts.titleKey - i18n key resolving to bold title HTML.
 * @param {string} opts.descKey - i18n key resolving to description HTML.
 * @param {Array<{label:string,callback:string}>} [opts.ctas] - Up to 2 CTAs
 *   rendered on one row. `callback` may be a plain string (already built
 *   via cb()) or a full callback_data.
 * @param {string} [opts.backScreenId] - If set, appends a back button
 *   targeting that screen.
 * @param {string} [opts.backLabel] - Override the back button label.
 * @returns {{ text: string, keyboard: { inline_keyboard: Array } }}
 */
const renderEmptyState = (i18n, opts = {}) => {
  const title = i18n.t(opts.titleKey)
  const desc = i18n.t(opts.descKey)
  const lines = []
  if (opts.icon) {
    // Title already carries its own icon in most locale strings; the explicit
    // `icon` arg is for screens where the key deliberately omits one so
    // several empty states can share a single title.
    lines.push(`${opts.icon} ${title}`)
  } else {
    lines.push(title)
  }
  lines.push('')
  lines.push(desc)
  const text = lines.join('\n')

  const inline = []
  const ctas = Array.isArray(opts.ctas) ? opts.ctas.filter(Boolean) : []
  if (ctas.length > 0) {
    inline.push(row(...ctas.map(c => btn(c.label, c.callback))))
  }
  if (opts.backScreenId) {
    inline.push(row(backBtn(opts.backScreenId, opts.backLabel ? { label: opts.backLabel } : {})))
  }

  return { text, keyboard: { inline_keyboard: inline } }
}

module.exports = { renderEmptyState }
