const Entities = require('html-entities').AllHtmlEntities


const entities = new Entities();

module.exports = (user, url = false) => {
  let name = user.first_name

  if (user.last_name) name += ` ${user.last_name}`
  name = entities.encode(name)

  if (url) return `<a href="tg://user?id=${user.id}">${name}</a>`
  return name
}
