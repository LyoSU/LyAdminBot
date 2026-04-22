const policy = require('../cleanup-policy')

const ensureArray = (group) => {
  if (!group.settings) group.settings = {}
  if (!Array.isArray(group.settings.menuState)) group.settings.menuState = []
  return group.settings.menuState
}

const findIndex = (arr, userId, screen) =>
  arr.findIndex(e => e.userId === userId && e.screen === screen)

const isExpired = (entry) => entry.expiresAt && entry.expiresAt.getTime() < Date.now()

const setState = (group, userId, screen, data) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  const entry = {
    userId,
    screen,
    data,
    expiresAt: new Date(Date.now() + policy.menu_state)
  }
  if (idx >= 0) arr[idx] = entry
  else arr.push(entry)
}

const getState = (group, userId, screen) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  if (idx < 0) return null
  if (isExpired(arr[idx])) {
    arr.splice(idx, 1)
    return null
  }
  return arr[idx].data
}

const clearState = (group, userId, screen) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  if (idx >= 0) arr.splice(idx, 1)
}

const cleanupExpired = (group) => {
  const arr = ensureArray(group)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isExpired(arr[i])) arr.splice(i, 1)
  }
}

module.exports = { setState, getState, clearState, cleanupExpired }
