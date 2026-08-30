/**
 * View functions: (verdict, locale) → message text + typed button specs.
 * Pure — the app layer turns ButtonSpec into mtcute BotKeyboard.
 *
 * UX contract (user decisions, 2026):
 *  - compact by default: ONE line per moderation event
 *  - details live behind [Why?]; raw LLM prose never shown
 *  - settings panel only in PM; group /settings replies with a deep link
 */
import type { BotStats, ChatStats, MediaCategory, Verdict, VoterEntry, VoterRoster } from '@lyadmin/core'
import { isSuspicionSignal, redactLinks, truncate, ESTABLISHED_MIN_TENURE_DAYS } from '@lyadmin/core'
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
  /** Roster of a resolved question, whispered to whoever asks. */
  voters: (chatId: number, messageId: number): string => `vrs:${chatId}:${messageId}`,
  /** Live profile card for a user, opened from the "Why?" card. Admins only. */
  profile: (chatId: number, userId: number): string => `prof:${chatId}:${userId}`,
  help: (): string => 'help',
  /** The effectiveness card, opened from the welcome card. */
  stats: (): string => 'stats',
  langPicker: (): string => 'lang',
  langSet: (code: string): string => `lang:${code}`,
  // PM welcome/extras editor. Content (text) never travels in callback data —
  // it is captured via a pending-input prompt — so only chatId + action +
  // numeric index/page appear here, well within Telegram's 64-byte cap.
  welcome: (chatId: number, action: string, arg = ''): string =>
    `wel:${chatId}:${action}${arg !== '' ? `:${arg}` : ''}`,
  extras: (chatId: number, action: string, arg = ''): string =>
    `ext:${chatId}:${action}${arg !== '' ? `:${arg}` : ''}`
}

/** For app-layer strings that interpolate user-controlled text into HTML. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The person, as a tappable name.
 *
 * Every notice this bot writes names somebody, and until now none of those names
 * went anywhere: an admin reading "muted · Іра" in a chat of four hundred had no
 * route from the notice to the profile, and two people called Іра made the
 * notice ambiguous rather than merely inconvenient. `tg://user?id=` is the only
 * form that works for an account with no username, which is most of what this
 * bot is about.
 *
 * mtcute turns this into `messageEntityMentionName` and resolves it against the
 * peer cache at send time. Where that fails it logs a warning and leaves an
 * entity the server will reject, so the app layer retries the send with mentions
 * flattened — see `stripMentions` there. Everybody named here has just spoken or
 * just tapped in the chat being written to, so the cache hit is the normal case
 * and the retry is the seatbelt.
 *
 * A non-positive or unsafe id yields the plain escaped label rather than a link
 * to user zero.
 */
export const userMention = (userId: number | null | undefined, label: string): string =>
  typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0
    ? `<a href="tg://user?id=${userId}">${escapeHtml(label)}</a>`
    : escapeHtml(label)

/** True when the verdict says the display name is itself the advertisement. */
export const nameIsPromo = (verdict: Verdict): boolean =>
  verdict.signals.some((sig) => sig.name === 'promo_in_name')

/**
 * The subject of a moderation notice, named as safely as the notice allows.
 *
 * Escaping was never the whole job. `promo_in_name` fires on accounts whose
 * display name is bought ad space, and every notice about one reprinted that
 * name verbatim — so the moment names became tappable, the notice announcing
 * the advert became a link into the advertiser. A neutral id keeps the notice
 * navigable while carrying nothing.
 *
 * The mention still points at the real account: the id is what the link needs,
 * and the id is not the advert.
 */
export const subjectMention = (
  locale: Locale,
  userId: number | null | undefined,
  label: string,
  promoName = false
): string => promoName && typeof userId === 'number'
  ? userMention(userId, locale.hiddenName(userId))
  : userMention(userId, label)

/**
 * PM welcome card. The add-to-group link pre-requests exactly the admin
 * rights the bot needs — one tap instead of a manual rights dance.
 */
export const startCard = (
  locale: Locale, name: string, botUsername: string, stats: BotStats | null = null
): ViewMessage => ({
  text: [
    locale.start.privateCard(escapeHtml(name)),
    // The one checkable sentence on the card. Dropped whole when the counts
    // could not be read: a claim we cannot back beats one we invent.
    ...(hasCountableWork(stats) ? ['', locale.start.liveProof(stats.chats, stats.spammers, stats.windowDays)] : [])
  ].join('\n'),
  buttons: [
    [{
      text: locale.start.addToGroupButton,
      url: `https://t.me/${botUsername}?startgroup=add&admin=delete_messages+restrict_members+ban_users`
    }],
    [{ text: locale.botStats.button, data: callbackData.stats() }],
    [
      { text: locale.start.helpButton, data: callbackData.help() },
      { text: locale.start.langButton, data: callbackData.langPicker() }
    ]
  ]
})

/** Whether there is anything to boast about — and anything to divide by. */
const hasCountableWork = (stats: BotStats | null): stats is BotStats =>
  stats !== null && stats.checked > 0

export interface StatsCardOptions {
  /** Enables the add-to-group link. Omitted before `getMe` lands. */
  botUsername?: string | null
  /**
   * The chat the card was asked from. Its own numbers lead, because an admin
   * deciding whether this bot earns its place cares about their room first and
   * the network second.
   */
  chat?: { title: string; stats: ChatStats; ago: string | null } | null
}

/**
 * `/stats` — the effectiveness card.
 *
 * The only place the bot advertises itself, so it is held to the standard its
 * moderation notices are: every figure is counted over a window it names, and
 * the share of messages it did NOT touch is printed beside what it punished.
 * That last line is the one a chat owner is actually deciding on — "it bans a
 * lot" reads as a threat to their own members until they see how rarely it acts.
 */
export const statsCard = (
  locale: Locale, stats: BotStats | null, options: StatsCardOptions = {}
): ViewMessage => {
  const buttons: ButtonSpec[][] = options.botUsername
    ? [[{
      text: locale.start.addToGroupButton,
      url: `https://t.me/${options.botUsername}?startgroup=add&admin=delete_messages+restrict_members+ban_users`
    }]]
    : []
  // A card of zeros would claim the bot has done nothing, which is a worse
  // answer than admitting the counts are out of reach.
  if (!hasCountableWork(stats)) return { text: locale.botStats.unavailable, buttons }

  const punished = stats.removals + stats.deletes
  const lines: string[] = []

  const here = options.chat
  if (here) {
    lines.push(locale.botStats.chatHeader(escapeHtml(here.title), here.stats.windowDays))
    if (here.stats.removals + here.stats.deletes > 0) {
      lines.push(locale.botStats.chatLine(here.stats.checked, here.stats.spammers, here.stats.deletes))
      if (here.ago !== null) lines.push(locale.botStats.chatLastSpam(here.ago))
    } else {
      lines.push(locale.botStats.chatClean)
    }
    lines.push('')
  }

  lines.push(locale.botStats.title, locale.botStats.window(stats.windowDays), '')
  lines.push(locale.botStats.checked(stats.checked))
  lines.push(locale.botStats.spammers(stats.spammers))
  lines.push(locale.botStats.chats(stats.chats))
  if (stats.latencyP50Ms !== null) lines.push(locale.botStats.speed(stats.latencyP50Ms))
  lines.push('', locale.botStats.quiet(((stats.checked - punished) / stats.checked) * 100))

  if (stats.topReasons.length > 0) {
    lines.push('', locale.botStats.reasonsTitle)
    for (const reason of stats.topReasons.slice(0, STATS_REASONS_SHOWN)) {
      lines.push(locale.botStats.reasonLine(locale.reasons[reason.reasonCode] ?? locale.reasonFallback, reason.count))
    }
  }

  const footer: string[] = []
  if (stats.signatures > 0) footer.push(locale.botStats.memory(stats.signatures))
  // Our own error rate, published. Meaningless without a denominator, so it is
  // shown only where something was actually punished.
  if (punished > 0 && stats.overrides > 0) {
    footer.push(locale.botStats.corrections((stats.overrides / punished) * 100))
  }
  if (footer.length > 0) lines.push('', ...footer)

  return { text: lines.join('\n'), buttons }
}

/** Three is what fits before the card stops being read. */
const STATS_REASONS_SHOWN = 3

/** /start inside a group: one-line hint, no panel. */
/**
 * The one-line reply to `/start` in a group.
 *
 * The help button is a LINK when we know our own username, not a callback. As a
 * callback it sent the help into the tapper's PM — which silently does nothing
 * when they have never opened a chat with the bot, and a tap that does nothing
 * is indistinguishable from a broken bot. A `t.me` link opens that chat as its
 * first act, so the failure mode does not exist. The callback stays as the
 * fallback for before `/getMe` lands.
 */
export const startGroupHint = (locale: Locale, botUsername?: string | undefined): ViewMessage => ({
  text: locale.start.groupHint,
  buttons: [[botUsername
    ? { text: locale.start.helpButton, url: `https://t.me/${botUsername}?start=help` }
    : { text: locale.start.helpButton, data: callbackData.help() }]]
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

/**
 * One-line moderation notice posted after an enforcement action.
 *
 * `incidentCount` turns the line into the notice for a RUN of messages from one
 * sender rather than for one message. The card is then edited in place instead
 * of a second one being posted: eight messages from a banned spammer used to
 * mean eight cards, which is the chat reading our bookkeeping instead of the
 * conversation.
 *
 * The count is rendered as a bare "×N" and deliberately not routed through the
 * locale — it is a numeral, and every language in `LOCALES` writes it the same
 * way. The words around it are localised as before.
 */
export const compactNotification = (
  locale: Locale,
  verdict: Verdict,
  target: { chatId: number; messageId: number; userId: number; userLabel: string },
  options: { botUsername?: string | undefined; incidentCount?: number | undefined } = {}
): ViewMessage => {
  const action = verdict.action
  if (action === 'none' || action === 'observe') {
    throw new Error('compactNotification is only for enforcement actions')
  }
  // With a known bot username the explanation is reached by a link INSIDE the
  // line rather than by a button under it. The notice is read in a scrolling
  // chat, most often after the fact, and a button row is a second visual object
  // per event: at a wave of removals the chat filled with chrome instead of
  // notices. As running text it costs two words, and the one button left is the
  // one that actually changes state.
  //
  // Without a username (unit tests, or before /getMe lands) there is no deep
  // link to point at, so it falls back to the in-group callback button.
  const notSpam = {
    text: locale.notification.notSpamButton,
    data: callbackData.override(target.chatId, target.messageId, target.userId)
  }
  const repeats = options.incidentCount ?? 1
  const line = locale.notification.compact(locale.actions[action], subjectMention(locale, target.userId, target.userLabel, nameIsPromo(verdict))) +
    (repeats > 1 ? ` · ×${repeats}` : '')
  if (!options.botUsername) {
    return {
      text: line,
      buttons: [[
        { text: locale.notification.whyButton, data: callbackData.why(target.chatId, target.messageId) },
        notSpam
      ]]
    }
  }
  const url = whyDeepLink(options.botUsername, target.chatId, target.messageId, target.userId)
  return {
    text: `${line} · <a href="${url}">${locale.notification.whyLink}</a>`,
    buttons: [[notSpam]]
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
  /**
   * Whether the reader may see the raw destination in the evidence quote.
   *
   * Separate from `technical`: `whyCard` renders its own footer, so it never
   * sets that flag, and the two questions are different anyway — one is "show
   * the machine tokens", this one is "is this reader the one being asked to
   * judge". Defaults to false, so a caller that says nothing gets the safe
   * version.
   */
  showRawEvidence?: boolean
  /**
   * Who this was about and where. Both optional: a card rebuilt after a restart
   * knows the verdict but not the names, and the card degrades to the verdict
   * rather than lying about them.
   */
  context?: {
    userLabel?: string | null
    /** Needed to make the label tappable. Plain-text renders ignore it. */
    userId?: number | null
    chatTitle?: string | null
  }
}

/**
 * Compact relative span ("щойно", "5хв", "3д", "2міс", "1р") from seconds.
 * Shared by the profile block and by the action headline's duration, so a mute
 * of a month reads the same way an account age of a month does.
 */
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
 * The `external_ban` evidence quote, rendered in the reader's language.
 *
 * Every other quote on this card is a stranger's own text, reprinted as it was
 * written; this one the bot writes itself, so it is the only one that can be
 * translated — and the only one where what it leaves out is a decision. Core
 * emits `external_ban:<sources>:<days|?>` and the names of the lists stay in
 * the log line: the count is the part a reviewer weighs (two lists agreeing is
 * a stronger claim than one), the names only tell an operator which service to
 * buy their way off (2026-08-30).
 *
 * Gated on the signal being present, not on the token matching. A decision
 * rebuilt from storage carries the message text in `reasonEvidence` — mongo
 * maps `textPreview` back into that field — so pattern alone would let a
 * stranger type the token and be quoted by the card as a ban database.
 */
const externalBanEvidence = (locale: Locale, verdict: Verdict): string | null => {
  if (verdict.reasonEvidence === null) return null
  if (!verdict.signals.some((signal) => signal.name === 'external_ban')) return null
  const parsed = /^external_ban:(\d+):(\d+|\?)$/.exec(verdict.reasonEvidence)
  if (!parsed) return null
  const days = parsed[2] === '?' ? null : Number(parsed[2])
  return locale.why.externalBanEvidence(
    Number(parsed[1]),
    days === null ? null : humanSpan(locale, days * 86400)
  )
}

/**
 * The headline: what was done, and for how long. An enforcement card is headed
 * by its own action — the duration included, because "muted" and "muted for a
 * month" are different decisions to review. A verdict that took no action (a
 * recalled `observe`) has nothing to announce and keeps the generic title.
 */
const actionHeadline = (locale: Locale, verdict: Verdict): string => {
  const action = verdict.action
  if (action === 'none' || action === 'observe') return locale.why.title
  const label = locale.actions[action]
  return verdict.banDurationSeconds
    ? `${label} ${humanSpan(locale, verdict.banDurationSeconds)}`
    : label
}

/**
 * Human "Why?" view. Built as a structured list, then rendered to plain text
 * (default, for the alert toast) or Telegram HTML (for the PM card). Raw
 * machine tokens — decidedBy, ruleId, signal names — only surface in the
 * admin-only technical footer; everyone else sees plain language. Unmapped
 * signals are dropped from the human list so no code ever leaks.
 *
 * Block order is evidence-first (chosen 2026-08-20): action + who + where, then
 * the message itself, then our verdict and its grounds. An admin opening this
 * is deciding one thing — "was the bot right?" — and the message is what
 * decides it. Leading with the bot's own confidence instead put our conclusion
 * ahead of the evidence for it, which is the wrong way round for a review
 * surface: the reader should judge the text, then see whether we agreed.
 */

/**
 * Somebody else's words, quoted.
 *
 * Long ones are `expandable`, which Telegram collapses to a few lines behind a
 * chevron — so a ballot stays one glance tall while the whole message is still
 * one tap away. mtcute 0.31 maps the attribute to `collapsed` on the entity.
 *
 * This was `<pre>` on the ballot until 2026-08-26, and a code block is the
 * wrong container twice over: it does not WRAP, so a long advert ran off the
 * right edge of the card with the half that matters out of sight, and monospace
 * reads as machine output rather than as a person talking.
 *
 * Height, not length, is what decides — a short text with several newlines is
 * tall, and a long unbroken one wraps. Takes text that is ALREADY escaped: this
 * is the presentation wrapper, and the escaping belongs with the truncation
 * that produced the string.
 */
const QUOTE_EXPAND_CHARS = 120
const QUOTE_EXPAND_LINES = 3
export const quoteBlock = (escaped: string): string => {
  const lines = escaped.split('\n').length
  const long = escaped.length > QUOTE_EXPAND_CHARS || lines > QUOTE_EXPAND_LINES
  return `<blockquote${long ? ' expandable' : ''}>${escaped}</blockquote>`
}

export const whyView = (locale: Locale, verdict: Verdict, options: WhyOptions = {}): string => {
  const { html: asHtml = false, technical = false, showRawEvidence = false, context = {} } = options
  const esc = asHtml ? escapeHtml : (s: string): string => s
  const b = asHtml ? (s: string): string => `<b>${s}</b>` : (s: string): string => s
  const dim = asHtml ? (s: string): string => `<i>${s}</i>` : (s: string): string => s

  const lines: string[] = []
  const headline = actionHeadline(locale, verdict)
  // The name is a link in the HTML card and plain text in the toast. A toast is
  // a callback alert: it has no markup at all, so an anchor there would be read
  // out as its own tags.
  const who = context.userLabel === null || context.userLabel === undefined
    ? null
    : asHtml
      ? subjectMention(locale, context.userId, context.userLabel, nameIsPromo(verdict))
      // The plain-text toast has no link to compromise, but reprinting a bought
      // name is still reprinting it.
      : nameIsPromo(verdict) && typeof context.userId === 'number'
        ? locale.hiddenName(context.userId)
        : context.userLabel
  lines.push(who === null ? b(esc(headline)) : b(`${esc(headline)} · ${who}`))
  if (context.chatTitle) lines.push(dim(esc(locale.why.inChat(context.chatTitle))))

  // The evidence, before our reading of it. `truncate` rather than `.slice`:
  // the text is whatever a stranger typed, and a cut through an emoji leaves an
  // unencodable half that Telegram rejects — the whole card, not the emoji.
  if (verdict.reasonEvidence) {
    /**
     * Redacted for everyone but the reviewer.
     *
     * This card is reached by a link inside a notice the whole chat reads, so a
     * member who taps it gets the evidence in a PM from the bot — invite
     * intact. A narrower channel than the ballot, and the same channel: our own
     * delivery of the thing we removed.
     *
     * The reviewer — the reader who can override — does need the destination,
     * because the message it came from is deleted by the time they are asked to
     * weigh it. Everybody else is being informed, not consulted.
     */
    const evidence = externalBanEvidence(locale, verdict)
      ?? (showRawEvidence
        ? verdict.reasonEvidence
        : redactLinks(verdict.reasonEvidence, locale.vote.redacted))
    const quote = esc(truncate(evidence, 300))
    lines.push('', asHtml ? quoteBlock(quote) : `"${quote}"`)
  }

  /**
   * How much this looked like spam — printed only when that is what decided it.
   *
   * `floorNetworkFact` acts on a verdict the classifier CLEARED: the sentence
   * really was ordinary and pSpam is 0.02, while the grounds are that the
   * profile photo dresses a crowd — something the number says nothing about.
   * Rendering the band anyway put «🟡 Можливо спам · 2%» at the top of a card
   * asking somebody to prove they are human, and a reader cannot reconcile
   * those two lines. The reason below can stand alone; a number contradicting
   * it cannot.
   */
  const showsBand = verdict.meta['flooredNetworkFact'] !== true
  if (showsBand) {
    const pct = Math.round(verdict.pSpam * 100)
    const confidence = verdict.pSpam >= 0.85
      ? locale.why.confidence.high
      : verdict.pSpam >= 0.6
        ? locale.why.confidence.medium
        : locale.why.confidence.low
    lines.push('', b(esc(confidence(pct))))
  }

  const reason = locale.reasons[verdict.reasonCode] ?? locale.reasonFallback
  // Bold and given its own break when it carries the card alone.
  lines.push(...(showsBand ? [esc(reason)] : ['', b(esc(reason))]))

  // Trust signals are never listed: nobody needs telling that their message was
  // a reply. Which signals those are comes from the catalogue, not from a flag
  // on the object — a verdict rebuilt from a stored decision carries names only.
  const suspicious = verdict.signals.map((s) => s.name).filter(isSuspicionSignal)
  const humanized = suspicious
    // Unlabelled signals are still dropped, and that is still right: an internal
    // identifier must never reach a member reading why their message went.
    //
    // What changed on 2026-07-31 is that the gap can no longer be a LIVE signal.
    // `signalLabels` is typed over the catalogue, so shipping a signal without
    // translating it does not compile — the day a signal moved verdicts while
    // being invisible here is closed by the type, not by this line. What remains
    // is a name a stored decision still carries after the signal was renamed,
    // and dropping that is the honest answer.
    .map((name) => locale.why.signalLabels[name] as string | undefined)
    .filter((label): label is string => Boolean(label))
    .slice(0, 6)
  if (humanized.length > 0) {
    lines.push('', esc(locale.why.noticedTitle))
    for (const label of humanized) lines.push(`• ${esc(label)}`)
  }

  if (technical) lines.push('', whyTechnicalFooter(locale, verdict, { html: asHtml }))

  return lines.join('\n')
}

/**
 * Technical footer (admins only): how the verdict was reached, plus the raw
 * signal codes. Separate from `whyView` so the PM card can place it after the
 * profile block — machine tokens belong at the bottom of a card, not wedged
 * between two blocks a human is reading.
 */
export const whyTechnicalFooter = (
  locale: Locale,
  verdict: Verdict,
  options: { html?: boolean } = {}
): string => {
  const asHtml = options.html ?? false
  const esc = asHtml ? escapeHtml : (s: string): string => s
  const dim = asHtml ? (s: string): string => `<i>${s}</i>` : (s: string): string => s
  const decidedBy = locale.why.decidedBy[verdict.decidedBy] ?? verdict.decidedBy
  const codes = verdict.signals.map((s) => s.name).filter(isSuspicionSignal).slice(0, 8)
  const lines = [dim(esc(`${decidedBy}${verdict.ruleId ? ` · ${verdict.ruleId}` : ''}`))]
  if (codes.length > 0) lines.push(dim(esc(codes.join(', '))))
  return lines.join('\n')
}

/**
 * Display-ready user facts for the profile card. Derived from a UserSnapshot
 * (+ external-ban merge) by the app layer — the ui never sees raw domain types.
 */
export interface UserFacts {
  userId: number
  username: string | null
  /**
   * The name Telegram shows for the account. Attacker-controlled, so escaped
   * on the way out. Null — we only have the id (a card rebuilt from storage).
   */
  displayName: string | null
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

/**
 * How recent a join still counts as a risk flag on the card. The pipeline's own
 * newness bar, imported rather than restated, so the card flags the population
 * the pipeline actually treats as new — not merely everyone whose join date we
 * happen to know.
 */
const JOINED_RECENTLY_MAX_SECONDS = ESTABLISHED_MIN_TENURE_DAYS * 86400

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

  const lines: string[] = []

  // Header names the account instead of the block: "👤 Профіль" over a bare id
  // told the reader nothing they could match against the chat they were just
  // reading. The id stays — it is what /check and the logs are keyed by — but
  // after the name and the handle, in the order an admin actually recognises.
  // The handle is a link where markup is available: `@name` as inert text was
  // the one thing on this card an admin most wanted to follow, and comparing
  // two similarly named accounts is exactly what /check is opened for.
  const handle = facts.username
    ? asHtml
      ? ` · <a href="https://t.me/${encodeURIComponent(facts.username)}">@${escapeHtml(facts.username)}</a>`
      : ` · @${facts.username}`
    : ''
  if (facts.displayName) {
    const named = asHtml
      ? userMention(facts.userId, facts.displayName)
      : escapeHtml(facts.displayName)
    lines.push(`👤 ${asHtml ? `<b>${named}</b>` : b(named)}${handle} · ${code(String(facts.userId))}`)
  } else {
    lines.push(b(p.title))
    lines.push(`${code(String(facts.userId))}${handle}`)
  }

  const age = facts.predictedAgeDays !== null ? `~${humanSpan(locale, facts.predictedAgeDays * 86400)}` : p.unknownAge
  // The same reading the pipeline uses (`tenureDays`), for the same reason: our
  // first-seen date restarts whenever our record does, so this line used to say
  // "never seen" about somebody Telegram places in the chat for years — and the
  // admin reading the card could not see the tenure the verdict was based on.
  const tenureSeconds = Math.max(
    facts.localAgeDays !== null ? facts.localAgeDays * 86400 : 0,
    facts.joinedAgoSeconds ?? 0
  )
  const seen = tenureSeconds > 0 ? humanSpan(locale, tenureSeconds) : p.neverSeen
  lines.push(`${p.accountAge(age)} · ${p.firstSeen(seen)}`)

  // Activity and reputation on one line: they answer the same question ("is
  // this a member or an arrival?"), and every line spent here is a line the
  // evidence and the signals are pushed down by.
  lines.push([
    p.activity(facts.messagesGlobal, facts.groupsActive),
    p.reputation(locale.stats.repStatus[facts.reputationStatus]),
    ...(facts.premium ? [p.premium] : [])
  ].join(' · '))

  // Risk flags grouped under a blank line, so the "who" block reads apart
  // from the "what's wrong" block.
  const risk: string[] = []
  if (facts.externalBan?.banned) {
    const ago = facts.externalBan.bannedAtDaysAgo !== null
      ? humanSpan(locale, facts.externalBan.bannedAtDaysAgo * 86400)
      : ''
    risk.push(`🚫 ${p.externalBan(ago, facts.externalBan.offenses)}`)
  }
  // A risk flag only while the join actually IS recent. The condition used to be
  // "we know the join date at all", so the card filed a member of two years
  // under risk flags with a 🆕 beside them — the join date rendered as an
  // accusation whatever it said, which is the display half of the same defect
  // `tenureDays` fixes. The bar is the pipeline's own newness bar, so the flag
  // marks exactly the population the pipeline treats as new.
  if (facts.joinedAgoSeconds !== null && facts.joinedAgoSeconds <= JOINED_RECENTLY_MAX_SECONDS) {
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
 * override button, the technical footer and a route to the live profile, since
 * the group notification has auto-deleted by the time they open this. When
 * `facts` are supplied a compact profile block is appended under the verdict.
 *
 * `userLabel` and `chatTitle` are what make the card readable out of context —
 * an admin arrives here from a link, hours later, for one of many chats. Both
 * are optional and the card simply omits what it was not given.
 */
export const whyCard = (
  locale: Locale,
  verdict: Verdict,
  target: { chatId: number; messageId: number; userId: number; userLabel?: string | null },
  options: {
    canOverride: boolean
    facts?: UserFacts | undefined
    chatTitle?: string | null
  }
): ViewMessage => {
  const body = whyView(locale, verdict, {
    html: true,
    // The reader who can undo this is the reader being asked to judge it.
    showRawEvidence: options.canOverride,
    context: {
      userLabel: target.userLabel ?? options.facts?.displayName ?? null,
      userId: target.userId,
      chatTitle: options.chatTitle ?? null
    }
  })
  const profile = options.facts ? `\n\n${userProfileLines(locale, options.facts, { html: true }).join('\n')}` : ''
  // Footer last, under the profile: the reader works down from what happened to
  // who it happened to, and only then to how we decided it.
  const footer = options.canOverride ? `\n\n${whyTechnicalFooter(locale, verdict, { html: true })}` : ''
  return {
    text: body + profile + footer,
    // Both buttons are moderator tools — the override changes state, the
    // profile shows ban history and reputation — so a non-admin reader (whose
    // own message this was) gets the explanation and nothing else.
    buttons: options.canOverride
      ? [[
          { text: locale.notification.notSpamButton, data: callbackData.override(target.chatId, target.messageId, target.userId) },
          { text: locale.profile.openButton, data: callbackData.profile(target.chatId, target.userId) }
        ]]
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
  /**
   * `userId` is optional because a row can outlive our knowledge of who it was.
   * Where it is present the name becomes a mention: two people with the same
   * display name are indistinguishable on a leaderboard otherwise, and the ids
   * were being discarded one line before the render.
   */
  entries: { name: string; value: number; userId?: number | null }[]
): ViewMessage => {
  if (entries.length === 0) return { text: locale.top.empty, buttons: [] }
  const title = kind === 'banan' ? locale.top.titleBanan : locale.top.titleMessages
  const unit = kind === 'banan' ? locale.top.bananUnit : locale.top.messagesUnit
  const lines = entries.map((e, i) => {
    const badge = MEDALS[i] ?? `${i + 1}.`
    return `${badge} ${userMention(e.userId, e.name)} · ${e.value} ${unit(e.value)}`
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
      // Welcome + extras editors live behind their own screens.
      [
        { text: locale.settings.welcome, data: callbackData.welcome(chatId, 'open') },
        { text: locale.settings.extras, data: callbackData.extras(chatId, 'open') }
      ],
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

// ── PM welcome / extras editor (opened from /settings) ─────────────────────

/**
 * Preview shortener for editor lists: cut, then mark the cut with an ellipsis.
 * Cuts through `truncate` (core) rather than `.slice`, because admin-authored
 * welcome texts are as full of emoji as any other message, and half an emoji
 * is unencodable — it would take the whole editor screen down, not one row.
 */
const ellipsize = (s: string, max: number): string =>
  s.length <= max ? s : `${truncate(s, max - 1)}…`

/** Chunk delete buttons + build a ‹ N/M › pager row (empty when single page). */
const paginate = <T>(
  items: T[],
  page: number,
  perPage: number,
  pageCb: (p: number) => string
): { pageItems: { item: T; index: number }[]; nav: ButtonSpec[] } => {
  const pages = Math.max(1, Math.ceil(items.length / perPage))
  const p = Math.max(0, Math.min(page, pages - 1))
  const slice = items.slice(p * perPage, p * perPage + perPage)
  const pageItems = slice.map((item, i) => ({ item, index: p * perPage + i }))
  const nav: ButtonSpec[] = pages > 1
    ? [
        { text: '‹', data: pageCb(p === 0 ? pages - 1 : p - 1) },
        { text: `${p + 1}/${pages}`, data: 'noop' },
        { text: '›', data: pageCb(p === pages - 1 ? 0 : p + 1) }
      ]
    : []
  return { pageItems, nav }
}

/** Welcome editor root: toggle + counts + navigation to the text/gif lists. */
export const welcomeEditor = (
  locale: Locale,
  chatId: number,
  state: { enable: boolean; textsCount: number; gifsCount: number }
): ViewMessage => {
  const e = locale.welcome.editor
  const stateStr = state.enable ? locale.settings.on : locale.settings.off
  const buttons: ButtonSpec[][] = [
    [{
      text: state.enable ? e.disable : e.enable,
      data: callbackData.welcome(chatId, 'toggle')
    }],
    [
      { text: e.texts(state.textsCount), data: callbackData.welcome(chatId, 'texts') },
      { text: e.gifs(state.gifsCount), data: callbackData.welcome(chatId, 'gifs') }
    ]
  ]
  if (state.textsCount > 0 || state.gifsCount > 0) {
    buttons.push([{ text: e.preview, data: callbackData.welcome(chatId, 'preview') }])
  }
  buttons.push([{ text: locale.settings.back, data: callbackData.settings(chatId, 'root') }])
  return { text: e.title(stateStr, state.textsCount, state.gifsCount), buttons }
}

/** Paginated welcome-texts list with per-item delete + add. */
export const welcomeTextsScreen = (
  locale: Locale,
  chatId: number,
  texts: string[],
  page = 0
): ViewMessage => {
  const e = locale.welcome.editor
  if (texts.length === 0) {
    return {
      text: e.textsEmpty,
      buttons: [
        [{ text: e.addText, data: callbackData.welcome(chatId, 'taddc') }],
        [{ text: locale.settings.back, data: callbackData.welcome(chatId, 'open') }]
      ]
    }
  }
  const { pageItems, nav } = paginate(texts, page, 5, (p) => callbackData.welcome(chatId, 'tpage', String(p)))
  const list = pageItems
    // Escaped, like the extras list beside it and unlike this line until now.
    // The template is admin-authored, not attacker-authored, but `viewHtml`
    // parses it as HTML either way: a `<` or an `&` in a greeting — or a tag
    // sliced in half by the 50-character preview — takes the whole editor
    // screen down. Ellipsize first, so the budget counts characters and not
    // entity escapes.
    .map(({ item, index }) => e.textsItem(index + 1, escapeHtml(ellipsize(item.replace(/\n/g, ' '), 50))))
    .join('\n')
  const delRow = pageItems.map(({ index }) => ({
    text: `${index + 1} 🗑`,
    data: callbackData.welcome(chatId, 'tdel', String(index))
  }))
  const buttons: ButtonSpec[][] = []
  for (let i = 0; i < delRow.length; i += 5) buttons.push(delRow.slice(i, i + 5))
  if (nav.length) buttons.push(nav)
  buttons.push([{ text: e.addText, data: callbackData.welcome(chatId, 'taddc') }])
  buttons.push([{ text: locale.settings.back, data: callbackData.welcome(chatId, 'open') }])
  return { text: e.textsTitle(texts.length, 20) + '\n\n' + list, buttons }
}

/** Paginated welcome-gifs list. Gifs can't preview inline, so rows are #N. */
export const welcomeGifsScreen = (
  locale: Locale,
  chatId: number,
  gifs: string[],
  page = 0
): ViewMessage => {
  const e = locale.welcome.editor
  if (gifs.length === 0) {
    return {
      text: e.gifsEmpty,
      buttons: [
        [{ text: e.addGif, data: callbackData.welcome(chatId, 'gaddc') }],
        [{ text: locale.settings.back, data: callbackData.welcome(chatId, 'open') }]
      ]
    }
  }
  const { pageItems, nav } = paginate(gifs, page, 8, (p) => callbackData.welcome(chatId, 'gpage', String(p)))
  const list = pageItems.map(({ index }) => e.gifsItem(index + 1)).join('\n')
  const delRow = pageItems.map(({ index }) => ({
    text: `${index + 1} 🗑`,
    data: callbackData.welcome(chatId, 'gdel', String(index))
  }))
  const buttons: ButtonSpec[][] = []
  for (let i = 0; i < delRow.length; i += 5) buttons.push(delRow.slice(i, i + 5))
  if (nav.length) buttons.push(nav)
  buttons.push([{ text: e.addGif, data: callbackData.welcome(chatId, 'gaddc') }])
  buttons.push([{ text: locale.settings.back, data: callbackData.welcome(chatId, 'open') }])
  return { text: e.gifsTitle(gifs.length, 20) + '\n\n' + list, buttons }
}

/** Paginated extras list with per-item delete, add, and a maxExtra stepper. */
export const extrasEditor = (
  locale: Locale,
  chatId: number,
  extras: { name: string; hasMedia: boolean }[],
  maxExtra: number,
  page = 0
): ViewMessage => {
  const e = locale.extra.editor
  const buttons: ButtonSpec[][] = []
  if (extras.length === 0) {
    return {
      text: e.empty,
      buttons: [
        [{ text: e.add, data: callbackData.extras(chatId, 'addc') }],
        [{ text: locale.settings.back, data: callbackData.settings(chatId, 'root') }]
      ]
    }
  }
  const { pageItems, nav } = paginate(extras, page, 8, (p) => callbackData.extras(chatId, 'page', String(p)))
  const list = pageItems
    .map(({ item, index }) => e.item(index + 1, item.hasMedia ? '📎' : '📝', escapeHtml(item.name)))
    .join('\n')
  const delRow = pageItems.map(({ index }) => ({
    text: `${index + 1} 🗑`,
    data: callbackData.extras(chatId, 'del', String(index))
  }))
  for (let i = 0; i < delRow.length; i += 5) buttons.push(delRow.slice(i, i + 5))
  if (nav.length) buttons.push(nav)
  buttons.push([
    { text: '−', data: callbackData.extras(chatId, 'maxdec') },
    { text: e.maxLabel(maxExtra), data: 'noop' },
    { text: '+', data: callbackData.extras(chatId, 'maxinc') }
  ])
  buttons.push([{ text: e.add, data: callbackData.extras(chatId, 'addc') }])
  buttons.push([{ text: locale.settings.back, data: callbackData.settings(chatId, 'root') }])
  return { text: e.title(extras.length, maxExtra) + '\n\n' + list, buttons }
}

/** How much of the message the question quotes back. */
const VOTE_PREVIEW_LIMIT = 200

/**
 * Community vote prompt. Counts live on the buttons; both the quoted text
 * and the user label are escaped here — they are attacker-controlled.
 *
 * `truncate`, not `.slice`. The report path has already cut the text to 200
 * CODE POINTS, and a second cut at 200 CODE UNITS lands mid-surrogate on any
 * text where emoji outnumber letters — which is what most of this spam is. The
 * orphaned half then went through `escapeHtml` into Telegram HTML.
 *
 * A message with no words gets a different sentence rather than this one with
 * an empty string in it. Rendering `""` presented emptiness as content, and it
 * did not stop anybody voting: production 2026-08-25 shows two spam votes on a
 * ballot that quoted nothing at all. Naming the medium is the smallest true
 * thing available, and it is the only thing available — what the profile
 * advertises must NOT go here, however tempting. A chat shown a bio votes on
 * the bio, and the result is recorded as a finding about the message.
 */
export const votePrompt = (
  locale: Locale,
  target: {
    chatId: number
    messageId: number
    /** Who is being asked about. Absent only where a restart lost it. */
    userId?: number | null
    userLabel: string
    textPreview: string
    /** What the message carried besides words, or instead of them. */
    media?: MediaCategory | null
    /** The display name is itself an advert — see `subjectMention`. */
    promoName?: boolean
  },
  tally: { spam: number; ham: number; outcome: string },
  options: { botUsername?: string | undefined } = {}
): ViewMessage => {
  // Redact BEFORE truncating, so the cut lands in the sender's words rather
  // than through a marker. Redaction never empties a message that had text —
  // a destination becomes a marker, not nothing — so a quote-only-a-link
  // message still takes the quoting branch instead of claiming "no text".
  const quoted = redactLinks(target.textPreview, locale.vote.redacted).trim()
  const name = subjectMention(locale, target.userId, target.userLabel, target.promoName ?? false)
  // Named on the ballot even when the message HAD words: the caption under an
  // advert is the innocuous half, and a ballot that quotes only the caption
  // asks about half the message. Until now `media` was read on the no-text
  // branch alone, so every captioned photo was voted on as if it were text.
  const media = target.media ? locale.vote.media[target.media] : null
  const whyLink = options.botUsername && typeof target.userId === 'number'
    ? `<a href="${whyDeepLink(options.botUsername, target.chatId, target.messageId, target.userId)}">${locale.notification.whyLink}</a>`
    : null
  return {
    text: quoted.length > 0
      ? locale.vote.prompt({
        userLabel: name,
        textPreview: quoteBlock(escapeHtml(truncate(quoted, VOTE_PREVIEW_LIMIT))),
        media,
        whyLink
      })
      : locale.vote.promptNoText(name, media, whyLink),
    // Two buttons, both of which change state. The explanation is a link in the
    // text, not a third button: a ballot is read in a scrolling chat and a row
    // of read-only chrome is what made the notices unreadable in the first place.
    buttons: [[
      { text: locale.vote.spamButton(tally.spam), data: callbackData.vote(target.chatId, target.messageId, 'spam') },
      { text: locale.vote.hamButton(tally.ham), data: callbackData.vote(target.chatId, target.messageId, 'ham') }
    ]]
  }
}

/**
 * How many names one roster shows.
 *
 * A cap rather than a scroll: the roster is delivered as a whisper, and where
 * the ephemeral API is unavailable it degrades to a 200-character callback
 * alert. Building forty names only to have them cut mid-word would turn the
 * transparency this view exists for into a shrug.
 */
export const VOTERS_SHOWN_MAX = 12

/** Roster output shape: whispered as HTML, or plain for a callback alert. */
type VoterListFormat = 'html' | 'text'

const voterLine = (locale: Locale, voter: VoterEntry, format: VoterListFormat): string => {
  const marks = [
    voter.isAdmin ? locale.vote.voters.adminMark : null,
    voter.changedMind ? locale.vote.voters.changedMark : null
  ].filter((m): m is string => m !== null)
  // A display name is whatever the person set it to, so it is markup until
  // escaped — the same rule `viewHtml` enforces for every other user string.
  const raw = voter.label ?? String(voter.userId)
  const name = format === 'html' ? userMention(voter.userId, raw) : raw
  return marks.length > 0 ? ` • ${name} · ${marks.join(' · ')}` : ` • ${name}`
}

const voterGroup = (
  locale: Locale, heading: string, voters: VoterEntry[], format: VoterListFormat
): string[] => {
  if (voters.length === 0) return []
  const shown = voters.slice(0, VOTERS_SHOWN_MAX)
  const hidden = voters.length - shown.length
  return [
    '',
    format === 'html' ? `<b>${heading}</b>` : heading,
    ...shown.map((v) => voterLine(locale, v, format)),
    ...(hidden > 0 ? [` ${locale.vote.voters.more(hidden)}`] : [])
  ]
}

/**
 * Who voted which way on a question that has closed.
 *
 * The span line is the part that earns this view. Counters say three people
 * agreed; only the clock separates a chat reacting over four minutes from three
 * accounts tapping in two seconds, and that difference is the whole question
 * somebody asks when they doubt a result.
 */
export const voterListView = (
  locale: Locale, roster: VoterRoster, format: VoterListFormat = 'html'
): string => {
  const t = locale.vote.voters
  const title = t.title(roster.spam.length, roster.ham.length)
  const lines = [
    format === 'html' ? title : title.replace(/<\/?b>/g, ''),
    ...voterGroup(locale, t.spamGroup, roster.spam, format),
    ...voterGroup(locale, t.hamGroup, roster.ham, format)
  ]
  if (roster.spam.length === 0 && roster.ham.length === 0) lines.push('', t.nobody)
  if (roster.spanSeconds !== null) {
    lines.push('', t.span(humanSpan(locale, roster.spanSeconds)))
  }
  return lines.join('\n')
}

/**
 * Which of the four enforcement sentences this outcome earned. `undefined` in,
 * `null` out: a caller that attempted nothing asserts nothing.
 */
const enforcementClause = (
  locale: Locale,
  enforced: { deleted: boolean; muted: boolean } | undefined
): string | null => {
  if (enforced === undefined) return null
  const e = locale.vote.enforcement
  if (enforced.deleted && enforced.muted) return e.done
  if (enforced.deleted) return e.deletedOnly
  if (enforced.muted) return e.mutedOnly
  return e.failed
}

/**
 * The receipt that replaces a resolved question, in place.
 *
 * It names the person, which the first version did not: the ballot's own text —
 * the quote, the label, the tally — is overwritten by this line, so a chat
 * scrolling past "the community says spam" a minute later had no way to tell
 * WHO had been judged, and the roster button named the voters rather than the
 * subject. The label is optional because a restart can lose it, and a receipt
 * that says less is better than one that guesses.
 */
export const voteResult = (
  locale: Locale,
  target: {
    chatId: number
    messageId: number
    userId?: number | null
    userLabel?: string | null
    promoName?: boolean
  },
  outcome: 'spam' | 'ham',
  options: {
    botUsername?: string | undefined
    /**
     * What the bot actually managed. Omitted means "do not claim anything" —
     * which is what a caller that did not attempt enforcement should do, and
     * what the receipt used to do while claiming removal anyway.
     */
    enforced?: { deleted: boolean; muted: boolean } | undefined
  } = {}
): ViewMessage => {
  const who = target.userLabel
    ? subjectMention(locale, target.userId, target.userLabel, target.promoName ?? false)
    : null
  const whyLink = options.botUsername && typeof target.userId === 'number'
    ? `<a href="${whyDeepLink(options.botUsername, target.chatId, target.messageId, target.userId)}">${locale.notification.whyLink}</a>`
    : null
  return {
    text: outcome === 'spam'
      ? locale.vote.resolvedSpam({ who, enforcement: enforcementClause(locale, options.enforced), whyLink })
      : locale.vote.resolvedHam({ who, whyLink }),
    buttons: [[{
      text: locale.vote.voters.button,
      data: callbackData.voters(target.chatId, target.messageId)
    }]]
  }
}

/**
 * Captcha gate prompt posted in the group. The target user proves liveness
 * with one tap; everyone else's taps are rejected by the handler.
 */
export const captchaPrompt = (
  locale: Locale,
  target: { chatId: number; userId: number; userLabel: string }
): ViewMessage => ({
  text: locale.captcha.prompt(userMention(target.userId, target.userLabel)),
  buttons: [[{
    text: locale.captcha.button,
    data: callbackData.captcha(target.chatId, target.userId)
  }]]
})
