// /help handler — thin wrapper that delegates to the help menu screen.
// The old text-wall lived in `cmd.help` of each locale; the tabbed screen
// (helpers/menu/screens/help.js) has replaced it. `cmd.help` is intentionally
// left in the locale files for now — some error paths still reference it,
// and we'll clean it up in the Plan 8 locale audit pass.

const help = require('../helpers/menu/screens/help')

module.exports = async (ctx) => {
  if (!ctx.from) return
  await help.sendHelp(ctx, ctx.from.id)
}
