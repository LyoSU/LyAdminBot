// Central screen-registration hub. Each screen module exports `register()`;
// this module calls them all in order on boot. Keep this short — the
// registration order shouldn't matter (registry keys by id) but by convention
// we register parent screens before children.

const help = require('./help')
const onboarding = require('./onboarding')

const registerAll = () => {
  help.register()
  onboarding.register()
}

module.exports = { registerAll, help, onboarding }
