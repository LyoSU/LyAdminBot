const screens = new Map()

const registerMenu = (screen) => {
  if (!screen || !screen.id) throw new Error('menu: id is required')
  if (!screen.access) throw new Error(`menu[${screen.id}]: access is required`)
  if (typeof screen.render !== 'function') throw new Error(`menu[${screen.id}]: render is required (function)`)
  if (typeof screen.handle !== 'function') throw new Error(`menu[${screen.id}]: handle is required (function)`)
  if (screens.has(screen.id)) throw new Error(`menu[${screen.id}]: already registered`)
  screens.set(screen.id, screen)
  return screen
}

const getMenu = (id) => screens.get(id)

const listMenus = () => Array.from(screens.keys())

module.exports = { registerMenu, getMenu, listMenus }
