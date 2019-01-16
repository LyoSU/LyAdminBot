module.exports = (user, url = false) => {
  let login = user.first_name

  if (user.last_name) {
    login += ` ${user.last_name}`
  }

  if (url) {
    return `<a href="tg://user?id=${user.id}">${login}</a>`
  }

  return login
}
