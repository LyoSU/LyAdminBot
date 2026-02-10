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

  // Escape HTML characters
  name = String(name).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;')

  if (url && user.id) return `<a href="tg://user?id=${user.id}">${name}</a>`
  return name
}
