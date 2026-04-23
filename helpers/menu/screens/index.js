// Central screen-registration hub. Each screen module exports `register()`;
// this module calls them all in order on boot. Keep this short — the
// registration order shouldn't matter (registry keys by id) but by convention
// we register parent screens before children.

const help = require('./help')
const onboarding = require('./onboarding')
const langPicker = require('./lang-picker')
const settings = require('./settings')
const settingsWelcome = require('./settings-welcome')
const settingsExtras = require('./settings-extras')
const settingsModlog = require('./settings-modlog')
const modEvent = require('./mod-event')
const modVoteDetails = require('./mod-vote-details')
const modBanPicker = require('./mod-ban-picker')
const modDelUndo = require('./mod-del-undo')
const modRights = require('./mod-rights')
const statsTop = require('./stats-top')
const statsTopBanan = require('./stats-top-banan')
const statsExtras = require('./stats-extras')

const registerAll = () => {
  help.register()
  onboarding.register()
  langPicker.register()
  settings.register()
  settingsWelcome.register()
  settingsExtras.register()
  settingsModlog.register()
  modEvent.register()
  modVoteDetails.register()
  modBanPicker.register()
  modDelUndo.register()
  modRights.register()
  statsTop.register()
  statsTopBanan.register()
  statsExtras.register()
}

module.exports = {
  registerAll,
  help,
  onboarding,
  langPicker,
  settings,
  settingsWelcome,
  settingsExtras,
  settingsModlog,
  modEvent,
  modVoteDetails,
  modBanPicker,
  modDelUndo,
  modRights,
  statsTop,
  statsTopBanan,
  statsExtras
}
