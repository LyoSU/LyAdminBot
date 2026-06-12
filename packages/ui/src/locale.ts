/**
 * Locale contract. uk and en are hand-written reference locales;
 * other languages derive from them (post-v1).
 *
 * UX rules baked into the type system:
 *  - reason CODES are localized here; raw LLM text never reaches users
 *  - no country flags anywhere (language names are plain text)
 */
import type { VerdictAction } from '@lyadmin/core'

export interface Locale {
  /** Language name in its own language, NO flag emoji. */
  languageName: string

  start: {
    /** PM welcome card (HTML). `name` arrives pre-escaped. */
    privateCard: (name: string) => string
    /** One-line hint when /start is used inside a group (HTML). */
    groupHint: string
    addToGroupButton: string
    helpButton: string
    langButton: string
  }

  /** /help — full command reference (HTML). */
  helpText: string

  lang: {
    pickerTitle: string
    saved: string
  }

  actions: Record<Exclude<VerdictAction, 'none' | 'observe'>, string>

  /** One-line compact moderation notice: {action} {user}. */
  notification: {
    compact: (action: string, userLabel: string) => string
    whyButton: string
    notSpamButton: string
    overrideDone: string
    overrideAlreadyDone: string
    adminOnly: string
    /** Posted when the bot caught spam but lacks the rights to act. */
    missingRights: string
  }

  reasons: Record<string, string>
  reasonFallback: string

  why: {
    title: string
    probability: (percent: number) => string
    decidedBy: Record<string, string>
    evidenceTitle: string
    signalsTitle: string
    expired: string
  }

  /** Community vote on a reported / grey-zone message. */
  vote: {
    /** Prompt above the quoted text (HTML). Inputs arrive pre-escaped. */
    prompt: (userLabel: string, textPreview: string) => string
    spamButton: (count: number) => string
    hamButton: (count: number) => string
    counted: string
    resolvedSpam: string
    resolvedHam: string
    alreadyEnded: string
  }

  /** Report command feedback. */
  report: {
    needReply: string
    cantReportAdmin: string
    rateLimited: string
    accepted: string
  }

  /** /mystats personal panel (PM only). */
  stats: {
    title: string
    inChat: (count: number) => string
    global: (count: number) => string
    reputation: (score: number, status: string) => string
    repStatus: Record<'trusted' | 'neutral' | 'suspicious' | 'restricted', string>
    bananCaught: (count: number) => string
    openInPm: string
    openButton: string
  }

  /** /top and /top-banan group leaderboards. */
  top: {
    titleMessages: string
    titleBanan: string
    empty: string
    messagesUnit: (count: number) => string
    bananUnit: (count: number) => string
  }

  /** Welcome greetings for new members (off by default). */
  welcome: {
    enabled: string
    disabled: string
    textSet: string
    gifSet: string
    usage: string
    /** Default greeting if an admin enables welcome without setting text. */
    defaultGreeting: (name: string) => string
  }

  /** Custom hashtag triggers (extras). */
  extra: {
    saved: (name: string) => string
    deleted: (name: string) => string
    notFound: (name: string) => string
    usage: string
    listTitle: string
    listEmpty: string
  }

  /** Manual /banan moderation (admin mute with personality). */
  banan: {
    /** "name muted for duration". Inputs arrive pre-escaped. */
    success: (name: string, duration: string) => string
    lifted: (name: string) => string
    self: (name: string, duration: string) => string
    needReply: string
    undoButton: string
    units: { m: string; h: string; d: string }
  }

  /** Captcha gate for suspicious newcomers. */
  captcha: {
    /** Group prompt (HTML). `name` arrives pre-escaped. */
    prompt: (name: string) => string
    button: string
    passed: string
    notForYou: string
  }

  settings: {
    openInPm: string
    openInPmButton: string
    title: string
    preset: string
    presets: { soft: string; standard: string; strict: string }
    captcha: string
    voting: string
    enabled: string
    on: string
    off: string
    back: string
  }
}
