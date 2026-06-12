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

export const LOCALES: Record<string, Locale> = { uk, en }

export const resolveLocale = (code: string | null | undefined): Locale =>
  (code && LOCALES[code]) || (code?.startsWith('uk') ? uk : en)

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
  vote: (chatId: number, messageId: number, choice: 'spam' | 'ham'): string =>
    `vt:${chatId}:${messageId}:${choice === 'spam' ? 's' : 'h'}`,
  help: (): string => 'help',
  langPicker: (): string => 'lang',
  langSet: (code: string): string => `lang:${code}`
}

const escapeHtml = (s: string): string =>
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

/** One-line moderation notice posted after an enforcement action. */
export const compactNotification = (
  locale: Locale,
  verdict: Verdict,
  target: { chatId: number; messageId: number; userId: number; userLabel: string }
): ViewMessage => {
  const action = verdict.action
  if (action === 'none' || action === 'observe') {
    throw new Error('compactNotification is only for enforcement actions')
  }
  return {
    text: locale.notification.compact(locale.actions[action], escapeHtml(target.userLabel)),
    buttons: [[
      { text: locale.notification.whyButton, data: callbackData.why(target.chatId, target.messageId) },
      { text: locale.notification.notSpamButton, data: callbackData.override(target.chatId, target.messageId, target.userId) }
    ]]
  }
}

/** Expanded "Why?" view. Alert-sized: keep it terse. */
export const whyView = (locale: Locale, verdict: Verdict): string => {
  const lines: string[] = []
  const reason = locale.reasons[verdict.reasonCode] ?? locale.reasonFallback
  lines.push(`${locale.why.title}: ${reason}`)
  lines.push(locale.why.probability(Math.round(verdict.pSpam * 100)))
  const decidedBy = locale.why.decidedBy[verdict.decidedBy] ?? verdict.decidedBy
  lines.push(`· ${decidedBy}${verdict.ruleId ? ` (${verdict.ruleId})` : ''}`)
  if (verdict.reasonEvidence) {
    lines.push(`${locale.why.evidenceTitle}: "${verdict.reasonEvidence.slice(0, 120)}"`)
  }
  const suspicious = verdict.signals.filter((s) => !s.negative).map((s) => s.name)
  if (suspicious.length > 0) {
    lines.push(`${locale.why.signalsTitle}: ${suspicious.slice(0, 6).join(', ')}`)
  }
  return lines.join('\n')
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
}

/** PM settings panel. Every button carries the target chatId. */
export const settingsPanel = (locale: Locale, chatId: number, state: SettingsState): ViewMessage => {
  const onOff = (v: boolean): string => (v ? locale.settings.on : locale.settings.off)
  const presetLabel = locale.settings.presets[state.preset]
  const mark = (preset: SettingsState['preset']): string =>
    state.preset === preset ? `· ${locale.settings.presets[preset]} ·` : locale.settings.presets[preset]
  return {
    text: [
      locale.settings.title,
      '',
      `${locale.settings.enabled}: ${onOff(state.enabled)}`,
      `${locale.settings.preset}: ${presetLabel}`,
      `${locale.settings.captcha}: ${onOff(state.captchaEnabled)}`,
      `${locale.settings.voting}: ${onOff(state.votingEnabled)}`
    ].join('\n'),
    buttons: [
      [{ text: `${locale.settings.enabled}: ${onOff(state.enabled)}`, data: callbackData.settings(chatId, 'toggle_enabled') }],
      [
        { text: mark('soft'), data: callbackData.settings(chatId, 'preset', 'soft') },
        { text: mark('standard'), data: callbackData.settings(chatId, 'preset', 'standard') },
        { text: mark('strict'), data: callbackData.settings(chatId, 'preset', 'strict') }
      ],
      [{ text: `${locale.settings.captcha}: ${onOff(state.captchaEnabled)}`, data: callbackData.settings(chatId, 'toggle_captcha') }],
      [{ text: `${locale.settings.voting}: ${onOff(state.votingEnabled)}`, data: callbackData.settings(chatId, 'toggle_voting') }]
    ]
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
