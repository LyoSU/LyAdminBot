module.exports = (user, url = false) => {
  let name = user.first_name

  if (user.last_name) {
    name += ` ${user.last_name}`
  }

  if (url) {
    return `<a href="tg://user?id=${user.id}">${name}</a>`
  }

  return name
}
