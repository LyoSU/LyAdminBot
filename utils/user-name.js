module.exports = (user, url = false) => {
  if (!user) return 'Unknown'

  let name = user.first_name || user.title || user.username || `ID:${user.id}` || 'Unknown'

  if (user.last_name) name += ` ${user.last_name}`
  name = String(name).replace(/</g, '&lt;').replace(/>/g, '&gt;')

  if (url) return `<a href="tg://user?id=${user.id}">${name}</a>`
  return name
}
