// captcha.challenge — emoji-noun captcha picker.
//
// Two entry surfaces:
//   1. /start captcha_<challengeId> deep-link (handlers/start.js calls
//      `renderForChallenge` directly).
//   2. /start (PM) by a globally-banned user → handlers/start.js builds
//      an appeal Captcha row via captcha-flow.startGlobalBanAppeal and
//      then calls `renderForChallenge`.
//
// Callback shape:
//   m:v1:captcha.challenge:pick:<challengeId>:<emoji>
// Size budget: prefix 5 + screenId 17 + ":pick:" 6 + 12-hex challengeId
// + ":" + emoji (≤ 4 bytes for BMP+supplementary planes used in POOL) = 45
// bytes, well under the 64-byte ceiling.
//
// Access: 'public'. The challenger is identified by ctx.from.id and matched
// against captchaRow.userId inside the handler so a third party can't
// spoof a pass.

const { registerMenu } = require('../registry')
const { cb } = require('../keyboard')
const { replyHTML, editHTML } = require('../../reply-html')
const captchaFlow = require('../../captcha-flow')
const { notification: log } = require('../../logger')

const SCREEN_ID = 'captcha.challenge'

const buildPromptText = (ctx, captchaRow) => {
  const name = ctx.i18n.t(captchaRow.correctNameKey)
  return ctx.i18n.t('captcha.challenge.prompt', { name }) + '\n\n' +
    ctx.i18n.t('captcha.challenge.tries_left', { n: captchaRow.attemptsLeft })
}

// 2 rows × 3 columns, each cell = the emoji. We keep the emoji as the
// label so the user picks visually; the noun lives in the prompt text.
const buildKeyboard = (captchaRow) => {
  const opts = captchaRow.options || []
  const rows = []
  for (let i = 0; i < opts.length; i += 3) {
    rows.push(opts.slice(i, i + 3).map(opt => ({
      text: opt.emoji,
      callback_data: cb(SCREEN_ID, 'pick', captchaRow.challengeId, opt.emoji)
    })))
  }
  return { inline_keyboard: rows }
}

// Caller-facing helper for /start deep-links — renders the challenge as a
// fresh PM message (NOT an edit; ctx.callbackQuery doesn't exist on a
// /start command).
const renderForChallenge = async (ctx, captchaRow) => {
  if (!ctx || !captchaRow) return null
  const text = buildPromptText(ctx, captchaRow)
  const keyboard = buildKeyboard(captchaRow)
  return replyHTML(ctx, text, { reply_markup: keyboard })
}

const reRender = async (ctx, captchaRow) => {
  const text = buildPromptText(ctx, captchaRow)
  const keyboard = buildKeyboard(captchaRow)
  try {
    await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
      reply_markup: keyboard
    })
  } catch (err) {
    if (!/message is not modified/.test(err.message || '')) {
      log.warn({ err: err.message }, 'captcha screen: rerender failed')
    }
  }
}

const handlePick = async (ctx, args) => {
  const challengeId = args && args[0]
  const pickedEmoji = args && args[1]
  if (!challengeId || !pickedEmoji) {
    return { render: false, toast: 'captcha.toast.no_challenge' }
  }
  if (!ctx.db || !ctx.db.Captcha) {
    return { render: false, toast: 'captcha.toast.no_challenge' }
  }
  const captchaRow = await ctx.db.Captcha.findOne({ challengeId })
  if (!captchaRow) {
    return { render: false, toast: 'captcha.toast.expired' }
  }
  // The challenger must be the row owner. Drop foreign clicks silently.
  if (!ctx.from || ctx.from.id !== captchaRow.userId) {
    return { render: false, toast: 'captcha.toast.no_challenge' }
  }
  if (captchaRow.expiresAt && captchaRow.expiresAt.getTime() < Date.now()) {
    return { render: false, toast: 'captcha.toast.expired' }
  }

  const captcha = require('../../captcha')
  const verdict = captcha.verifyChallenge(captchaRow, pickedEmoji)

  const deps = {
    telegram: ctx.telegram,
    db: ctx.db,
    i18n: ctx.i18n,
    botInfo: ctx.botInfo
  }
  const passOpts = {
    userInfo: ctx.session && ctx.session.userInfo,
    senderInfo: ctx.from
  }

  if (verdict.ok) {
    const result = await captchaFlow.applyPass(deps, captchaRow, passOpts)
    const finalText = result && result.message
      ? result.message
      : ctx.i18n.t('captcha.appeal.passed')
    try {
      await editHTML(ctx, ctx.callbackQuery.message.message_id, finalText, {
        reply_markup: { inline_keyboard: [] }
      })
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message }, 'captcha screen: pass edit failed')
      }
    }
    return { render: false, silent: true }
  }

  // Wrong pick — either retry or terminal fail.
  if (verdict.attemptsLeft > 0) {
    try { await captchaRow.save() } catch (_e) { /* non-fatal */ }
    await reRender(ctx, captchaRow)
    return { render: false, toast: 'captcha.toast.wrong' }
  }

  const result = await captchaFlow.applyFail(deps, captchaRow, passOpts)
  const finalText = result && result.message
    ? result.message
    : ctx.i18n.t('captcha.appeal.failed')
  try {
    await editHTML(ctx, ctx.callbackQuery.message.message_id, finalText, {
      reply_markup: { inline_keyboard: [] }
    })
  } catch (err) {
    if (!/message is not modified/.test(err.message || '')) {
      log.warn({ err: err.message }, 'captcha screen: fail edit failed')
    }
  }
  return { render: false, toast: 'captcha.toast.wrong' }
}

const handle = async (ctx, action, args) => {
  if (action === 'pick') return handlePick(ctx, args)
  return { render: false, silent: true }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'public',
    // Router only invokes render() for `open` actions. We never use that;
    // /start deep-link handles initial render via renderForChallenge.
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  buildPromptText,
  buildKeyboard,
  renderForChallenge,
  handle
}
