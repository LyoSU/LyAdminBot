// Central screen-registration hub. Each screen module exports `register()`;
// this module calls them all in order on boot. Keep this short — the
// registration order shouldn't matter (registry keys by id) but by convention
// we register parent screens before children.

const help = require('./help')
const onboarding = require('./onboarding')
const settings = require('./settings')
const modEvent = require('./mod-event')
const modBanPicker = require('./mod-ban-picker')
const modDelUndo = require('./mod-del-undo')
const modRights = require('./mod-rights')

const registerAll = () => {
  help.register()
  onboarding.register()
  settings.register()
  modEvent.register()
  modBanPicker.register()
  modDelUndo.register()
  modRights.register()
}

module.exports = {
  registerAll,
  help,
  onboarding,
  settings,
  modEvent,
  modBanPicker,
  modDelUndo,
  modRights
}
