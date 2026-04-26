// Pure helpers for the unified compact-by-default moderation notifications
// (§9 of the UX design). No I/O except the thin DB wrappers at the bottom.
//
// Design notes:
// - `buildCompactText` / `buildExpandedText` produce strings, not blobs.
//   They're consumed by both the initial send (helpers/mod-event-send.js)
//   and by the callback handler that re-renders after a click.
// - Keyboard builders take an `isAdmin` flag so the expanded view can hide
//   [↩️ Розблокувати] / [✓ Сховати] from non-admins. The COMPACT keyboard
//   always renders `[✓ Сховати]` because Telegram sends one inline keyboard
//   per message to ALL viewers — we can't truly hide per-viewer; the
//   callback handler enforces admin-only by toast-rejecting non-admins.
//   (Documented inline in the spec §9.)
// - `usernameLabel` mirrors the "Lols Anti Spam" short-label style:
//   @username > first_name > channel_title > id{N}. HTML-escaped for safe
//   embedding in the parse_mode:HTML messages.

const { cb, btn, row } = require('./menu/keyboard')
const { escapeHtml } = require('./text-utils')

const SCREEN_ID = 'mod.event'

const usernameLabel = (target) => {
  if (!target) return 'Unknown'
  // Telegram bots label channels via `title`; real users via `first_name`.
  // Username wins if present (prefixed with @) because it's the canonical
  // public handle; otherwise first_name / title; otherwise ID fallback.
  if (target.username) return `@${escapeHtml(target.username)}`
  if (target.first_name) return escapeHtml(target.first_name)
  if (target.title) return escapeHtml(target.title)
  if (target.id || target.id === 0) return `id${target.id}`
  return 'Unknown'
}

// Normalize a confidence value to an integer percentage (or pass through
// null/undefined). Used both for display (formatConfidence) and as a write-
// time invariant in createModEvent + the ModLog reason serializer, so that
// raw floats from the LLM/vector pipeline never reach persistence and break
// `group-by reason` analytics.
const roundConfidence = (n) => {
  if (n === null || n === undefined) return n
  const num = Number(n)
  if (!Number.isFinite(num)) return n
  return Math.round(num)
}

const formatConfidence = (n) => {
  const rounded = roundConfidence(n)
  return rounded == null ? null : `📊 ${rounded}%`
}

// Map action type → compact locale key. Auto-delete / auto-ban route to
// the same banned/muted/deleted rows; `suspicious` is a separate shape
// (bot saw something but took no action).
const COMPACT_KEY_BY_ACTION = {
  auto_ban: 'mod_event.compact.banned',
  auto_mute: 'mod_event.compact.muted',
  auto_delete: 'mod_event.compact.deleted',
  suspicious: 'mod_event.compact.suspicious',
  no_permissions: 'mod_event.compact.suspicious',
  global_ban: 'mod_event.compact.global_ban',
  voting: 'mod_event.compact.voting',
  override: 'mod_event.compact.override',
  // Admin-triggered moderation (Plan 6). The compact line uses its own
  // locale keys so translators can tweak the wording ("отримує банан"
  // vs. "спам"). Rendering chrome (undo / hide buttons) is shared with
  // auto_ban / auto_mute below.
  manual_ban: 'mod_event.compact.manual_ban',
  manual_mute: 'mod_event.compact.manual_mute',
  manual_kick: 'mod_event.compact.manual_kick',
  // Captcha-gate states. The pending line is the only one rendered by
  // `mod-event-send`; passed/failed are written by `captcha-flow.applyPass`
  // / `applyFail` directly via editHTML so the keys live alongside the
  // captcha namespace, not under mod_event.compact.*. We still keep the
  // pending_captcha → captcha.compact.pending mapping here so a stray
  // re-render (e.g. `mod.event:less`) finds the right key.
  pending_captcha: 'captcha.compact.pending',
  captcha_passed: 'captcha.compact.passed',
  captcha_failed: 'captcha.compact.failed'
}

// Derive the name we plug into the compact line. For override events the
// compact template takes {admin} instead of {name}, so we route through a
// different template variable.
const buildCompactText = (i18n, event, target) => {
  const key = COMPACT_KEY_BY_ACTION[event.actionType]
  if (!key) {
    return { text: usernameLabel(target), compactLine: usernameLabel(target) }
  }
  const name = usernameLabel(target || {
    id: event.targetId,
    first_name: event.targetName,
    username: event.targetUsername,
    title: event.targetTitle
  })
  const adminLabel = event.actorName || event.actorId
    ? usernameLabel({ first_name: event.actorName, id: event.actorId })
    : ''
  let params
  if (event.actionType === 'override') {
    params = { admin: adminLabel }
  } else if (event.actionType === 'manual_ban' || event.actionType === 'manual_mute' || event.actionType === 'manual_kick') {
    // Manual actions name the admin who pressed the button — an unsigned
    // "X отримує банан" reads like it happened on its own.
    params = { name, admin: adminLabel }
  } else {
    params = { name }
  }
  const line = i18n.t(key, params)
  return { text: line, compactLine: line }
}

// Expanded = compact line + (optional) confidence/reason + (optional)
// preview + (optional) warning, blank-line-separated.
const buildExpandedText = (i18n, event, target) => {
  const { compactLine } = buildCompactText(i18n, event, target)
  const lines = [compactLine]

  const conf = formatConfidence(event.confidence)
  const reason = event.reason ? resolveReason(i18n, event.reason) : null
  if (conf || reason) {
    // Spec: "📊 87% · 🤖 {short reason}" — compose whichever parts we have.
    if (conf && reason) {
      lines.push('', i18n.t('mod_event.expanded.confidence_line', {
        confidence: Math.round(Number(event.confidence)),
        reason
      }))
    } else if (conf) {
      lines.push('', conf)
    } else {
      lines.push('', `🤖 ${reason}`)
    }
  }

  if (event.messagePreview) {
    const preview = escapeHtml(event.messagePreview).slice(0, 200)
    lines.push(i18n.t('mod_event.expanded.preview_line', { preview }))
  }

  if (event.warning) {
    lines.push(i18n.t('mod_event.expanded.warning_line', {
      warning: escapeHtml(event.warning)
    }))
  }

  return lines.join('\n')
}

// Look up the reason code in the mod_event.reason.* table, falling back to
// the raw text if nothing matches (covers ad-hoc reason strings from the
// LLM pipeline without requiring an entry per sentence).
const resolveReason = (i18n, reason) => {
  if (!reason) return i18n.t('mod_event.reason.default')
  const key = `mod_event.reason.${reason}`
  const resolved = i18n.t(key)
  if (resolved && resolved !== key) return resolved
  return reason
}

// Default (compact) keyboard: [🤨 За що?] + [✓ Сховати]. The hide button
// renders for everyone because Telegram inline-keyboards are per-message,
// not per-viewer; non-admin click is toast-rejected. Non-admins don't get
// the admin-only buttons on the expanded view instead (see builder below).
const buildCompactKeyboard = (i18n, event, opts = {}) => {
  const eventId = event.eventId
  const actionType = event.actionType

  // For no_permissions, the spec wants `[📖 Дай права]` + `[🤨 Що сталось?]`.
  // We render both; non-admin clickers on undo/hide are toast-rejected.
  if (actionType === 'no_permissions') {
    return {
      inline_keyboard: [
        row(
          btn(i18n.t('mod_event.btn.why_alt'), cb(SCREEN_ID, 'why', eventId)),
          btn(i18n.t('mod_event.btn.give_rights'), cb(SCREEN_ID, 'rights', eventId))
        ),
        row(btn(i18n.t('mod_event.btn.hide'), cb(SCREEN_ID, 'hide', eventId)))
      ]
    }
  }

  // Global-ban — spec wants an admin-only "trust anyway" button.
  if (actionType === 'global_ban') {
    return {
      inline_keyboard: [
        row(
          btn(i18n.t('mod_event.btn.why'), cb(SCREEN_ID, 'why', eventId)),
          btn(i18n.t('mod_event.btn.trust_anyway'), cb(SCREEN_ID, 'undo', eventId))
        ),
        row(btn(i18n.t('mod_event.btn.hide'), cb(SCREEN_ID, 'hide', eventId)))
      ]
    }
  }

  // Override / voting don't carry the why/hide row — they're terminal
  // (override) or routed through legacy sv:* buttons (voting).
  if (actionType === 'override') return { inline_keyboard: [] }

  // Admin-triggered mod actions (Plan 6 §7): single `[↩️ Скасувати]`.
  // No why/hide — the admin knows why they banned. Undo routes through
  // the same handler as auto_* (restrictChatMember + unban).
  if (actionType === 'manual_ban' || actionType === 'manual_mute' || actionType === 'manual_kick') {
    return {
      inline_keyboard: [
        row(btn(i18n.t('mod_event.btn.undo_short'), cb(SCREEN_ID, 'undo', eventId)))
      ]
    }
  }

  // Default: bans / mutes / deletes / suspicious.
  return {
    inline_keyboard: [
      row(
        btn(i18n.t('mod_event.btn.why'), cb(SCREEN_ID, 'why', eventId)),
        btn(i18n.t('mod_event.btn.hide'), cb(SCREEN_ID, 'hide', eventId))
      )
    ]
  }
}

const buildExpandedKeyboard = (i18n, event, opts = {}) => {
  const eventId = event.eventId
  const isAdmin = Boolean(opts.isAdmin)
  const actionType = event.actionType

  const lessBtn = btn(i18n.t('mod_event.btn.less'), cb(SCREEN_ID, 'less', eventId))
  const undoBtn = btn(i18n.t('mod_event.btn.undo'), cb(SCREEN_ID, 'undo', eventId))
  const hideBtn = btn(i18n.t('mod_event.btn.hide'), cb(SCREEN_ID, 'hide', eventId))
  const giveRights = btn(i18n.t('mod_event.btn.give_rights'), cb(SCREEN_ID, 'rights', eventId))
  const trustAnyway = btn(i18n.t('mod_event.btn.trust_anyway'), cb(SCREEN_ID, 'undo', eventId))

  if (actionType === 'no_permissions') {
    // Non-admin: just [less]. Admin: [less] + [give rights] + [hide].
    const rows = isAdmin
      ? [row(lessBtn, giveRights), row(hideBtn)]
      : [row(lessBtn)]
    return { inline_keyboard: rows }
  }

  if (actionType === 'global_ban') {
    const rows = isAdmin
      ? [row(lessBtn, trustAnyway), row(hideBtn)]
      : [row(lessBtn)]
    return { inline_keyboard: rows }
  }

  if (actionType === 'override') return { inline_keyboard: [] }

  // Default auto-ban / mute / delete / suspicious: admin gets undo + hide,
  // non-admin just gets [less].
  const rows = isAdmin
    ? [row(lessBtn, undoBtn), row(hideBtn)]
    : [row(lessBtn)]
  return { inline_keyboard: rows }
}

// ---- DB helpers ---------------------------------------------------------

const createModEvent = async (db, fields) => {
  if (!db || !db.ModEvent) throw new Error('mod-event: db.ModEvent unavailable')
  const safe = fields && fields.confidence !== undefined
    ? { ...fields, confidence: roundConfidence(fields.confidence) }
    : fields
  return db.ModEvent.create(safe)
}

const getModEvent = async (db, eventId) => {
  if (!db || !db.ModEvent || !eventId) return null
  return db.ModEvent.findOne({ eventId })
}

const updateModEvent = async (db, eventId, patch) => {
  if (!db || !db.ModEvent || !eventId) return null
  return db.ModEvent.findOneAndUpdate({ eventId }, { $set: patch }, { new: true })
}

module.exports = {
  SCREEN_ID,
  escapeHtml,
  usernameLabel,
  roundConfidence,
  formatConfidence,
  resolveReason,
  buildCompactText,
  buildExpandedText,
  buildCompactKeyboard,
  buildExpandedKeyboard,
  createModEvent,
  getModEvent,
  updateModEvent,
  COMPACT_KEY_BY_ACTION
}
