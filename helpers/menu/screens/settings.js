// /settings — root panel + all subscreens.
//
// One file, many screens: settings.root, settings.antispam,
// settings.antispam.sensitivity, settings.antispam.rules,
// settings.antispam.trusted, settings.banDatabase, settings.banChannel,
// settings.lang, settings.reset.confirm.
//
// All read/write the same `ctx.group.info.settings` fields as the legacy
// `!spam`/`!banbase`/`!banChannel`/`!reset` handlers — by design: the legacy
// code paths continue to work, this is just a cleaner entry point.
//
// Conventions (do not deviate without updating the plan):
//   - Screen ids use DOT notation.
//   - Callback data goes through cb() — router checks the 64-byte limit.
//   - All user-facing text lives in menu.settings.* locale keys.
//   - HTML parse mode is assumed (router uses editHTML).
//   - `scheduleDeletion(... cmd_settings_idle)` is bumped on every render so
//     the panel auto-deletes 10min after the last interaction.

const { registerMenu, getMenu } = require('../registry')
const { cb, btn, row, backBtn, closeBtn, paginated, NOOP } = require('../keyboard')
const { startInputFlow } = require('../flows')
const { registerInputHandler } = require('../../../middlewares/pending-input')
const { replyHTML } = require('../../reply-html')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')
const { bar, truncate } = require('../../text-utils')
const { renderEmptyState } = require('../empty-state')
const { logModEvent } = require('../../mod-log')
const { bot: log } = require('../../logger')

// Best-effort audit helper — never await this in a way that surfaces errors
// to the caller. The ModLog write is orthogonal to the action's success.
const auditSettingsChange = (ctx, action) => {
  if (!ctx || !ctx.chat || !ctx.chat.id) return
  logModEvent(ctx.db, {
    chatId: ctx.chat.id,
    eventType: 'settings_change',
    actor: ctx.from,
    action
  }).catch(() => {})
}

// ----------------------------------------------------------------------------
// Shared constants / helpers
// ----------------------------------------------------------------------------

// All screen ids declared up-front so render functions can reference sibling
// screen ids without forward-declaration issues (const is not hoisted).
const ROOT_ID = 'settings.root'
const ANTISPAM_ID = 'settings.antispam'
const SENS_ID = 'settings.antispam.sensitivity'
const RULES_ID = 'settings.antispam.rules'
const TRUSTED_ID = 'settings.antispam.trusted'
const BAN_DB_ID = 'settings.banDatabase'
const BAN_CH_ID = 'settings.banChannel'
const LANG_ID = 'settings.lang'
const RESET_ID = 'settings.reset'
// Forward references — Plan-5 subscreens. Stringly to avoid circular requires.
const WELCOME_ID = 'settings.welcome'
const EXTRAS_ID = 'settings.extras'
const MODLOG_ID = 'settings.modlog'
const DIAG_ID = 'settings.diagnostics'

const LANGUAGES = [
  { code: 'uk', name: 'Українська' },
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'by', name: 'Беларуская' }
]

const languageName = (code) => {
  const match = LANGUAGES.find(l => l.code === code)
  return match ? match.name : (code || 'English')
}

const MIN_THRESHOLD = 50
const MAX_THRESHOLD = 95
const MAX_RULE_LEN = 200
const RULES_LIMIT = 50
const RULES_PER_PAGE = 5
const TRUSTED_PER_PAGE = 10

// Mirrors handlers/admin/spam-settings.js initializeSettings — defensive
// bootstrap for groups whose schema predates any of these fields.
const ensureSpamSettings = (ctx) => {
  if (!ctx.group.info.settings.openaiSpamCheck) {
    ctx.group.info.settings.openaiSpamCheck = {
      enabled: true,
      globalBan: true,
      confidenceThreshold: 70,
      customRules: [],
      trustedUsers: []
    }
  }
  const s = ctx.group.info.settings.openaiSpamCheck
  if (!s.trustedUsers) s.trustedUsers = []
  if (!s.customRules) s.customRules = []
  if (s.confidenceThreshold === undefined) s.confidenceThreshold = 70
  return s
}

// Persist the group doc after a callback mutation. Callbacks route through
// dataPersistence middleware, which usually covers this — but when the handler
// also triggers a side-effect like sending a document or spawning a
// force-reply, we call save() eagerly so the state is safe even if later code
// throws.
const saveGroup = async (ctx) => {
  if (!ctx.group || !ctx.group.info || typeof ctx.group.info.save !== 'function') return
  if (ctx.group.info.isSaving) return
  ctx.group.info.isSaving = true
  try { await ctx.group.info.save() } catch (err) {
    log.debug({ err: err.message }, 'settings: group save failed')
  } finally { ctx.group.info.isSaving = false }
}

const refreshDeletion = (ctx) => {
  if (!ctx.db || !ctx.chat || ctx.chat.type === 'private') return
  const msg = ctx.callbackQuery && ctx.callbackQuery.message
  if (!msg) return
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId: msg.message_id,
    delayMs: policy.cmd_settings_idle,
    source: 'cmd_settings_idle'
  }, ctx.telegram).catch(() => {})
}

const onOff = (ctx, value) => ctx.i18n.t(value
  ? 'menu.settings.common.on'
  : 'menu.settings.common.off')

// ----------------------------------------------------------------------------
// settings.root
// ----------------------------------------------------------------------------

const renderRoot = (ctx) => {
  const s = ctx.group && ctx.group.info && ctx.group.info.settings
  const spam = (s && s.openaiSpamCheck) || {}
  const welcome = (s && s.welcome) || {}

  const text = ctx.i18n.t('menu.settings.root.text', {
    antispamState: onOff(ctx, spam.enabled !== false),
    threshold: spam.confidenceThreshold || 70,
    welcomeState: onOff(ctx, welcome.enable === true),
    welcomeCount: (Array.isArray(welcome.texts) ? welcome.texts.length : 0) +
      (Array.isArray(welcome.gifs) ? welcome.gifs.length : 0),
    banDatabaseState: onOff(ctx, s && s.banDatabase !== false),
    banChannelState: onOff(ctx, s && s.banChannel === true),
    extrasCount: Array.isArray(s && s.extras) ? s.extras.length : 0,
    extrasMax: (s && s.maxExtra) || 3,
    language: languageName(s && s.locale)
  })

  const keyboard = {
    inline_keyboard: [
      row(
        btn(ctx.i18n.t('menu.settings.root.btn.antispam'), cb(ANTISPAM_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.root.btn.welcome'), cb(WELCOME_ID, 'open'))
      ),
      row(
        btn(ctx.i18n.t('menu.settings.root.btn.banDatabase'), cb(BAN_DB_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.root.btn.banChannel'), cb(BAN_CH_ID, 'open'))
      ),
      row(
        btn(ctx.i18n.t('menu.settings.root.btn.extras'), cb(EXTRAS_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.root.btn.lang'), cb(LANG_ID, 'open'))
      ),
      row(
        btn(ctx.i18n.t('menu.settings.root.btn.modlog'), cb(MODLOG_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.root.btn.diag'), cb(DIAG_ID, 'open'))
      ),
      row(
        btn(ctx.i18n.t('menu.settings.root.btn.export'), cb(ROOT_ID, 'export')),
        btn(ctx.i18n.t('menu.settings.root.btn.reset'), cb(RESET_ID, 'open'))
      ),
      row(closeBtn({ label: ctx.i18n.t('menu.settings.common.close') }))
    ]
  }

  return { text, keyboard }
}

// Send the JSON file the same way `!json` does, but adapted for callback
// context where ctx.message may not point to the original user command.
const sendSettingsJson = async (ctx) => {
  try {
    const json = JSON.stringify(ctx.group.info.settings, null, 2)
    const file = Buffer.from(json)
    await ctx.replyWithDocument({
      source: file,
      filename: `group.settings.${ctx.chat.id}.json`
    })
    return true
  } catch (err) {
    log.warn({ err: err.message, chatId: ctx.chat && ctx.chat.id }, 'settings: export json failed')
    return false
  }
}

const registerRoot = () => registerMenu({
  id: ROOT_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    return renderRoot(ctx)
  },
  handle: async (ctx, action, args) => {
    if (action === 'soon') {
      return { render: false, toast: 'menu.settings.soon' }
    }
    if (action === 'export') {
      const ok = await sendSettingsJson(ctx)
      return {
        render: false,
        toast: ok ? 'menu.settings.export.sent' : 'menu.settings.export.error'
      }
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// settings.antispam
// ----------------------------------------------------------------------------

const renderAntispam = (ctx) => {
  const s = ensureSpamSettings(ctx)
  const threshold = s.confidenceThreshold || 70
  // Map 50..95 → 0..100 for the bar so the whole range is visualized.
  const barPct = ((threshold - MIN_THRESHOLD) / (MAX_THRESHOLD - MIN_THRESHOLD)) * 100
  const text = ctx.i18n.t('menu.settings.antispam.text', {
    state: onOff(ctx, s.enabled !== false),
    globalBan: onOff(ctx, s.globalBan !== false),
    threshold,
    bar: bar(barPct, 12),
    rulesCount: (s.customRules || []).length,
    trustedCount: (s.trustedUsers || []).length
  })

  const enabled = s.enabled !== false
  const globalBan = s.globalBan !== false

  const keyboard = {
    inline_keyboard: [
      row(btn(
        ctx.i18n.t(enabled ? 'menu.settings.antispam.btn.disable' : 'menu.settings.antispam.btn.enable'),
        cb(ANTISPAM_ID, 'toggle')
      )),
      row(btn(
        ctx.i18n.t(globalBan ? 'menu.settings.antispam.btn.globalban_on' : 'menu.settings.antispam.btn.globalban_off'),
        cb(ANTISPAM_ID, 'globalban')
      )),
      row(btn(
        ctx.i18n.t('menu.settings.antispam.btn.sensitivity'),
        cb(SENS_ID, 'open')
      )),
      row(
        btn(ctx.i18n.t('menu.settings.antispam.btn.rules'), cb(RULES_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.antispam.btn.trusted'), cb(TRUSTED_ID, 'open'))
      ),
      row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const registerAntispam = () => registerMenu({
  id: ANTISPAM_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    return renderAntispam(ctx)
  },
  handle: async (ctx, action) => {
    const s = ensureSpamSettings(ctx)
    if (action === 'toggle') {
      s.enabled = s.enabled === false
      auditSettingsChange(ctx, `antispam.enabled → ${s.enabled}`)
      return 'render'
    }
    if (action === 'globalban') {
      s.globalBan = s.globalBan === false
      auditSettingsChange(ctx, `antispam.globalBan → ${s.globalBan}`)
      return 'render'
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// settings.antispam.sensitivity
// ----------------------------------------------------------------------------

const clampThreshold = (value) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 70
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, n))
}

const renderSensitivity = (ctx) => {
  const s = ensureSpamSettings(ctx)
  const value = clampThreshold(s.confidenceThreshold || 70)
  const barPct = ((value - MIN_THRESHOLD) / (MAX_THRESHOLD - MIN_THRESHOLD)) * 100
  const text = ctx.i18n.t('menu.settings.sensitivity.text', {
    value,
    bar: bar(barPct, 14)
  })
  const keyboard = {
    inline_keyboard: [
      row(
        btn('−5', cb(SENS_ID, 'delta', '-5')),
        btn('−1', cb(SENS_ID, 'delta', '-1')),
        btn(`${value}%`, NOOP),
        btn('+1', cb(SENS_ID, 'delta', '1')),
        btn('+5', cb(SENS_ID, 'delta', '5'))
      ),
      row(backBtn(ANTISPAM_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const registerSensitivity = () => registerMenu({
  id: SENS_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    return renderSensitivity(ctx)
  },
  handle: async (ctx, action, args) => {
    const s = ensureSpamSettings(ctx)
    if (action === 'delta') {
      const delta = parseInt(args[0], 10)
      if (!Number.isFinite(delta)) return { render: false }
      s.confidenceThreshold = clampThreshold((s.confidenceThreshold || 70) + delta)
      auditSettingsChange(ctx, `antispam.confidenceThreshold → ${s.confidenceThreshold}`)
      return 'render'
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// settings.antispam.rules
// ----------------------------------------------------------------------------

// Rules are strings "ALLOW: text" / "DENY: text" per the legacy schema.
const ruleType = (rule) => rule && rule.startsWith('ALLOW:') ? 'allow' : 'deny'
const ruleBody = (rule) => (rule || '').replace(/^(ALLOW|DENY):\s*/, '')

const renderRules = (ctx, state = {}) => {
  const s = ensureSpamSettings(ctx)
  const rules = s.customRules || []
  const page = Math.max(0, parseInt(state.page, 10) || 0)

  if (rules.length === 0) {
    // Use the shared renderEmptyState helper (§17) + append CTA/back rows.
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.empty_state.rules.title',
      descKey: 'menu.empty_state.rules.hint'
    })
    empty.keyboard.inline_keyboard.push(
      row(btn(ctx.i18n.t('menu.settings.rules.btn.add_first'), cb(RULES_ID, 'add', 'allow'))),
      row(backBtn(ANTISPAM_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    )
    return empty
  }

  // Build list of { rule, absoluteIndex } so delete buttons stay correct across pages.
  const items = rules.map((rule, idx) => ({ rule, idx }))
  const pag = paginated({ items, page, perPage: RULES_PER_PAGE, screenId: RULES_ID })

  const listLines = pag.pageItems.map(({ rule, idx }) => {
    const typeLabel = ruleType(rule) === 'allow'
      ? ctx.i18n.t('menu.settings.rules.type_allow')
      : ctx.i18n.t('menu.settings.rules.type_deny')
    const preview = truncate(ruleBody(rule), 40)
    return ctx.i18n.t('menu.settings.rules.item', {
      index: idx + 1,
      type: typeLabel,
      preview
    })
  }).join('\n')

  const text = ctx.i18n.t('menu.settings.rules.text', {
    total: rules.length,
    list: listLines
  })

  // One delete button per row alongside the rule — we inline them after the list.
  const deleteRow = pag.pageItems.map(({ idx }) => btn(
    `${idx + 1} ${ctx.i18n.t('menu.settings.rules.btn.remove')}`,
    cb(RULES_ID, 'del', String(idx))
  ))

  const kb = []
  // Chunk delete buttons into rows of 5 to stay compact
  for (let i = 0; i < deleteRow.length; i += 5) kb.push(deleteRow.slice(i, i + 5))
  if (pag.nav.length) kb.push(pag.nav)
  kb.push(row(
    btn(ctx.i18n.t('menu.settings.rules.btn.add_allow'), cb(RULES_ID, 'add', 'allow')),
    btn(ctx.i18n.t('menu.settings.rules.btn.add_deny'), cb(RULES_ID, 'add', 'deny'))
  ))
  kb.push(row(backBtn(ANTISPAM_ID, { label: ctx.i18n.t('menu.settings.common.back') })))

  return { text, keyboard: { inline_keyboard: kb } }
}

const registerRules = () => registerMenu({
  id: RULES_ID,
  access: 'group_admin',
  render: (ctx, state) => {
    refreshDeletion(ctx)
    return renderRules(ctx, state)
  },
  handle: async (ctx, action, args) => {
    const s = ensureSpamSettings(ctx)
    if (action === 'page') {
      return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
    }
    if (action === 'del') {
      const idx = parseInt(args[0], 10)
      if (Number.isFinite(idx) && idx >= 0 && idx < s.customRules.length) {
        s.customRules.splice(idx, 1)
        return { render: true, toast: 'menu.settings.rules.removed' }
      }
      return { render: false }
    }
    if (action === 'add') {
      if ((s.customRules || []).length >= RULES_LIMIT) {
        return { render: false, toast: 'menu.settings.rules.limit_reached' }
      }
      const mode = args[0] === 'deny' ? 'deny' : 'allow'
      const promptKey = mode === 'deny'
        ? 'menu.settings.rules.prompt_deny'
        : 'menu.settings.rules.prompt_allow'
      await startInputFlow(ctx, {
        type: `settings.rules.${mode}`,
        screen: RULES_ID,
        prompt: ctx.i18n.t(promptKey)
      })
      return { render: false, silent: true }
    }
    return { render: false }
  }
})

const handleRuleInput = (mode) => async (ctx, text) => {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed === '/cancel') {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.rules.cancelled'))
    return
  }
  if (trimmed.length > MAX_RULE_LEN) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.rules.too_long'))
    return
  }
  const s = ensureSpamSettings(ctx)
  if ((s.customRules || []).length >= RULES_LIMIT) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.rules.limit_reached'))
    return
  }
  const prefix = mode === 'deny' ? 'DENY: ' : 'ALLOW: '
  s.customRules.push(prefix + trimmed)
  await replyHTML(ctx, ctx.i18n.t('menu.settings.rules.added'))
}

// ----------------------------------------------------------------------------
// settings.antispam.trusted
// ----------------------------------------------------------------------------

const renderTrusted = (ctx, state = {}) => {
  const s = ensureSpamSettings(ctx)
  const trusted = s.trustedUsers || []
  const page = Math.max(0, parseInt(state.page, 10) || 0)

  if (trusted.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.empty_state.trusted.title',
      descKey: 'menu.empty_state.trusted.hint'
    })
    empty.keyboard.inline_keyboard.push(
      row(btn(ctx.i18n.t('menu.settings.trusted.btn.add_first'), cb(TRUSTED_ID, 'add'))),
      row(backBtn(ANTISPAM_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    )
    return empty
  }

  const items = trusted.map((id, idx) => ({ id, idx }))
  const pag = paginated({ items, page, perPage: TRUSTED_PER_PAGE, screenId: TRUSTED_ID })

  const listLines = pag.pageItems.map(({ id, idx }) =>
    ctx.i18n.t('menu.settings.trusted.item', {
      index: idx + 1,
      name: `<code>${id}</code>`
    })
  ).join('\n')

  const text = ctx.i18n.t('menu.settings.trusted.text', {
    total: trusted.length,
    list: listLines
  })

  const deleteRow = pag.pageItems.map(({ idx }) => btn(
    `${idx + 1} ${ctx.i18n.t('menu.settings.trusted.btn.remove')}`,
    cb(TRUSTED_ID, 'del', String(idx))
  ))
  const kb = []
  for (let i = 0; i < deleteRow.length; i += 5) kb.push(deleteRow.slice(i, i + 5))
  if (pag.nav.length) kb.push(pag.nav)
  kb.push(row(btn(ctx.i18n.t('menu.settings.trusted.btn.add'), cb(TRUSTED_ID, 'add'))))
  kb.push(row(backBtn(ANTISPAM_ID, { label: ctx.i18n.t('menu.settings.common.back') })))

  return { text, keyboard: { inline_keyboard: kb } }
}

const registerTrusted = () => registerMenu({
  id: TRUSTED_ID,
  access: 'group_admin',
  render: (ctx, state) => {
    refreshDeletion(ctx)
    return renderTrusted(ctx, state)
  },
  handle: async (ctx, action, args) => {
    const s = ensureSpamSettings(ctx)
    if (action === 'page') {
      return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
    }
    if (action === 'del') {
      const idx = parseInt(args[0], 10)
      if (Number.isFinite(idx) && idx >= 0 && idx < s.trustedUsers.length) {
        s.trustedUsers.splice(idx, 1)
        return { render: true, toast: 'menu.settings.trusted.removed' }
      }
      return { render: false }
    }
    if (action === 'add') {
      await startInputFlow(ctx, {
        type: 'settings.trusted.add',
        screen: TRUSTED_ID,
        prompt: ctx.i18n.t('menu.settings.trusted.prompt')
      })
      return { render: false, silent: true }
    }
    return { render: false }
  }
})

const handleTrustedInput = async (ctx, text) => {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed === '/cancel') {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.rules.cancelled'))
    return
  }

  let targetId = null
  if (/^\d+$/.test(trimmed)) {
    targetId = parseInt(trimmed, 10)
  } else if (trimmed.startsWith('@')) {
    const uname = trimmed.substring(1).toLowerCase()
    try {
      const user = await ctx.db.User.findOne({
        username: { $regex: new RegExp(`^${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      })
      if (user) targetId = user.telegram_id
    } catch (err) {
      // fallthrough: treat as not-found
    }
    if (!targetId) {
      await replyHTML(ctx, ctx.i18n.t('menu.settings.trusted.not_found'))
      return
    }
  } else {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.trusted.invalid'))
    return
  }

  const s = ensureSpamSettings(ctx)
  if (s.trustedUsers.includes(targetId)) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.trusted.already'))
    return
  }
  s.trustedUsers.push(targetId)
  await replyHTML(ctx, ctx.i18n.t('menu.settings.trusted.added'))
}

// ----------------------------------------------------------------------------
// settings.banDatabase / settings.banChannel
// ----------------------------------------------------------------------------

const renderToggleScreen = (ctx, opts) => {
  const { textKey, btnEnable, btnDisable, currentValue } = opts
  const text = ctx.i18n.t(textKey, { state: onOff(ctx, currentValue) })
  const keyboard = {
    inline_keyboard: [
      row(btn(
        ctx.i18n.t(currentValue ? btnDisable : btnEnable),
        cb(opts.screenId, 'toggle')
      )),
      row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const registerBanDatabase = () => registerMenu({
  id: BAN_DB_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    // banDatabase default in schema is true; mirror ban-database handler semantics.
    const current = ctx.group.info.settings.banDatabase !== false
    return renderToggleScreen(ctx, {
      screenId: BAN_DB_ID,
      textKey: 'menu.settings.banDatabase.text',
      btnEnable: 'menu.settings.banDatabase.btn.enable',
      btnDisable: 'menu.settings.banDatabase.btn.disable',
      currentValue: current
    })
  },
  handle: async (ctx, action) => {
    if (action === 'toggle') {
      ctx.group.info.settings.banDatabase = ctx.group.info.settings.banDatabase === false
      auditSettingsChange(ctx, `banDatabase → ${ctx.group.info.settings.banDatabase}`)
      return 'render'
    }
    return { render: false }
  }
})

const registerBanChannel = () => registerMenu({
  id: BAN_CH_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    // banChannel default is false; explicit true check mirrors all-chanell-ban.js.
    const current = ctx.group.info.settings.banChannel === true
    return renderToggleScreen(ctx, {
      screenId: BAN_CH_ID,
      textKey: 'menu.settings.banChannel.text',
      btnEnable: 'menu.settings.banChannel.btn.enable',
      btnDisable: 'menu.settings.banChannel.btn.disable',
      currentValue: current
    })
  },
  handle: async (ctx, action) => {
    if (action === 'toggle') {
      ctx.group.info.settings.banChannel = ctx.group.info.settings.banChannel !== true
      auditSettingsChange(ctx, `banChannel → ${ctx.group.info.settings.banChannel}`)
      return 'render'
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// settings.lang
// ----------------------------------------------------------------------------

const renderLang = (ctx) => {
  const current = (ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.locale) ||
    (ctx.i18n && ctx.i18n.locale()) || 'en'

  const text = ctx.i18n.t('menu.settings.lang.text', {
    current: languageName(current)
  })

  const marker = ctx.i18n.t('menu.settings.lang.active_marker')
  const buttons = LANGUAGES.map(({ code, name }) => row(btn(
    (code === current ? marker : '') + name,
    cb(LANG_ID, 'set', code)
  )))
  buttons.push(row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') })))

  return { text, keyboard: { inline_keyboard: buttons } }
}

const registerLang = () => registerMenu({
  id: LANG_ID,
  access: 'group_admin',
  render: (ctx) => {
    refreshDeletion(ctx)
    return renderLang(ctx)
  },
  handle: async (ctx, action, args) => {
    if (action === 'set') {
      const code = args[0]
      if (LANGUAGES.some(l => l.code === code)) {
        ctx.group.info.settings.locale = code
        if (ctx.i18n && typeof ctx.i18n.locale === 'function') {
          try { ctx.i18n.locale(code) } catch { /* ignore */ }
        }
        auditSettingsChange(ctx, `locale → ${code}`)
        return { render: true, toast: 'menu.settings.lang.saved' }
      }
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// settings.reset (confirm)
// ----------------------------------------------------------------------------

const renderReset = (ctx) => {
  const text = ctx.i18n.t('menu.settings.reset.text')
  const keyboard = {
    inline_keyboard: [
      row(
        btn(ctx.i18n.t('menu.settings.reset.btn.confirm'), cb(RESET_ID, 'do')),
        backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') })
      )
    ]
  }
  return { text, keyboard }
}

const registerReset = () => registerMenu({
  id: RESET_ID,
  access: 'group_admin',
  render: (ctx) => {
    // Confirm screen uses the shorter TTL per cleanup-policy.
    if (ctx.db && ctx.chat && ctx.chat.type !== 'private') {
      const msg = ctx.callbackQuery && ctx.callbackQuery.message
      if (msg) {
        scheduleDeletion(ctx.db, {
          chatId: ctx.chat.id,
          messageId: msg.message_id,
          delayMs: policy.confirm_screen,
          source: 'settings_reset_confirm'
        }, ctx.telegram).catch(() => {})
      }
    }
    return renderReset(ctx)
  },
  handle: async (ctx, action) => {
    if (action === 'do') {
      // Mirror handlers/admin/reset.js: replace settings with a fresh Group() default.
      try {
        ctx.group.info.settings = new ctx.db.Group().settings
        await saveGroup(ctx)
      } catch (err) {
        log.warn({ err: err.message }, 'settings: reset failed')
        return { render: false, toast: 'menu.error' }
      }
      // Navigate back to root (which will re-render with defaults).
      const root = getMenu(ROOT_ID)
      if (root) {
        const view = await root.render(ctx, {})
        const { editHTML } = require('../../reply-html')
        try {
          await editHTML(ctx, ctx.callbackQuery.message.message_id, view.text, {
            reply_markup: view.keyboard
          })
        } catch { /* ignore "not modified" / race */ }
      }
      return { render: false, toast: 'menu.settings.reset.done' }
    }
    return { render: false }
  }
})

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------

let inputHandlersRegistered = false
const registerInputHandlers = () => {
  if (inputHandlersRegistered) return
  inputHandlersRegistered = true
  registerInputHandler('settings.rules.allow', handleRuleInput('allow'))
  registerInputHandler('settings.rules.deny', handleRuleInput('deny'))
  registerInputHandler('settings.trusted.add', handleTrustedInput)
}

const register = () => {
  registerRoot()
  registerAntispam()
  registerSensitivity()
  registerRules()
  registerTrusted()
  registerBanDatabase()
  registerBanChannel()
  registerLang()
  registerReset()
  registerInputHandlers()
}

module.exports = {
  register,
  // Screen ids for deep-linking / tests.
  SCREEN_IDS: {
    root: ROOT_ID,
    antispam: ANTISPAM_ID,
    sensitivity: SENS_ID,
    rules: RULES_ID,
    trusted: TRUSTED_ID,
    banDatabase: BAN_DB_ID,
    banChannel: BAN_CH_ID,
    lang: LANG_ID,
    reset: RESET_ID
  },
  // Exposed for tests.
  LANGUAGES,
  languageName,
  clampThreshold,
  ruleType,
  ruleBody,
  renderRoot,
  renderAntispam,
  renderSensitivity,
  renderRules,
  renderTrusted,
  renderLang,
  renderReset,
  handleRuleInput,
  handleTrustedInput
}
