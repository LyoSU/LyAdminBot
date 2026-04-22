const registry = require('./registry')
const keyboard = require('./keyboard')
const access = require('./access')
const state = require('./state')
const router = require('./router')
const flows = require('./flows')

module.exports = {
  // Registry
  registerMenu: registry.registerMenu,
  getMenu: registry.getMenu,
  listMenus: registry.listMenus,

  // Keyboard builders
  cb: keyboard.cb,
  btn: keyboard.btn,
  row: keyboard.row,
  backBtn: keyboard.backBtn,
  closeBtn: keyboard.closeBtn,
  toggleBtn: keyboard.toggleBtn,
  paginated: keyboard.paginated,
  confirmKeyboard: keyboard.confirmKeyboard,
  PREFIX: keyboard.PREFIX,
  NOOP: keyboard.NOOP,
  CLOSE: keyboard.CLOSE,

  // Access
  checkAccess: access.checkAccess,
  isAdmin: access.isAdmin,
  isInitiator: access.isInitiator,

  // State
  setState: state.setState,
  getState: state.getState,
  clearState: state.clearState,
  cleanupExpired: state.cleanupExpired,

  // Router
  parseCallback: router.parseCallback,
  handleCallback: router.handleCallback,
  renderScreen: router.renderScreen,

  // Flows
  startInputFlow: flows.startInputFlow,
  consumeInput: flows.consumeInput
}
