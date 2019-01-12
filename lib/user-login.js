module.exports = (user, url = false) => {
  var login = user.first_name
  if (user.last_name) login += ' ' + user.last_name
  if (url === true) login = `<a href="tg://user?id=${user.id}">${login}</a>`
  return login
}
