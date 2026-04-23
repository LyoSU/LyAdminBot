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
  menu_state: 10 * 60 * 1000,
  // Captcha gates (mid-confidence soft-mute + global-ban appeal).
  // captcha_window      — soft-mute restriction window for the suspect user.
  //                       Matches the captcha row TTL; on expiry the
  //                       in-process escalation timer flips to a 24h mute.
  // captcha_appeal_window — global-ban appeal slot in PM.
  // captcha_pass_notice — auto-delete the "✓ {name} — людина" group line
  //                       after a pass; the action is journalled in ModLog
  //                       so the in-chat record is intentionally short-lived.
  captcha_window: 5 * 60 * 1000,
  captcha_appeal_window: 10 * 60 * 1000,
  captcha_pass_notice: 30 * 1000
}
