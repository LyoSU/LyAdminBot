/**
 * View functions: (verdict, locale) → message text + typed button specs.
 * Pure — the app layer turns ButtonSpec into mtcute BotKeyboard.
 *
 * UX contract (user decisions, 2026):
 *  - compact by default: ONE line per moderation event
 *  - details live behind [Why?]; raw LLM prose never shown
 *  - settings panel only in PM; group /settings replies with a deep link
 */
import type { Verdict } from '@lyadmin/core'
import type { Locale } from './locale.js'
import { uk } from './locales/uk.js'
import { en } from './locales/en.js'
import { ru } from './locales/ru.js'
import { tr } from './locales/tr.js'
import { by } from './locales/by.js'

export const LOCALES: Record<string, Locale> = { uk, en, ru, tr, by }

export const resolveLocale = (code: string | null | undefined): Locale => {
  if (code && LOCALES[code]) return LOCALES[code]
  if (code?.startsWith('uk')) return uk
  if (code?.startsWith('ru')) return ru
  if (code?.startsWith('be') || code?.startsWith('by')) return by
  if (code?.startsWith('tr')) return tr
  return en
}

export interface ButtonSpec {
  text: string
  /** Callback payload, ≤64 bytes by Telegram rules. Mutually exclusive with url. */
  data?: string
  url?: string
}

export interface ViewMessage {
  text: string
  buttons: ButtonSpec[][]
}

// Callback-data builders — single source of truth for parsing too.
export const callbackData = {
  why: (chatId: number, messageId: number): string => `why:${chatId}:${messageId}`,
  override: (chatId: number, messageId: number, userId: number): string =>
    `ovr:${chatId}:${messageId}:${userId}`,
  // The panel lives in PM, so every button must say WHICH chat it edits.
  settings: (chatId: number, screen: string, value = ''): string =>
    `set:${chatId}:${screen}${value ? `:${value}` : ''}`,
  captcha: (chatId: number, userId: number): string => `cap:${chatId}:${userId}`,
  // Trust toggle on the /check card; flag = make-trusted (1) or untrust (0).
  trust: (chatId: number, userId: number, makeTrusted: boolean): string =>
    `tr:${chatId}:${userId}:${makeTrusted ? '1' : '0'}`,
  vote: (chatId: number, messageId: number, choice: 'spam' | 'ham'): string =>
    `vt:${chatId}:${messageId}:${choice === 'spam' ? 's' : 'h'}`,
  help: (): string => 'help',
  langPicker: (): string => 'lang',
  langSet: (code: string): string => `lang:${code}`
}

/** For app-layer strings that interpolate user-controlled text into HTML. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * PM welcome card. The add-to-group link pre-requests exactly the admin
 * rights the bot needs — one tap instead of a manual rights dance.
 */
export const startCard = (locale: Locale, name: string, botUsername: string): ViewMessage => ({
  text: locale.start.privateCard(escapeHtml(name)),
  buttons: [
    [{
      text: locale.start.addToGroupButton,
      url: `https://t.me/${botUsername}?startgroup=add&admin=delete_messages+restrict_members+ban_users`
    }],
    [
      { text: locale.start.helpButton, data: callbackData.help() },
      { text: locale.start.langButton, data: callbackData.langPicker() }
    ]
  ]
})

/** /start inside a group: one-line hint, no panel. */
export const startGroupHint = (locale: Locale): ViewMessage => ({
  text: locale.start.groupHint,
  buttons: [[{ text: locale.start.helpButton, data: callbackData.help() }]]
})

export const helpView = (locale: Locale): ViewMessage => ({
  text: locale.helpText,
  buttons: []
})

/** Language picker — plain language names, never flags. */
export const langPicker = (locale: Locale): ViewMessage => ({
  text: locale.lang.pickerTitle,
  buttons: [
    Object.entries(LOCALES).map(([code, l]) => ({
      text: l.languageName,
      data: callbackData.langSet(code)
    }))
  ]
})

export const parseCallback = (data: string): { kind: string; parts: string[] } => {
  const [kind = '', ...parts] = data.split(':')
  return { kind, parts }
}

/**
 * Deep link that opens the expanded "Why?" card in PM. The full explanation
 * (and admin override) lives in the bot DM, not in the group — so the group
 * notification stays a single ephemeral line that auto-deletes.
 */
export const whyDeepLink = (
  botUsername: string,
  chatId: number,
  messageId: number,
  userId: number
): string => `https://t.me/${botUsername}?start=why_${chatId}_${messageId}_${userId}`

/** One-line moderation notice posted after an enforcement action. */
export const compactNotification = (
  locale: Locale,
  verdict: Verdict,
  target: { chatId: number; messageId: number; userId: number; userLabel: string },
  options: { botUsername?: string | undefined } = {}
): ViewMessage => {
  const action = verdict.action
  if (action === 'none' || action === 'observe') {
    throw new Error('compactNotification is only for enforcement actions')
  }
  // With a known bot username the [Why?] button leaves the group entirely:
  // a t.me deep link opens the expanded card in PM. Without it (e.g. in unit
  // tests) it falls back to the in-group callback.
  const whyButton = options.botUsername
    ? { text: locale.notification.whyButton, url: whyDeepLink(options.botUsername, target.chatId, target.messageId, target.userId) }
    : { text: locale.notification.whyButton, data: callbackData.why(target.chatId, target.messageId) }
  return {
    text: locale.notification.compact(locale.actions[action], escapeHtml(target.userLabel)),
    buttons: [[
      whyButton,
      { text: locale.notification.notSpamButton, data: callbackData.override(target.chatId, target.messageId, target.userId) }
    ]]
  }
}

export interface WhyOptions {
  /**
   * Emit Telegram HTML (bold verdict, blockquote evidence, dim footer). The
   * PM card renders HTML; the in-group callback toast does not, so it leaves
   * this off and gets clean plain text.
   */
  html?: boolean
  /**
   * Append the technical footer (decidedBy · ruleId + raw signal codes).
   * Admins only — it is developer-facing noise for everyone else.
   */
  technical?: boolean
}

/**
 * Human "Why?" view. Built as a structured list, then rendered to plain text
 * (default, for the alert toast) or Telegram HTML (for the PM card). Raw
 * machine tokens — decidedBy, ruleId, signal names — only surface in the
 * admin-only technical footer; everyone else sees plain language. Unmapped
 * signals are dropped from the human list so no code ever leaks.
 */
export const whyView = (locale: Locale, verdict: Verdict, options: WhyOptions = {}): string => {
  const { html: asHtml = false, technical = false } = options
  const esc = asHtml ? escapeHtml : (s: string): string => s
  const b = asHtml ? (s: string): string => `<b>${s}</b>` : (s: string): string => s
  const dim = asHtml ? (s: string): string => `<i>${s}</i>` : (s: string): string => s

  const lines: string[] = []
  lines.push(b(esc(locale.why.title)))

  const pct = Math.round(verdict.pSpam * 100)
  const confidence = verdict.pSpam >= 0.85
    ? locale.why.confidence.high
    : verdict.pSpam >= 0.6
      ? locale.why.confidence.medium
      : locale.why.confidence.low
  lines.push('', b(esc(confidence(pct))))

  const reason = locale.reasons[verdict.reasonCode] ?? locale.reasonFallback
  lines.push(esc(locale.why.reasonLine(reason)))

  const suspicious = verdict.signals.filter((s) => !s.negative).map((s) => s.name)
  const humanized = suspicious
    .map((name) => locale.why.signalLabels[name])
    .filter((label): label is string => Boolean(label))
    .slice(0, 6)
  if (humanized.length > 0) {
    lines.push('', esc(locale.why.noticedTitle))
    for (const label of humanized) lines.push(`• ${esc(label)}`)
  }

  if (verdict.reasonEvidence) {
    const quote = esc(verdict.reasonEvidence.slice(0, 200))
    lines.push('', esc(locale.why.messageTitle))
    lines.push(asHtml ? `<blockquote>${quote}</blockquote>` : `"${quote}"`)
  }

  if (technical) {
    const decidedBy = locale.why.decidedBy[verdict.decidedBy] ?? verdict.decidedBy
    lines.push('', dim(esc(`${decidedBy}${verdict.ruleId ? ` · ${verdict.ruleId}` : ''}`)))
    if (suspicious.length > 0) lines.push(dim(esc(suspicious.slice(0, 8).join(', '))))
  }

  return lines.join('\n')
}

/**
 * Display-ready user facts for the profile card. Derived from a UserSnapshot
 * (+ external-ban merge) by the app layer — the ui never sees raw domain types.
 */
export interface UserFacts {
  userId: number
  username: string | null
  /** Account age estimated from the id, in days. Null — unknown. */
  predictedAgeDays: number | null
  /** Days since we first saw the account locally. Null — never seen. */
  localAgeDays: number | null
  messagesGlobal: number
  groupsActive: number
  reputationStatus: 'restricted' | 'suspicious' | 'neutral' | 'trusted'
  premium: boolean
  externalBan: { banned: boolean; bannedAtDaysAgo: number | null; offenses: number } | null
  joinedAgoSeconds: number | null
  promoInBio: boolean
  personalChannel: boolean
}

/** Compact relative span ("щойно", "5хв", "3д", "2міс", "1р") from seconds. */
const humanSpan = (locale: Locale, totalSeconds: number): string => {
  const u = locale.profile.units
  if (totalSeconds < 60) return u.now
  const minutes = totalSeconds / 60
  const hours = minutes / 60
  const days = hours / 24
  if (days >= 365) return `${Math.round(days / 365)}${u.y}`
  if (days >= 30) return `${Math.round(days / 30)}${u.mo}`
  if (days >= 1) return `${Math.round(days)}${u.d}`
  if (hours >= 1) return `${Math.round(hours)}${u.h}`
  return `${Math.round(minutes)}${u.m}`
}

/**
 * User profile card (LolsBot-inspired, built only from data a bot can see).
 * Rendered as plain text by default; pass `{ html: true }` for the PM surfaces.
 * Returns an array of lines so callers can embed it inside a larger card.
 */
export const userProfileLines = (locale: Locale, facts: UserFacts, options: { html?: boolean } = {}): string[] => {
  const asHtml = options.html ?? false
  const b = asHtml ? (s: string): string => `<b>${s}</b>` : (s: string): string => s
  const code = asHtml ? (s: string): string => `<code>${s}</code>` : (s: string): string => s
  const p = locale.profile

  const lines: string[] = [b(p.title)]

  const idLine = `${code(String(facts.userId))}${facts.username ? ` · @${escapeHtml(facts.username)}` : ''}`
  lines.push(idLine)

  const age = facts.predictedAgeDays !== null ? `~${humanSpan(locale, facts.predictedAgeDays * 86400)}` : p.unknownAge
  const seen = facts.localAgeDays !== null ? humanSpan(locale, facts.localAgeDays * 86400) : p.neverSeen
  lines.push(`${p.accountAge(age)} · ${p.firstSeen(seen)}`)

  lines.push(p.activity(facts.messagesGlobal, facts.groupsActive))
  lines.push(`${p.reputation(locale.stats.repStatus[facts.reputationStatus])}${facts.premium ? ` · ${p.premium}` : ''}`)

  // Risk flags grouped under a blank line, so the "who" block reads apart
  // from the "what's wrong" block.
  const risk: string[] = []
  if (facts.externalBan?.banned) {
    const ago = facts.externalBan.bannedAtDaysAgo !== null
      ? humanSpan(locale, facts.externalBan.bannedAtDaysAgo * 86400)
      : ''
    risk.push(`🚫 ${p.externalBan(ago, facts.externalBan.offenses)}`)
  }
  if (facts.joinedAgoSeconds !== null) {
    risk.push(`🆕 ${p.justJoined(humanSpan(locale, facts.joinedAgoSeconds))}`)
  }
  const extras: string[] = []
  if (facts.promoInBio) extras.push(p.promoInBio)
  if (facts.personalChannel) extras.push(p.personalChannel)
  if (extras.length > 0) risk.push(`⚠️ ${extras.join(' · ')}`)

  if (risk.length > 0) lines.push('', ...risk)

  return lines
}

/**
 * Standalone profile card for /check. When `action` is supplied (admin caller)
 * the card carries a trust/untrust toggle button — button-driven moderation,
 * so no extra slash command is needed.
 */
export const userProfileCard = (
  locale: Locale,
  facts: UserFacts,
  action: { chatId: number; isTrusted: boolean } | null = null
): ViewMessage => ({
  text: userProfileLines(locale, facts, { html: true }).join('\n'),
  buttons: action
    ? [[{
        text: action.isTrusted ? locale.trust.untrustButton : locale.trust.button,
        data: callbackData.trust(action.chatId, facts.userId, !action.isTrusted)
      }]]
    : []
})

/**
 * Expanded "Why?" card for PM. Rendered as HTML; admins additionally get the
 * override button and the technical footer, since the group notification has
 * auto-deleted by the time they open this. When `facts` are supplied a compact
 * profile block is appended under the verdict.
 */
export const whyCard = (
  locale: Locale,
  verdict: Verdict,
  target: { chatId: number; messageId: number; userId: number },
  options: { canOverride: boolean; facts?: UserFacts | undefined }
): ViewMessage => {
  const body = whyView(locale, verdict, { html: true, technical: options.canOverride })
  const profile = options.facts ? `\n\n${userProfileLines(locale, options.facts, { html: true }).join('\n')}` : ''
  return {
    text: body + profile,
    buttons: options.canOverride
      ? [[{ text: locale.notification.notSpamButton, data: callbackData.override(target.chatId, target.messageId, target.userId) }]]
      : []
  }
}

const MEDALS = ['🥇', '🥈', '🥉']

/**
 * Group leaderboard for /top (by messages) and /top-banan (by banana count).
 * Top three get medals, the rest a plain rank. Names are attacker-controlled
 * → escaped here.
 */
export const topList = (
  locale: Locale,
  kind: 'messages' | 'banan',
  entries: { name: string; value: number }[]
): ViewMessage => {
  if (entries.length === 0) return { text: locale.top.empty, buttons: [] }
  const title = kind === 'banan' ? locale.top.titleBanan : locale.top.titleMessages
  const unit = kind === 'banan' ? locale.top.bananUnit : locale.top.messagesUnit
  const lines = entries.map((e, i) => {
    const badge = MEDALS[i] ?? `${i + 1}.`
    return `${badge} ${escapeHtml(e.name)} · ${e.value} ${unit(e.value)}`
  })
  return { text: [title, '', ...lines].join('\n'), buttons: [] }
}

/** Group /settings response: deep link to PM, never a panel in the chat. */
export const settingsDeepLink = (
  locale: Locale,
  botUsername: string,
  chatId: number
): ViewMessage => ({
  text: locale.settings.openInPm,
  buttons: [[{
    text: locale.settings.openInPmButton,
    // Deep link: open the settings panel for this specific chat in PM.
    url: `https://t.me/${botUsername}?start=settings_${chatId}`
  }]]
})

export interface SettingsState {
  enabled: boolean
  preset: 'soft' | 'standard' | 'strict'
  captchaEnabled: boolean
  votingEnabled: boolean
  /** External ban databases (lols/CAS) toggle. */
  externalBanEnabled: boolean
  /** Default /banan mute duration, in seconds. */
  bananDefaultSeconds: number
  /** Current group interface-language code (uk/en/ru/tr/by). */
  locale: string
}

const langName = (code: string): string => LOCALES[code]?.languageName ?? code

/** Preset mute durations (seconds) offered on the panel + their short labels. */
const BANAN_PRESETS = [300, 1800, 3600, 86400] as const
const bananLabel = (locale: Locale, seconds: number): string => {
  const u = locale.banan.units
  switch (seconds) {
    case 300: return `5${u.m}`
    case 1800: return `30${u.m}`
    case 3600: return `1${u.h}`
    case 86400: return `1${u.d}`
    default: return `${seconds}s`
  }
}

/** PM settings panel. Every button carries the target chatId. */
export const settingsPanel = (locale: Locale, chatId: number, state: SettingsState): ViewMessage => {
  const onOff = (v: boolean): string => (v ? locale.settings.on : locale.settings.off)
  const presetLabel = locale.settings.presets[state.preset]
  const mark = (preset: SettingsState['preset']): string =>
    state.preset === preset ? `· ${locale.settings.presets[preset]} ·` : locale.settings.presets[preset]

  const bananRow: ButtonSpec[] = BANAN_PRESETS.map((sec) => ({
    text: state.bananDefaultSeconds === sec ? `· ${bananLabel(locale, sec)} ·` : bananLabel(locale, sec),
    data: callbackData.settings(chatId, 'banan_default', String(sec))
  }))

  return {
    text: [
      locale.settings.title,
      '',
      `${locale.settings.enabled}: ${onOff(state.enabled)}`,
      `${locale.settings.preset}: ${presetLabel}`,
      `${locale.settings.captcha}: ${onOff(state.captchaEnabled)}`,
      `${locale.settings.voting}: ${onOff(state.votingEnabled)}`,
      `${locale.settings.banDatabase}: ${onOff(state.externalBanEnabled)}`,
      `${locale.settings.banan}: ${bananLabel(locale, state.bananDefaultSeconds)}`,
      `${locale.settings.language}: ${langName(state.locale)}`
    ].join('\n'),
    buttons: [
      [{ text: `${locale.settings.enabled}: ${onOff(state.enabled)}`, data: callbackData.settings(chatId, 'toggle_enabled') }],
      [
        { text: mark('soft'), data: callbackData.settings(chatId, 'preset', 'soft') },
        { text: mark('standard'), data: callbackData.settings(chatId, 'preset', 'standard') },
        { text: mark('strict'), data: callbackData.settings(chatId, 'preset', 'strict') }
      ],
      [{ text: `${locale.settings.captcha}: ${onOff(state.captchaEnabled)}`, data: callbackData.settings(chatId, 'toggle_captcha') }],
      [{ text: `${locale.settings.voting}: ${onOff(state.votingEnabled)}`, data: callbackData.settings(chatId, 'toggle_voting') }],
      [{ text: `${locale.settings.banDatabase}: ${onOff(state.externalBanEnabled)}`, data: callbackData.settings(chatId, 'toggle_bandb') }],
      bananRow,
      // Language lives behind its own screen to keep the root panel compact.
      [{ text: `🌐 ${locale.settings.language}: ${langName(state.locale)}`, data: callbackData.settings(chatId, 'lang_open') }]
    ]
  }
}

/** Language picker sub-screen, opened from the settings panel (edits in place). */
export const langPanel = (locale: Locale, chatId: number, currentLocale: string): ViewMessage => {
  const codes = Object.keys(LOCALES)
  const rows: ButtonSpec[][] = []
  for (let i = 0; i < codes.length; i += 2) {
    rows.push(codes.slice(i, i + 2).map((code) => ({
      text: currentLocale === code ? `· ${langName(code)} ·` : langName(code),
      data: callbackData.settings(chatId, 'lang', code)
    })))
  }
  rows.push([{ text: locale.settings.back, data: callbackData.settings(chatId, 'root') }])
  return {
    text: `🌐 <b>${locale.settings.language}</b>\n\n${langName(currentLocale)}`,
    buttons: rows
  }
}

/**
 * Community vote prompt. Counts live on the buttons; both the quoted text
 * and the user label are escaped here — they are attacker-controlled.
 */
export const votePrompt = (
  locale: Locale,
  target: { chatId: number; messageId: number; userLabel: string; textPreview: string },
  tally: { spam: number; ham: number; outcome: string }
): ViewMessage => ({
  text: locale.vote.prompt(escapeHtml(target.userLabel), escapeHtml(target.textPreview.slice(0, 200))),
  buttons: [[
    { text: locale.vote.spamButton(tally.spam), data: callbackData.vote(target.chatId, target.messageId, 'spam') },
    { text: locale.vote.hamButton(tally.ham), data: callbackData.vote(target.chatId, target.messageId, 'ham') }
  ]]
})

/**
 * Captcha gate prompt posted in the group. The target user proves liveness
 * with one tap; everyone else's taps are rejected by the handler.
 */
export const captchaPrompt = (
  locale: Locale,
  target: { chatId: number; userId: number; userLabel: string }
): ViewMessage => ({
  text: locale.captcha.prompt(escapeHtml(target.userLabel)),
  buttons: [[{
    text: locale.captcha.button,
    data: callbackData.captcha(target.chatId, target.userId)
  }]]
})
