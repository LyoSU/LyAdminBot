// Auto-delete TTLs for transient bot messages and menu state.
// All values in milliseconds. Single source of truth — referenced by handlers
// via scheduleDeletion() and by helpers/menu/state.js for state expiry.

module.exports = {
  cmd_help: 60 * 1000,
  cmd_settings_idle: 10 * 60 * 1000,
  vote_result: 2 * 60 * 1000,
  mod_event: 2 * 60 * 1000,
  banan_undo: 60 * 1000,
  onboarding_ack: 30 * 1000,
  confirm_screen: 30 * 1000,
  quick_picker: 30 * 1000,
  menu_state: 10 * 60 * 1000
}
