// Auto-delete TTLs for transient bot messages and menu state.
// All values in milliseconds. Single source of truth — referenced by handlers
// via scheduleDeletion() and by helpers/menu/state.js for state expiry.

module.exports = {
  cmd_help: 60 * 1000,
  cmd_settings_idle: 10 * 60 * 1000,
  vote_result: 2 * 60 * 1000,
  // Unified mod-event notifications (§9 of UX spec).
  // `mod_event` retained as legacy alias equal to the expanded TTL until
  // call-sites are migrated (currently: none — sender uses the *_compact /
  // *_expanded / *_override variants directly).
  mod_event: 2 * 60 * 1000,
  mod_event_compact: 90 * 1000,
  mod_event_expanded: 2 * 60 * 1000,
  mod_event_override: 30 * 1000,
  // Post-result spam-vote action buttons (§10) — `[⛔ Забанити назавжди]`,
  // `[↩️ Розблокувати]`, `[⛔ Все ж забанити]`. After the window expires the
  // result text remains as the journal record and only the keyboard is
  // stripped — the message itself is not deleted by this TTL.
  vote_post_result_btn: 60 * 1000,
  banan_undo: 60 * 1000,
  onboarding_ack: 30 * 1000,
  confirm_screen: 30 * 1000,
  quick_picker: 30 * 1000,
  menu_state: 10 * 60 * 1000
}
