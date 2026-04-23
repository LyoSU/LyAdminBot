// Deep-context expansion for active spam-vote notifications (§10).
//
// Triggered by `[🔍 Деталі]` in either an active vote or alongside the
// post-result keyboard. Edits the message in-place to show:
//   - Existing progress bar / compact line (preserved)
//   - 📊 87% · 🤖 {reason_label}
//   - 📝 «{preview}» (truncated 200ch)
//   - 🧮 Hash: {first 12 of fingerprint hash} (if present)
//   - ⚖️ Голоси: 🚫 {n} · ✅ {n}
//
// Voter-list inclusion: the SpamVote model exposes voters[] and we surface
// up to the top 3 (by weight) in the details block. Names are HTML-escaped.
//
// Collapse: the [🛡 Зменшити] button re-renders the original active-vote
// view. For a resolved vote (rare race: details opened just before the
// resolver edited the message) we leave the in-place expanded view; the
// existing post-result keyboard takes precedence on the next interaction.
//
// Access: 'public' for view (anyone in the group can see why the vote was
// raised). The vote buttons themselves keep their own per-vote eligibility
// gate from handlers/spam-vote.js.

const { registerMenu } = require('../registry')
const { cb, btn, row } = require('../keyboard')
const { editHTML } = require('../../reply-html')
const { humanizeReason } = require('../../spam-check')
const { escapeHtml } = require('../../mod-event')
const { truncate } = require('../../text-utils')
const { isAdmin } = require('../access')
const voteUI = require('../../vote-ui')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'mod.vote.details'

const formatVoterList = (voters, max = 3) => {
  if (!voters || voters.length === 0) return null
  // Sort by weight desc, votedAt asc — top contributors first.
  const sorted = [...voters].sort((a, b) => {
    if ((b.weight || 0) !== (a.weight || 0)) return (b.weight || 0) - (a.weight || 0)
    return new Date(a.votedAt || 0) - new Date(b.votedAt || 0)
  }).slice(0, max)
  return sorted.map(v => {
    const name = v.username
      ? `&#64;${escapeHtml(v.username)}`
      : escapeHtml(v.displayName || `id${v.userId}`)
    const tag = v.vote === 'spam' ? '🚫' : '✅'
    const w = v.weight && v.weight > 1 ? ` ×${v.weight}` : ''
    return `  ${tag} ${name}${w}`
  })
}

// Pure renderer — easy to unit-test without a Telegram context.
// `opts.viewerIsAdmin` gates the fingerprint hash line: exposing it to
// everyone hands spammers a "change this to dodge signature" hint.
const renderDetailsText = (i18n, spamVote, opts = {}) => {
  const lines = []

  // Reuse the progress block so the details view feels like an enrichment
  // of the active vote, not a replacement.
  lines.push(...voteUI.buildProgressLines({
    expiresAt: spamVote.expiresAt,
    voteTally: spamVote.voteTally,
    i18n
  }))
  lines.push('')

  // Compact voting line (matches mod_event.compact.voting style).
  const userName = spamVote.bannedUserUsername
    ? `&#64;${escapeHtml(spamVote.bannedUserUsername)}`
    : escapeHtml(spamVote.bannedUserName || `id${spamVote.bannedUserId}`)
  lines.push(i18n.t('mod_event.compact.voting', { name: userName }))
  lines.push('')

  // Confidence + reason
  const conf = spamVote.aiConfidence
  const reason = spamVote.aiReason ? humanizeReason(spamVote.aiReason, i18n) : null
  if (conf || reason) {
    const confidence = conf != null ? Math.round(Number(conf)) : null
    if (confidence != null && reason) {
      lines.push(i18n.t('mod_event.expanded.confidence_line', {
        confidence,
        reason: escapeHtml(reason)
      }))
    } else if (confidence != null) {
      lines.push(`📊 ${confidence}%`)
    } else if (reason) {
      lines.push(`🤖 ${escapeHtml(reason)}`)
    }
  }

  // Preview (sanitized truncation done at insert-time; here just truncate)
  if (spamVote.messagePreview) {
    const preview = truncate(escapeHtml(spamVote.messagePreview), 200)
    lines.push(i18n.t('mod_event.expanded.preview_line', { preview }))
  }

  // Fingerprint hash (first 12 chars, if present) — admin-only. A spammer
  // who sees the hash can trivially perturb their message to invalidate
  // the signature match; gating preserves that signal for reuse.
  if (spamVote.messageHash && opts.viewerIsAdmin) {
    const short = String(spamVote.messageHash).slice(0, 12)
    lines.push(i18n.t('spam_vote.details.hash', { hash: short }))
  }

  // Vote tally split (independent of progress bar — shows raw counts).
  const tally = spamVote.voteTally || {}
  lines.push(i18n.t('spam_vote.details.tally', {
    spam: Number(tally.spamWeighted || 0),
    clean: Number(tally.cleanWeighted || 0)
  }))

  // Top 3 voters (skip when none — keeps the line count predictable).
  const voterLines = formatVoterList(spamVote.voters)
  if (voterLines && voterLines.length > 0) {
    lines.push(i18n.t('spam_vote.details.top_voters'))
    lines.push(...voterLines)
  }

  return lines.join('\n')
}

// Build the keyboard for the details view. Vote buttons are preserved when
// the vote is still pending (and not yet expired); only the [🔍 Деталі]
// button is replaced with [🛡 Зменшити деталі]. For resolved votes, the
// keyboard has just the collapse button — the post-result actions are not
// re-rendered here (they're attached by showResultUI on resolution).
const buildKeyboard = (i18n, spamVote) => {
  const isPending = spamVote.result === 'pending' &&
    new Date(spamVote.expiresAt).getTime() > Date.now()
  const rows = []
  if (isPending) {
    const tally = spamVote.voteTally || {}
    const spamLabel = `${i18n.t('spam_vote.btn_spam')} · ${tally.spamCount || 0}`
    const cleanLabel = `${i18n.t('spam_vote.btn_clean')} · ${tally.cleanCount || 0}`
    rows.push([
      { text: spamLabel, callback_data: `sv:${spamVote.eventId}:spam` },
      { text: cleanLabel, callback_data: `sv:${spamVote.eventId}:clean` }
    ])
  }
  rows.push(row(
    btn(i18n.t('spam_vote.details.collapse'), cb(SCREEN_ID, 'less', spamVote.eventId))
  ))
  return { inline_keyboard: rows }
}

const findVote = async (ctx, eventId) => {
  if (!ctx.db || !ctx.db.SpamVote || !eventId) return null
  try {
    return await ctx.db.SpamVote.findOne({ eventId })
  } catch (err) {
    log.warn({ err: err.message, eventId }, 'mod.vote.details: findOne failed')
    return null
  }
}

const renderDetails = async (ctx, spamVote) => {
  const viewerIsAdmin = await isAdmin(ctx)
  const text = renderDetailsText(ctx.i18n, spamVote, { viewerIsAdmin })
  const keyboard = buildKeyboard(ctx.i18n, spamVote)
  await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
    reply_markup: keyboard
  })
}

const renderActiveVote = async (ctx, spamVote) => {
  // Re-render the active-vote view exactly as updateVoteUI would.
  await voteUI.updateVoteUI(ctx, spamVote)
}

const handle = async (ctx, action, args) => {
  const eventId = args && args[0]
  if (!eventId) {
    return { render: false, toast: 'spam_vote.cb.not_found' }
  }
  const spamVote = await findVote(ctx, eventId)
  if (!spamVote) {
    return { render: false, toast: 'spam_vote.cb.not_found' }
  }

  if (action === 'open') {
    try {
      await renderDetails(ctx, spamVote)
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.vote.details open: render failed')
      }
    }
    return { render: false, silent: true }
  }

  if (action === 'less') {
    try {
      await renderActiveVote(ctx, spamVote)
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.vote.details less: render failed')
      }
    }
    return { render: false, silent: true }
  }

  return { render: false, silent: true }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'public',
    // Router only renders for action === 'open'; we handle that ourselves
    // inside handle() so it can use the live spamVote document.
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  renderDetailsText,
  buildKeyboard,
  formatVoterList,
  handle
}
