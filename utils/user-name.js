const { escapeHtml } = require('../helpers/text-utils')

module.exports = (user, url = false) => {
  // Handle null, undefined, or non-object types
  if (!user || typeof user !== 'object') return 'Unknown'

  // Build name with proper fallbacks (check each value explicitly)
  let name = null
  if (user.first_name) name = user.first_name
  else if (user.title) name = user.title
  else if (user.username) name = user.username
  else if (user.id) name = `ID:${user.id}`
  else name = 'Unknown'

  if (user.last_name) name += ` ${user.last_name}`

  // Escape HTML first (`&` must go before `<`/`>` to prevent double-decoding
  // attacks: raw `&lt;b&gt;` would otherwise pass through unchanged and be
  // rendered by Telegram as real `<b>` tags). Then escape `@` so names like
  // "@admin" can't be mistaken for a mention entity.
  name = escapeHtml(name).replace(/@/g, '&#64;')

  if (url && user.id) return `<a href="tg://user?id=${user.id}">${name}</a>`
  return name
}
