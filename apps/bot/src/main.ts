/**
 * Composition root: wires core (pure pipeline) + adapters (mtcute) +
 * data (Mongo/Qdrant/LLM) + ui (views). No business logic lives here —
 * only assembly, the per-message flow, and callback handling.
 */
import { BotKeyboard, Chat, User, html, type Message } from '@mtcute/node'
import {
  evaluateMessage, tallyVotes, extractBioSignals, isEnforcementAction,
  shouldAutoLearn, autoLearnSource, voteLearnStatus,
  type EvaluationInput, type ForwardOrigin, type PipelinePorts,
  type UserSnapshot, type Verdict, type VoteBallot
} from '@lyadmin/core'
import {
  TelegramGateway, applyVerdict, buildUserSnapshot, buildChannelSnapshot, normalizeMessage,
  fetchUserProfile, downloadPhotoBase64, downloadAvatarBase64, downloadStoriesBase64, rawPhotoToBase64,
  fetchExternalBan, needsExternalRecheck, resolveMentionKinds,
  type IncomingMessage
} from '@lyadmin/adapters'
import {
  MongoStore, MongoSignaturePort, MongoForwardPort, QdrantVectorPort,
  OpenAiModerationPort, OpenRouterLlmPort,
  PersistentVelocityPort, PersistentSessionPort, MemoryConversationWindow,
  matchExtras, buildWelcomeGreeting, PendingInput,
  groupDocToChatPolicy, presetToThreshold, userDocToHistory, mergeExternalBan,
  type NormalizedExtra, type PendingEntry
} from '@lyadmin/data'
import {
  captchaPrompt, compactNotification, escapeHtml as escapeName, helpView,
  langPanel, langPicker, parseCallback, resolveLocale, settingsDeepLink, settingsPanel,
  startCard, startGroupHint, topList, userProfileCard, votePrompt, whyCard, whyView,
  welcomeEditor, welcomeTextsScreen, welcomeGifsScreen, extrasEditor,
  LOCALES, type Locale, type UserFacts, type ViewMessage
} from '@lyadmin/ui'
import { loadConfig } from './config.js'
import { registerBotCommands } from './commands.js'
import { formatDuration, parseBananDuration } from './duration.js'
import { formatSignals, log } from './logger.js'
import { RightsMemory, RIGHTS_ERROR_REGEX } from './rights.js'

const config = loadConfig()

const store = new MongoStore()
// Velocity/session live in Mongo (TTL-expired) so the flood window and
// abstain accumulation survive restarts and are shared across instances.
const sessionPort = new PersistentSessionPort(store)
const velocityPort = new PersistentVelocityPort(store)
const signaturePort = new MongoSignaturePort(store)
const forwardPort = new MongoForwardPort(store)
const conversationWindow = new MemoryConversationWindow()
// Transient per-admin input state for the PM welcome/extras editor. Memory-only
// on purpose — a half-finished "add" is not worth persisting across restarts.
const pendingInput = new PendingInput()
// Module-level handle so the vote path can self-learn into Qdrant, not just
// search it. Null when embeddings/Qdrant are not configured.
const vectorPort = config.qdrantUrl && config.openaiApiKey
  ? new QdrantVectorPort({
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey ?? undefined,
      openaiApiKey: config.openaiApiKey
    })
  : null

const buildPorts = (): PipelinePorts => {
  const ports: PipelinePorts = {
    signatures: signaturePort,
    velocity: velocityPort,
    session: sessionPort,
    forwards: forwardPort
  }
  if (vectorPort) ports.vectors = vectorPort
  if (config.openaiApiKey) {
    ports.moderation = new OpenAiModerationPort(config.openaiApiKey)
  }
  if (config.openrouterApiKey) {
    ports.llm = new OpenRouterLlmPort({
      apiKey: config.openrouterApiKey,
      cheapModel: config.llmCheapModel,
      strongModel: config.llmStrongModel,
      briefingProvider: campaignBriefing
    }, store)
  }
  return ports
}

// Daily campaign briefing for the LLM: recent confirmed-spam samples, cached
// so the per-classify hook stays cheap. Null when there is nothing fresh.
const BRIEFING_TTL_MS = 10 * 60 * 1000
const BRIEFING_WINDOW_MS = 7 * 86400 * 1000
let briefingCache: { text: string | null; at: number } = { text: null, at: 0 }
const campaignBriefing = async (): Promise<string | null> => {
  const now = Date.now()
  if (briefingCache.at !== 0 && now - briefingCache.at < BRIEFING_TTL_MS) return briefingCache.text
  const samples = await store.recentConfirmedSpamSamples(8, now - BRIEFING_WINDOW_MS).catch(() => [])
  const text = samples.length > 0
    ? samples.map((s) => `- ${s.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    : null
  briefingCache = { text, at: now }
  return text
}

const gateway = new TelegramGateway({
  apiId: config.apiId,
  apiHash: config.apiHash,
  botToken: config.botToken,
  session: config.session
})

const ports = buildPorts()

/** Verdicts kept for the [Why?] button (memory, bounded). */
const recentVerdicts = new Map<string, Verdict>()
const rememberVerdict = (chatId: number, messageId: number, verdict: Verdict): void => {
  recentVerdicts.set(`${chatId}:${messageId}`, verdict)
  if (recentVerdicts.size > 2000) {
    const firstKey = recentVerdicts.keys().next().value
    if (firstKey) recentVerdicts.delete(firstKey)
  }
}
/**
 * Verdict for the Why?/override path: the in-process cache first, then the
 * persisted decision (pipeline_decisions, 90d) so a restart never silently
 * strips the Why? card or the admin's undo path.
 */
const recallVerdict = async (chatId: number, messageId: number): Promise<Verdict | null> => {
  const cached = recentVerdicts.get(`${chatId}:${messageId}`)
  if (cached) return cached
  return store.getDecision(chatId, messageId).catch(() => null)
}

/**
 * Display-ready user facts captured at decision time, so the "Why?" card can
 * show a profile block. In-memory only (mirrors recentVerdicts) — after a
 * restart the card degrades to the verdict alone, exactly like signal
 * evidence does. /check always builds facts live instead.
 */
const recentFacts = new Map<string, UserFacts>()
const rememberFacts = (chatId: number, messageId: number, facts: UserFacts): void => {
  recentFacts.set(`${chatId}:${messageId}`, facts)
  if (recentFacts.size > 2000) {
    const firstKey = recentFacts.keys().next().value
    if (firstKey) recentFacts.delete(firstKey)
  }
}
const recallFacts = (chatId: number, messageId: number): UserFacts | undefined =>
  recentFacts.get(`${chatId}:${messageId}`)

/** Map a UserSnapshot to the ui's display contract. */
const factsFromSnapshot = (
  user: UserSnapshot,
  flags: { promoInBio: boolean; personalChannel: boolean }
): UserFacts => {
  const eb = user.externalBan
  return {
    userId: user.id,
    username: user.username,
    predictedAgeDays: user.predictedAgeDays,
    localAgeDays: user.localAgeDays,
    messagesGlobal: user.messagesGlobal,
    groupsActive: user.groupsActive,
    reputationStatus: user.reputationStatus,
    premium: user.flags.premium,
    externalBan: eb
      ? {
          banned: eb.banned,
          bannedAtDaysAgo: eb.bannedAt ? Math.max(0, (Date.now() - eb.bannedAt.getTime()) / 86_400_000) : null,
          offenses: eb.offenses
        }
      : null,
    joinedAgoSeconds: user.joinedAgoSeconds,
    promoInBio: flags.promoInBio,
    personalChannel: flags.personalChannel
  }
}

/** Forward origins of recently actioned messages — for clean-reports on override. */
const recentForwards = new Map<string, ForwardOrigin>()
const rememberForward = (chatId: number, messageId: number, forward: ForwardOrigin): void => {
  recentForwards.set(`${chatId}:${messageId}`, forward)
  if (recentForwards.size > 2000) {
    const firstKey = recentForwards.keys().next().value
    if (firstKey) recentForwards.delete(firstKey)
  }
}

/**
 * Server-side captcha state. Callback payloads are forgeable (any client can
 * send arbitrary data against a bot message), so the `cap` handler must only
 * lift restrictions for gates we actually issued — and only once.
 *
 * The gate also records HOW it was announced: a whispered prompt is addressed
 * by its own ephemeral id over the Bot API, a visible one by message id over
 * MTProto, and a gate may end up with both.
 */
const CAPTCHA_TTL_MS = 10 * 60 * 1000

/**
 * How long a whispered prompt gets on its own before the visible one goes up
 * as well.
 *
 * Ephemeral delivery cannot be verified end to end from this side: the send
 * goes out over the Bot API while taps come back through our MTProto session,
 * and layer 227 — what mtcute 0.30 speaks — has no ephemeral id anywhere on
 * `updateBotCallbackQuery`. If the tap never reaches us, or the recipient's
 * client never rendered the whisper, the user would sit restricted with nothing
 * to press. So silence is treated as a delivery failure, not as a refusal.
 */
const CAPTCHA_WHISPER_GRACE_MS = 45 * 1000

interface CaptchaGate {
  expiresMs: number
  /** Set once the whisper lands; addressed via deleteEphemeralMessage. */
  ephemeralMessageId: number | null
  /** Set once a visible prompt is posted; an ordinary message id. */
  publicMessageId: number | null
  fallbackTimer: ReturnType<typeof setTimeout> | null
}

const pendingCaptchas = new Map<string, CaptchaGate>()
const captchaKey = (chatId: number, userId: number): string => `${chatId}:${userId}`

/** Drop a gate and, crucially, its pending fallback timer. */
const forgetCaptcha = (key: string): void => {
  const gate = pendingCaptchas.get(key)
  if (gate?.fallbackTimer) clearTimeout(gate.fallbackTimer)
  pendingCaptchas.delete(key)
}

const issueCaptcha = (chatId: number, userId: number): CaptchaGate => {
  if (pendingCaptchas.size > 2000) {
    for (const [key, gate] of pendingCaptchas) {
      if (gate.expiresMs <= Date.now()) forgetCaptcha(key)
    }
  }
  const gate: CaptchaGate = {
    expiresMs: Date.now() + CAPTCHA_TTL_MS,
    ephemeralMessageId: null,
    publicMessageId: null,
    fallbackTimer: null
  }
  pendingCaptchas.set(captchaKey(chatId, userId), gate)
  return gate
}

/** The gate this tap belongs to, consumed; null if forged, stale or expired. */
const consumeCaptcha = (chatId: number, userId: number): CaptchaGate | null => {
  const key = captchaKey(chatId, userId)
  const gate = pendingCaptchas.get(key)
  if (gate === undefined) return null
  forgetCaptcha(key)
  return gate.expiresMs > Date.now() ? gate : null
}

/**
 * Ask the sender to prove they are human: whisper first, visible prompt as the
 * safety net.
 *
 * The whisper is what makes asking cheap enough to prefer over punishing —
 * nobody else in the chat sees the accusation, so a wrong guess costs the
 * member one tap instead of public suspicion.
 *
 * The grace timer stays even though taps arrive natively
 * (`updateEphemeralBotCallbackQuery`, layer 228): a restriction the user cannot
 * lift is the one failure mode that must not exist, and no client-side
 * rendering guarantee comes with a successful send. Silence is therefore
 * treated as non-delivery, not as refusal — the cost of being wrong about that
 * is one extra visible prompt, which is what every captcha did until now.
 */
const deliverCaptcha = async (
  chatId: number,
  userId: number,
  userLabel: string,
  locale: Locale
): Promise<void> => {
  const gate = issueCaptcha(chatId, userId)
  const view = captchaPrompt(locale, { chatId, userId, userLabel })

  const postVisible = async (): Promise<void> => {
    const sent = await gateway.tg.sendText(chatId, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
      // Prompt failure is survivable: the restriction expires on its own.
    }).catch(() => null)
    if (sent) gate.publicMessageId = sent.id
  }

  if (!config.ephemeralCaptcha) {
    await postVisible()
    return
  }

  try {
    gate.ephemeralMessageId = await gateway.sendEphemeralPrompt(
      chatId, userId, view.text,
      view.buttons.map((row) => row.map((b) => ({ text: b.text, data: b.data ?? '' })))
    )
    log.info('captcha_whispered', { chatId, userId })

    const timer = setTimeout(() => {
      // Still the same open gate? A tap (or a re-issue) already replaced it.
      if (pendingCaptchas.get(captchaKey(chatId, userId)) !== gate) return
      log.warn('captcha_whisper_unanswered', { chatId, userId })
      void postVisible()
    }, CAPTCHA_WHISPER_GRACE_MS)
    // A pending fallback must not keep the process alive on shutdown.
    timer.unref?.()
    gate.fallbackTimer = timer
  } catch (err) {
    log.warn('captcha_whisper_failed', { chatId, userId, err })
    await postVisible()
  }
}

/**
 * One tap proved liveness. Shared by both tap paths — a visible prompt arrives
 * as an ordinary callback query, a whispered one as an ephemeral callback query
 * — because the gate bookkeeping, not the update type, is what decides here.
 *
 * `answer` is the caller's way to acknowledge its own query type; returning
 * false means the tap was forged, stale, or already spent.
 */
const passCaptcha = async (
  chatId: number,
  userId: number,
  locale: Locale,
  answer: (text?: string) => Promise<void>
): Promise<boolean> => {
  // Forgeable payload: lift the gate only if WE issued it, and only once.
  const gate = consumeCaptcha(chatId, userId)
  if (!gate) {
    await answer()
    return false
  }
  await gateway.tg.restrictChatMember({ chatId, userId, restrictions: {} })
    .catch(() => { /* window may have expired already */ })
  log.info('captcha_passed', {
    chatId, userId, via: gate.ephemeralMessageId !== null ? 'whisper' : 'visible'
  })
  await answer(locale.captcha.passed)

  // Clean up whichever channels actually announced this gate — a gate whose
  // whisper went unanswered has both.
  if (gate.publicMessageId !== null) {
    await gateway.tg.deleteMessagesById(chatId, [gate.publicMessageId])
      .catch(() => { /* already gone */ })
  }
  if (gate.ephemeralMessageId !== null) {
    await gateway.removeEphemeralPrompt(chatId, userId, gate.ephemeralMessageId)
      .catch(() => { /* expires on its own anyway */ })
  }
  return true
}

/** Admin cache: chatId:userId → isAdmin, 10 min TTL. */
const adminCache = new Map<string, { isAdmin: boolean; expiresMs: number }>()
const isChatAdmin = async (chatId: number, userId: number): Promise<boolean> => {
  const key = `${chatId}:${userId}`
  const cached = adminCache.get(key)
  if (cached && cached.expiresMs > Date.now()) return cached.isAdmin
  let isAdmin = false
  try {
    const member = await gateway.tg.getChatMember({ chatId, userId })
    isAdmin = member !== null && (member.status === 'admin' || member.status === 'creator')
  } catch { /* not a member / hidden — treat as non-admin */ }
  adminCache.set(key, { isAdmin, expiresMs: Date.now() + 10 * 60 * 1000 })
  return isAdmin
}

let selfId = 0
let selfUsername: string | null = null

/** ViewMessage buttons → mtcute keyboard (callback or url). */
const toKeyboard = (buttons: ViewMessage['buttons']): ReturnType<typeof BotKeyboard.inline> =>
  BotKeyboard.inline(buttons.map((row) => row.map((b) =>
    b.url ? BotKeyboard.url(b.text, b.url) : BotKeyboard.callback(b.text, b.data ?? ''))))

/** Locale resolution: stored preference first, Telegram client language second. */
const localeFor = async (userId: number, clientLanguage: string | null): Promise<Locale> => {
  const stored = await store.getUserLocale(userId).catch(() => null)
  return resolveLocale(stored ?? clientLanguage)
}

/** View texts use \n; the HTML parser collapses whitespace, so map to <br>. */
const viewHtml = (text: string): ReturnType<typeof html> =>
  html(text.replace(/\n/g, '<br>'))

/**
 * Auto-delete TTLs for transient in-group chrome (ms). The compact mod
 * notification and the banan/vote prompts are ephemeral — they clean
 * themselves up so chats stay readable. Mirrors v1 cleanup-policy.
 */
const NOTIFY_TTL_COMPACT_MS = 90 * 1000
const NOTIFY_TTL_BANAN_MS = 60 * 1000
const NOTIFY_TTL_VOTE_RESULT_MS = 2 * 60 * 1000
const NOTIFY_TTL_TOP_MS = 10 * 60 * 1000

/**
 * Scheduled deletion, persistent. The row in `scheduleddeletions` survives a
 * restart; an in-memory timer handles the fast path and clears the row once
 * the message is gone. A periodic sweep (processDueDeletions) is the backstop
 * for anything scheduled before the last restart.
 */
const scheduleDelete = (chatId: number, messageId: number, delayMs: number, source: string): void => {
  store.scheduleDeletion({ chatId, messageId, delayMs, source }).catch(() => { /* sweep is the backstop */ })
  setTimeout(() => {
    void (async () => {
      await gateway.tg.deleteMessagesById(chatId, [messageId]).catch(() => { /* already gone */ })
      await store.unscheduleDeletion(chatId, messageId).catch(() => { /* sweep / TTL collects it */ })
    })()
  }, delayMs).unref?.()
}

/** Backstop sweep: delete everything whose deleteAt has passed. */
const processDueDeletions = async (): Promise<void> => {
  const due = await store.claimDueDeletions(200).catch(() => [])
  for (const d of due) {
    await gateway.tg.deleteMessagesById(d.chatId, [d.messageId]).catch(() => { /* already gone */ })
  }
}

const sendView = async (message: Message, view: ViewMessage): Promise<void> => {
  await gateway.tg.replyText(message, viewHtml(view.text), {
    ...(view.buttons.length > 0 ? { replyMarkup: toKeyboard(view.buttons) } : {})
  }).catch(() => { /* user may have blocked the bot / no rights */ })
}

/** Report rate limit: 3 reports per reporter per 5 minutes. */
const REPORT_WINDOW_MS = 5 * 60 * 1000
const reportTimes = new Map<number, number[]>()
const reportAllowed = (userId: number): boolean => {
  const now = Date.now()
  const recent = (reportTimes.get(userId) ?? []).filter((t) => now - t < REPORT_WINDOW_MS)
  if (recent.length >= 3) { reportTimes.set(userId, recent); return false }
  recent.push(now)
  reportTimes.set(userId, recent)
  if (reportTimes.size > 2000) {
    for (const [key, times] of reportTimes) {
      if (times.every((t) => now - t >= REPORT_WINDOW_MS)) reportTimes.delete(key)
    }
  }
  return true
}

const MUTE_AFTER_VOTE_SECONDS = 24 * 60 * 60

/**
 * When the bot catches spam but can't act (not an admin / missing rights), it
 * posts one warning per chat per hour so admins know to grant rights — without
 * spamming the chat on every blocked message.
 */
const MISSING_RIGHTS_WARN_MS = 60 * 60 * 1000
const missingRightsWarned = new Map<number, number>()
const shouldWarnMissingRights = (chatId: number, errors: string[]): boolean => {
  if (!errors.some((e) => RIGHTS_ERROR_REGEX.test(e))) return false
  const now = Date.now()
  const until = missingRightsWarned.get(chatId)
  if (until && until > now) return false
  missingRightsWarned.set(chatId, now + MISSING_RIGHTS_WARN_MS)
  if (missingRightsWarned.size > 2000) {
    for (const [key, expires] of missingRightsWarned) {
      if (expires <= now) missingRightsWarned.delete(key)
    }
  }
  return true
}

/**
 * What Telegram has recently refused us here, per capability. See rights.ts —
 * the reasoning is load-bearing enough to live with its tests.
 */
const rights = new RightsMemory()

/**
 * A vote resolved to spam (instant admin ballot or community threshold):
 * remove the message, mute the author, learn the signature so the same
 * text is caught automatically next time.
 */
/**
 * Learn from a confident automatic verdict. Stored as `candidate`, never
 * `confirmed`: a self-learned signature should raise a signal on the next
 * occurrence, not decide on its own. Human confirmation still comes from votes.
 *
 * The eligibility rule lives in @lyadmin/core (`shouldAutoLearn`) so it can be
 * tested — poisoning this store would silently delete innocent messages.
 */
const learnFromAutoVerdict = async (verdict: Verdict, text: string, chatId: number): Promise<void> => {
  if (!shouldAutoLearn(verdict, text)) return
  const learnText = text.trim()
  const source = autoLearnSource(verdict)
  // Both stores get the SAME strength. They used to disagree: the signature was
  // written as a candidate while the vector went in `confirmed` with no expiry,
  // so the blunter of the two layers was the one that could convict alone.
  await signaturePort.learn(learnText, source, 'candidate', chatId)
    .catch(() => { /* learning is best-effort — never block moderation */ })
  await vectorPort?.learn(learnText, source, 'candidate')
    .catch(() => { /* best-effort */ })
  log.debug('auto_learned', { decidedBy: verdict.decidedBy, reason: verdict.reasonCode })
}

/**
 * A vote resolved to spam: remove the message, mute the author, and teach the
 * stores — but only as strongly as the human signal actually was.
 *
 * `tallyVotes` resolves instantly on a single admin ballot, which is right for
 * acting on this message and wrong as grounds for a rule that fires in every
 * chat for the next 90 days. So the ballots decide the learning strength
 * (`voteLearnStatus`), and the stores promote a candidate themselves once a
 * second, independent chat reports the same text.
 */
const enforceVoteSpam = async (vote: {
  chatId: number
  messageId: number
  targetUserId: number
  /** Full text to learn (not the truncated display preview). */
  learnText: string
  tally: { spam: number; ham: number }
}, learnSource: string): Promise<void> => {
  await gateway.moderationActions.deleteMessage(vote.chatId, vote.messageId)
    .catch(() => { /* already gone */ })
  await gateway.moderationActions.mute(vote.chatId, vote.targetUserId, MUTE_AFTER_VOTE_SECONDS)
    .catch(() => { /* may lack rights */ })
  if (vote.learnText.trim().length > 0) {
    const status = voteLearnStatus(vote.tally)
    log.info('vote_learned', {
      chatId: vote.chatId, status, spam: vote.tally.spam, ham: vote.tally.ham, source: learnSource
    })
    await signaturePort.learn(vote.learnText, learnSource, status, vote.chatId)
      .catch(() => { /* best-effort */ })
    // Seed the vector layer too, so semantic matching learns alongside
    // signatures instead of staying frozen at the v1 snapshot.
    await vectorPort?.learn(vote.learnText, learnSource, status).catch(() => { /* best-effort */ })
  }
}

/** Settings panel always renders from a fresh group document. */
const renderSettingsPanel = async (locale: Locale, chatId: number): Promise<ViewMessage> => {
  const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
  const policy = groupDocToChatPolicy(groupDoc as never)
  const settings = (groupDoc as { settings?: { locale?: string; banan?: { default?: number } } } | null)?.settings
  const bananDefaultSeconds = Number(settings?.banan?.default) || 600
  return settingsPanel(locale, chatId, {
    enabled: policy.enabled,
    preset: policy.preset,
    captchaEnabled: policy.captchaEnabled,
    votingEnabled: policy.votingEnabled,
    externalBanEnabled: policy.externalBanEnabled,
    bananDefaultSeconds,
    locale: settings?.locale ?? 'en'
  })
}

/** Language sub-screen for the settings panel (rendered from a fresh doc). */
const renderLangPanel = async (locale: Locale, chatId: number): Promise<ViewMessage> => {
  const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
  const groupLocale = (groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale ?? 'en'
  return langPanel(locale, chatId, groupLocale)
}

// ── Welcome / extras editor sub-screens (rendered fresh from Mongo) ─────────
const renderWelcomeEditor = async (locale: Locale, chatId: number): Promise<ViewMessage> => {
  const w = await store.getWelcome(chatId).catch(() => ({ enable: false, texts: [], gifs: [] }))
  return welcomeEditor(locale, chatId, { enable: w.enable, textsCount: w.texts.length, gifsCount: w.gifs.length })
}
const renderWelcomeTexts = async (locale: Locale, chatId: number, page: number): Promise<ViewMessage> => {
  const w = await store.getWelcome(chatId).catch(() => ({ texts: [] as string[] }))
  return welcomeTextsScreen(locale, chatId, w.texts, page)
}
const renderWelcomeGifs = async (locale: Locale, chatId: number, page: number): Promise<ViewMessage> => {
  const w = await store.getWelcome(chatId).catch(() => ({ gifs: [] as string[] }))
  return welcomeGifsScreen(locale, chatId, w.gifs, page)
}
const renderExtrasEditor = async (locale: Locale, chatId: number, page: number): Promise<ViewMessage> => {
  const [extras, maxExtra] = await Promise.all([
    store.getExtras(chatId).catch(() => [] as NormalizedExtra[]),
    store.getMaxExtra(chatId).catch(() => 3)
  ])
  return extrasEditor(locale, chatId, extras.map((e) => ({ name: e.name, hasMedia: e.fileId !== null })), maxExtra, page)
}

/** /mystats panel body (PM only). chatId adds the per-chat lines. */
const renderMyStats = async (locale: Locale, userId: number, chatId: number | null): Promise<string> => {
  const userDoc = await store.getUserDoc(userId).catch(() => null) as {
    globalStats?: { totalMessages?: number }
    reputation?: { score?: number; status?: 'trusted' | 'neutral' | 'suspicious' | 'restricted' }
  } | null
  const lines = [locale.stats.title, '']
  if (chatId !== null) {
    const member = await store.getMemberStats(chatId, userId).catch(() => ({ messagesCount: 0, bananCount: 0 }))
    lines.push(locale.stats.inChat(member.messagesCount))
    if (member.bananCount > 0) lines.push(locale.stats.bananCaught(member.bananCount))
  }
  lines.push(locale.stats.global(userDoc?.globalStats?.totalMessages ?? 0))
  const status = userDoc?.reputation?.status ?? 'neutral'
  lines.push(locale.stats.reputation(userDoc?.reputation?.score ?? 50, locale.stats.repStatus[status]))
  return lines.join('\n')
}

/**
 * Send the admin a live preview of the greeting a newcomer would see, using
 * their own name in the %name% slot. Best-effort — a preview must never throw.
 */
const sendWelcomePreview = async (userId: number, sampleName: string, chatId: number, locale: Locale): Promise<void> => {
  const w = await store.getWelcome(chatId).catch(() => ({ texts: [] as string[], gifs: [] as string[] }))
  if (w.texts.length === 0 && w.gifs.length === 0) {
    await gateway.tg.sendText(userId, viewHtml(locale.welcome.editor.previewEmpty)).catch(() => { /* PM closed */ })
    return
  }
  const names = `<b>${escapeName(sampleName)}</b>`
  const body = buildWelcomeGreeting(pickRandom(w.texts), names, locale.welcome.defaultGreeting(names))
  const gif = pickRandom(w.gifs)
  if (gif) {
    await replayMedia(userId, gif, { caption: body, tag: 'welcome_preview_failed', fields: { forChat: chatId } })
  } else {
    await gateway.tg.sendText(userId, viewHtml(body)).catch(() => { /* PM closed */ })
  }
}

/**
 * Capture the next PM message as input for an in-progress editor flow (add a
 * welcome text/gif, name/define an extra). After a successful add we echo the
 * refreshed list so the admin can keep adding without re-opening the menu.
 */
const handlePendingInput = async (message: Message, userId: number, entry: PendingEntry, locale: Locale): Promise<void> => {
  const reply = (text: string): Promise<void> =>
    gateway.tg.sendText(userId, viewHtml(text)).then(() => undefined).catch(() => { /* PM closed */ })
  const text = (message.text ?? '').trim()

  if (entry.type === 'welcome.text') {
    const r = await store.addWelcomeText(entry.chatId, text).catch(() => ({ added: false as const, reason: undefined }))
    await reply(r.added ? locale.welcome.editor.added : welcomeAddIssue(locale, r.reason))
    await sendView(message, await renderWelcomeTexts(locale, entry.chatId, 0))
    return
  }
  if (entry.type === 'welcome.gif') {
    const fileId = mediaFileId(message)
    if (!fileId) { await reply(locale.welcome.editor.invalidGif); return }
    const r = await store.addWelcomeGif(entry.chatId, fileId).catch(() => ({ added: false as const, reason: undefined }))
    await reply(r.added ? locale.welcome.editor.added : welcomeAddIssue(locale, r.reason))
    await sendView(message, await renderWelcomeGifs(locale, entry.chatId, 0))
    return
  }
  if (entry.type === 'extra.name') {
    const name = text.replace(/^#/, '')
    if (!/^[\p{L}\p{N}_]+$/u.test(name)) { await reply(locale.extra.editor.invalidName); return }
    // Second step of the flow: now wait for the content under this name.
    pendingInput.set(userId, { type: 'extra.content', chatId: entry.chatId, arg: name })
    await reply(locale.extra.editor.promptContent(name))
    return
  }
  if (entry.type === 'extra.content') {
    const name = entry.arg ?? ''
    const fileId = mediaFileId(message)
    if (!text && !fileId) { await reply(locale.extra.editor.cancelled); return }
    const extra: NormalizedExtra = { name, text, fileId }
    await store.saveExtra(entry.chatId, extra).catch(() => { /* best-effort */ })
    await reply(locale.extra.editor.added(name))
    await sendView(message, await renderExtrasEditor(locale, entry.chatId, 0))
    return
  }
}

/** PM entry: /start card, /help, /lang, settings deep links, editor input. */
const handlePrivateMessage = async (message: Message): Promise<void> => {
  const sender = message.sender
  if (!(sender instanceof User) || sender.isBot) return
  const text = (message.text ?? '').trim()
  const locale = await localeFor(sender.id, sender.language)

  // In-progress editor flow: this message is the input the admin was asked for.
  const pending = pendingInput.take(sender.id)
  if (pending) {
    if (/^\/cancel\b/i.test(text)) {
      await gateway.tg.sendText(sender.id, viewHtml(locale.welcome.editor.cancelled)).catch(() => { /* PM closed */ })
      return
    }
    await handlePendingInput(message, sender.id, pending, locale)
    return
  }

  if (/^\/help/.test(text)) {
    await sendView(message, helpView(locale))
    return
  }
  if (/^\/lang/.test(text)) {
    await sendView(message, langPicker(locale))
    return
  }
  if (/^\/mystats/.test(text)) {
    await sendView(message, { text: await renderMyStats(locale, sender.id, null), buttons: [] })
    return
  }
  if (!text.startsWith('/start')) return

  const payload = text.split(/\s+/)[1] ?? ''
  if (payload.startsWith('mystats_')) {
    const chatId = Number(payload.slice('mystats_'.length))
    await sendView(message, {
      text: await renderMyStats(locale, sender.id, Number.isFinite(chatId) ? chatId : null),
      buttons: []
    })
    return
  }
  if (payload.startsWith('why_')) {
    // why_<chatId>_<messageId>_<userId>; chatId is negative but holds no '_'.
    const [chatIdRaw = '', messageIdRaw = '', userIdRaw = ''] = payload.slice('why_'.length).split('_')
    const chatId = Number(chatIdRaw)
    const verdict = await recallVerdict(chatId, Number(messageIdRaw))
    if (verdict) {
      const canOverride = Number.isFinite(chatId) && await isChatAdmin(chatId, sender.id)
      await sendView(message, whyCard(locale, verdict, {
        chatId, messageId: Number(messageIdRaw), userId: Number(userIdRaw)
      }, { canOverride, facts: recallFacts(chatId, Number(messageIdRaw)) }))
    } else {
      await sendView(message, { text: locale.why.expired, buttons: [] })
    }
    return
  }
  if (payload.startsWith('settings_')) {
    const chatId = Number(payload.slice('settings_'.length))
    if (Number.isFinite(chatId) && await isChatAdmin(chatId, sender.id)) {
      await sendView(message, await renderSettingsPanel(locale, chatId))
      return
    }
  }

  await sendView(message, startCard(locale, sender.displayName, selfUsername ?? ''))
}

/** Target labels for undo notifications (memory, bounded like recentVerdicts). */
const bananLabels = new Map<string, string>()
const rememberBananLabel = (chatId: number, userId: number, label: string): void => {
  bananLabels.set(`${chatId}:${userId}`, label)
  if (bananLabels.size > 2000) {
    const firstKey = bananLabels.keys().next().value
    if (firstKey) bananLabels.delete(firstKey)
  }
}

/**
 * /banan — manual moderation with personality, v1 semantics:
 *   reply + `/banan 5m|2h|3d` → mute for that long (admins only)
 *   reply + `/banan` on an already-restricted user → lift the mute
 *   `/banan` with no reply → self-banan (anyone, the classic joke)
 */
const handleBanan = async (message: Message, chat: Chat, caller: User, arg: string | undefined): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const defaultSeconds = Number((groupDoc as { settings?: { banan?: { default?: number } } } | null)
    ?.settings?.banan?.default) || 600
  const { seconds, explicit } = parseBananDuration(arg, defaultSeconds)
  const human = formatDuration(seconds, locale.banan.units)
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })

  const replied = await gateway.fetchRepliedMessage(message)

  // Self-banan: no reply needed, anyone can sit on their own banana.
  if (!replied) {
    const ok = await gateway.moderationActions.mute(chat.id, caller.id, seconds)
      .then(() => true).catch(() => false)
    if (ok) {
      log.info('banan', { chatId: chat.id, chat: chat.title ?? undefined, userId: caller.id, user: caller.displayName, by: caller.id, kind: 'self', seconds })
      await gateway.tg.sendText(chat.id, viewHtml(locale.banan.self(escapeName(caller.displayName), human)))
        .catch(() => { /* non-fatal */ })
    }
    return
  }

  const target = replied.sender
  if (!(target instanceof User) || target.isBot || target.id === selfId) return
  if (!(await isChatAdmin(chat.id, caller.id))) return // bananing others is admin-only
  if (await isChatAdmin(chat.id, target.id)) return    // admins are banana-proof

  // No explicit duration on an already-restricted target = lift the mute.
  if (!explicit) {
    const member = await gateway.tg.getChatMember({ chatId: chat.id, userId: target.id }).catch(() => null)
    if (member?.status === 'restricted') {
      await gateway.tg.restrictChatMember({ chatId: chat.id, userId: target.id, restrictions: {} })
        .catch(() => { /* ok */ })
      await dropCommand()
      log.info('banan_lifted', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id, byName: caller.displayName })
      await gateway.tg.sendText(chat.id, viewHtml(locale.banan.lifted(escapeName(target.displayName))))
        .catch(() => { /* non-fatal */ })
      return
    }
  }

  const ok = await gateway.moderationActions.mute(chat.id, target.id, seconds)
    .then(() => true).catch(() => false)
  await dropCommand()
  if (!ok) return
  log.info('banan', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id, byName: caller.displayName, kind: 'admin', seconds })
  rememberBananLabel(chat.id, target.id, target.displayName)
  const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.banan.success(escapeName(target.displayName), human)), {
    replyMarkup: toKeyboard([[{ text: locale.banan.undoButton, data: `un:${chat.id}:${target.id}` }]])
  }).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'banan')
}

/**
 * /kick — admin removes a member (ban then unban, so they can rejoin).
 * Reply required; admins are kick-proof; the notice auto-deletes.
 */
const handleKick = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  const replied = await gateway.fetchRepliedMessage(message)
  if (!replied) {
    await sendView(message, { text: locale.kick.needReply, buttons: [] })
    return
  }
  const target = replied.sender
  if (!(target instanceof User) || target.isBot || target.id === selfId) return
  if (await isChatAdmin(chat.id, target.id)) return
  const ok = await gateway.tg.banChatMember({ chatId: chat.id, participantId: target.id })
    .then(() => gateway.tg.unbanChatMember({ chatId: chat.id, participantId: target.id }))
    .then(() => true).catch(() => false)
  await dropCommand()
  if (!ok) {
    if (shouldWarnMissingRights(chat.id, ['CHAT_ADMIN_REQUIRED'])) {
      const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.notification.missingRights)).catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'missing_rights')
    }
    return
  }
  log.info('kick', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id })
  const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.kick.success(escapeName(target.displayName)))).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'kick')
}

/**
 * /untrust — admin revokes the chat-level auto-trust an override granted.
 * The reversible counterpart to the override's addTrustedUser, closing the
 * "one wrong override protects a spammer forever" gap. Reply required.
 */
const handleUntrust = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  const replied = await gateway.fetchRepliedMessage(message)
  if (!replied) {
    await sendView(message, { text: locale.untrust.needReply, buttons: [] })
    return
  }
  const target = replied.sender
  if (!(target instanceof User)) return
  const removed = await store.removeTrustedUser(chat.id, target.id).catch(() => false)
  await dropCommand()
  log.info('untrust', {
    chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName,
    by: caller.id, byName: caller.displayName, wasTrusted: removed
  })
  const text = removed ? locale.untrust.success(escapeName(target.displayName))
    : locale.untrust.notTrusted(escapeName(target.displayName))
  const sent = await gateway.tg.sendText(chat.id, viewHtml(text)).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'untrust')
}

/**
 * /check — admin looks up the profile of the replied-to user. Builds a LIVE
 * snapshot (history + getFullUser + external-ban + join time) and renders the
 * profile card. Reply required; admin-only; the card auto-deletes.
 */
const handleCheck = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  const replied = await gateway.fetchRepliedMessage(message)
  await dropCommand()
  if (!replied || !(replied.sender instanceof User)) {
    const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.profile.checkNeedReply)).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'check')
    return
  }
  const target = replied.sender

  const userDoc = await store.getUserDoc(target.id).catch(() => null)
  const history = userDocToHistory(userDoc as never, 0)
  const profile = await fetchUserProfile(gateway.tg, target.id)
  let externalBan = history?.externalBan ?? null
  const fresh = await fetchExternalBan(target.id).catch(() => null)
  if (fresh) externalBan = mergeExternalBan({ lols: fresh.lols as never, cas: fresh.cas as never })
  const joinedDate = await gateway.tg.getChatMember({ chatId: chat.id, userId: target.id })
    .then((m) => m?.joinedDate ?? null).catch(() => null)
  const joinedAgoSeconds = joinedDate ? Math.max(0, (Date.now() - joinedDate.getTime()) / 1000) : null

  const user = buildUserSnapshot(
    target,
    history === null ? null : { ...history, avatars: profile.avatars, externalBan },
    undefined,
    { unofficialClientRisk: profile.unofficialClientRisk, joinedAgoSeconds }
  )
  const facts = factsFromSnapshot(user, {
    promoInBio: extractBioSignals(profile.bio).length > 0,
    personalChannel: profile.personalChannelId !== null
  })
  log.info('check', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id })
  const checkPolicy = groupDocToChatPolicy(await store.getGroupDoc(chat.id).catch(() => null) as never)
  const card = userProfileCard(locale, facts, {
    chatId: chat.id,
    isTrusted: checkPolicy.trustedUserIds.includes(target.id)
  })
  const sent = await gateway.tg.sendText(chat.id, viewHtml(card.text), {
    ...(card.buttons.length > 0 ? { replyMarkup: toKeyboard(card.buttons) } : {})
  }).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'check')
}

/** /del — admin deletes the replied-to message (and the command). */
const handleDelete = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const replied = await gateway.fetchRepliedMessage(message)
  const ids = [message.id, ...(replied ? [replied.id] : [])]
  await gateway.tg.deleteMessagesById(chat.id, ids).catch(() => { /* no rights */ })
  if (replied) log.info('manual_delete', { chatId: chat.id, by: caller.id, messageId: replied.id })
}

/**
 * /report: one flow for everyone. The report opens (or joins) a community
 * vote and casts the reporter's spam ballot. tallyVotes resolves an admin
 * ballot instantly, so an admin report is an immediate verdict while a
 * regular report starts the vote — no duplicate enforcement paths.
 */
const handleReport = async (message: Message, chat: Chat, reporter: User): Promise<void> => {
  const locale = await localeFor(reporter.id, reporter.language)
  // The /report command itself never stays in the chat.
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })

  const replied = await gateway.fetchRepliedMessage(message)
  if (!replied) {
    await sendView(message, { text: locale.report.needReply, buttons: [] })
    return
  }
  const target = replied.sender
  if (!(target instanceof User) || target.isBot || target.id === selfId || target.id === reporter.id) {
    await dropCommand()
    return
  }
  if (await isChatAdmin(chat.id, target.id)) {
    await sendView(message, { text: locale.report.cantReportAdmin, buttons: [] })
    return
  }
  if (!reportAllowed(reporter.id)) {
    await sendView(message, { text: locale.report.rateLimited, buttons: [] })
    return
  }

  const fullText = replied.text ?? ''
  const textPreview = fullText.slice(0, 200)
  await store.openVote({
    chatId: chat.id,
    messageId: replied.id,
    targetUserId: target.id,
    targetLabel: target.displayName,
    textPreview,
    learnText: fullText,
    openedBy: reporter.id
  }).catch(() => false) // duplicate vote → just add the ballot below

  const reporterIsAdmin = await isChatAdmin(chat.id, reporter.id)
  log.info('report', {
    chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName,
    by: reporter.id, byName: reporter.displayName, byAdmin: reporterIsAdmin, messageId: replied.id,
    text: textPreview ? textPreview.slice(0, 160) : undefined
  })
  await store.castBallot({
    chatId: chat.id, messageId: replied.id,
    userId: reporter.id, isAdmin: reporterIsAdmin, choice: 'spam'
  }).catch(() => { /* vote may have closed a moment ago */ })
  await dropCommand()

  const vote = await store.getVote(chat.id, replied.id).catch(() => null)
  if (!vote || vote['status'] !== 'open') return
  const tally = tallyVotes((vote['ballots'] ?? []) as VoteBallot[])

  if (tally.outcome === 'spam') {
    // Admin ballot resolved instantly.
    if (!(await store.closeVote(chat.id, replied.id, 'spam'))) return
    log.info('vote_resolved', { chatId: chat.id, userId: target.id, messageId: replied.id, outcome: 'spam', by: 'admin_report' })
    await enforceVoteSpam({
      chatId: chat.id, messageId: replied.id, targetUserId: target.id, learnText: fullText,
      tally: { spam: tally.spam, ham: tally.ham }
    }, 'admin_report')
    const verdict: Verdict = {
      pSpam: 0.99, action: 'mute', needsVote: false, banDurationSeconds: null, decidedBy: 'deterministic',
      ruleId: 'admin_report', signals: [], reasonCode: 'admin_report',
      reasonEvidence: textPreview || null, meta: {}
    }
    rememberVerdict(chat.id, replied.id, verdict)
    const view = compactNotification(locale, verdict, {
      chatId: chat.id, messageId: replied.id, userId: target.id, userLabel: target.displayName
    }, { botUsername: selfUsername ?? undefined })
    const sent = await gateway.tg.sendText(chat.id, viewHtml(view.text), { replyMarkup: toKeyboard(view.buttons) })
      .catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_COMPACT_MS, 'mod_event:admin_report')
    return
  }

  // Community path: post (or refresh) the vote prompt.
  const view = votePrompt(locale, {
    chatId: chat.id, messageId: replied.id,
    userLabel: target.displayName, textPreview
  }, tally)
  if (vote['promptMessageId']) {
    await gateway.tg.editMessage({
      chatId: chat.id, message: vote['promptMessageId'] as number,
      text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
    }).catch(() => { /* unchanged */ })
  } else {
    const prompt = await gateway.tg.sendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
    }).catch(() => null)
    if (prompt) await store.setVotePrompt(chat.id, replied.id, prompt.id).catch(() => { /* ok */ })
  }
}

/** A re-sendable file id from any media-bearing message, if present. */
const mediaFileId = (msg: Message): string | null => {
  const media = msg.media as { fileId?: string } | null
  return media && typeof media.fileId === 'string' ? media.fileId : null
}

/**
 * Replay media we only know by file id (extras, welcome gifs), plus — when the
 * media type cannot carry a caption (sticker, video note) — the caption as its
 * own message, so admin-authored text is never silently dropped. Returns the
 * ids that landed, for callers that auto-delete. Never throws.
 */
const replayMedia = async (
  chatId: number,
  fileId: string,
  opts: { caption?: string; replyTo?: number; tag: string; fields?: Record<string, unknown> }
): Promise<number[]> => {
  const reply = opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }
  const warn = (kind: string, err: unknown): void =>
    log.warn(opts.tag, { chatId, ...opts.fields, kind, err: String(err) })
  const sent = await gateway.sendStoredMedia(chatId, fileId, {
    ...(opts.caption === undefined ? {} : { caption: opts.caption }),
    ...reply
  }).catch((err) => { warn('media', err); return null })
  if (!sent) return []
  if (!sent.captionOmitted || opts.caption === undefined) return [sent.id]
  const follow = await gateway.tg.sendText(chatId, viewHtml(opts.caption), reply)
    .catch((err) => { warn('caption', err); return null })
  return follow ? [sent.id, follow.id] : [sent.id]
}

const pickRandom = <T>(arr: T[]): T | null => (arr.length === 0 ? null : arr[Math.floor(Math.random() * arr.length)] ?? null)

/** New members from a join service message (added, via link, or approved). */
const extractJoiners = async (message: Message): Promise<User[]> => {
  const action = message.action
  if (!action) return []
  if (action.type === 'users_added') {
    const ids = action.users.filter((id) => id !== selfId)
    if (ids.length === 0) return []
    const users = await gateway.tg.getUsers(ids).catch(() => [])
    const out: User[] = []
    for (const u of users) if (u instanceof User) out.push(u)
    return out
  }
  if (action.type === 'user_joined_link' || action.type === 'user_joined_approved') {
    return message.sender instanceof User ? [message.sender] : []
  }
  return []
}

/**
 * Avatar bytes downloaded at join time, cached so the joiner's first message
 * reuses them instead of re-downloading. Keyed by user id; coarse TTL.
 */
const avatarCache = new Map<number, { base64: string | null; expiresAt: number }>()
const AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const AVATAR_CACHE_MAX = 2000
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

type UserProfile = Awaited<ReturnType<typeof fetchUserProfile>>

const EMPTY_PROFILE: UserProfile = {
  bio: null, avatars: null, unofficialClientRisk: null, personalChannelId: null, latestAvatar: null
}

/**
 * Per-user profile cache (bio, personal channel, unofficial-client risk, avatar).
 *
 * The enrichment call used to be gated on the sender being *newish*, which made
 * the entire profile layer — including `unofficial_client_risk`, the heaviest
 * account signal in the model at 3.2 — unreachable after six messages
 * (2026-07-30 review). Caching per user instead of rationing per message keeps
 * the cost at one `getFullUser` per sender per few days while making the signals
 * reachable for everyone the pipeline actually judges.
 *
 * A day is long relative to a spam campaign and short relative to a bio edit,
 * and this is a moderation heuristic, not a source of truth.
 */
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PROFILE_CACHE_MAX = 5000
const profileCache = new Map<number, { profile: UserProfile; expiresAt: number }>()

const cachedUserProfile = async (userId: number): Promise<UserProfile> => {
  const hit = profileCache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.profile
  const profile = await fetchUserProfile(gateway.tg, userId)
  pruneExpired(profileCache, PROFILE_CACHE_MAX)
  profileCache.set(userId, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS })
  return profile
}

/**
 * Stories are a user-only MTProto surface: on a bot account
 * `stories.getPeerStories` always fails. Probing it once per message of every
 * newcomer bought nothing but latency, so the first refusal disables it.
 */
let storiesSurfaceAvailable = true

/** Evict expired entries once a cache grows past its bound (both are unbounded otherwise). */
const pruneExpired = (cache: Map<number, { expiresAt: number }>, max: number): void => {
  if (cache.size <= max) return
  const now = Date.now()
  for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key)
  // Still oversized (everything is live): drop oldest-inserted entries, which
  // Map iteration yields first.
  if (cache.size > max) {
    for (const key of cache.keys()) {
      cache.delete(key)
      if (cache.size <= max) break
    }
  }
}

/**
 * Early NSFW screen of joiners' avatars — catches porn/escort bots the moment
 * they join, even if they never post. Best-effort and fire-and-forget: it only
 * LOGS (moderation is a signal, not a verdict here); the authoritative signal
 * is emitted on the first message. Caches the avatar bytes either way.
 */
const JOIN_SCREEN_MAX = 10

const screenJoinerAvatars = async (chat: Chat, joiners: User[]): Promise<void> => {
  if (!ports.moderation) return
  // A bulk add can carry dozens of users; screening all of them sequentially
  // would stall the update loop and burn a moderation call each. The cap keeps
  // the join path bounded — the authoritative check still runs per message.
  for (const joiner of joiners.slice(0, JOIN_SCREEN_MAX)) {
    if (joiner.id === selfId) continue
    const base64 = await downloadAvatarBase64(gateway.tg, joiner.id)
    pruneExpired(avatarCache, AVATAR_CACHE_MAX)
    avatarCache.set(joiner.id, { base64, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS })
    if (!base64) continue
    try {
      const result = await ports.moderation.check('', base64)
      if (result?.flagged) {
        log.info('nsfw_avatar_join', {
          chatId: chat.id, chat: chat.title ?? undefined,
          userId: joiner.id, categories: result.categories,
          sexualScore: result.scores['sexual']
        })
      }
    } catch { /* dead key / API error surfaces via the message-path meta log */ }
  }
}

/** Greet new members when welcome is enabled (off by default). */
const handleWelcomeGreeting = async (message: Message, chat: Chat, joiners: User[]): Promise<void> => {
  if (joiners.length === 0) return
  const welcome = await store.getWelcome(chat.id).catch(() => null)
  if (!welcome || !welcome.enable) return
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
  const names = joiners.map((j) => `<b>${escapeName(j.displayName)}</b>`).join(', ')
  const template = pickRandom(welcome.texts)
  // Escape the admin-authored template before it touches the HTML parser; a
  // stray `<`/`&` used to throw inside html() and get swallowed → newcomers saw
  // nothing. %name% is our placeholder, substituted after escaping.
  const body = buildWelcomeGreeting(template, names, locale.welcome.defaultGreeting(names))
  const gif = pickRandom(welcome.gifs)
  const sentIds = gif
    ? await replayMedia(chat.id, gif, { caption: body, replyTo: message.id, tag: 'welcome_send_failed' })
    : await gateway.tg.sendText(chat.id, viewHtml(body), { replyTo: message.id })
        .then((m) => [m.id])
        .catch((err) => { log.warn('welcome_send_failed', { chatId: chat.id, kind: 'text', err: String(err) }); return [] })
  for (const id of sentIds) scheduleDelete(chat.id, id, welcome.timer * 1000, 'welcome')
  log.info('welcome', { chatId: chat.id, chat: chat.title ?? undefined, joiners: joiners.map((j) => j.id) })
}

/** Map an add-list rejection reason to a localized one-liner. */
const welcomeAddIssue = (locale: Locale, reason: string | undefined): string => {
  if (reason === 'limit') return locale.welcome.limit
  if (reason === 'duplicate') return locale.welcome.duplicate
  if (reason === 'too_long') return locale.welcome.tooLong
  return locale.welcome.saveFailed
}

/**
 * /welcome quick command (in-group shortcut; full management lives in the PM
 * editor). Adds an inline text and/or a replied gif — they are independent, so
 * a reply-with-caption saves BOTH (the earlier bug returned after the gif and
 * silently dropped the text). Bare /welcome with no content toggles greetings.
 */
const handleWelcomeCommand = async (message: Message, chat: Chat, caller: User, rest: string): Promise<void> => {
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const locale = await localeFor(caller.id, caller.language)
  const ack = async (text: string): Promise<void> => {
    const sent = await gateway.tg.replyText(message, viewHtml(text)).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'welcome_ack')
  }
  const replied = await gateway.fetchRepliedMessage(message)
  const fileId = replied ? mediaFileId(replied) : null
  const text = rest.trim()

  if (fileId || text) {
    const lines: string[] = []
    if (fileId) {
      const r = await store.addWelcomeGif(chat.id, fileId).catch(() => ({ added: false, reason: undefined }))
      lines.push(r.added ? locale.welcome.gifSet : welcomeAddIssue(locale, r.reason))
      log.info('welcome_set', { chatId: chat.id, by: caller.id, kind: 'gif', added: r.added })
    }
    if (text) {
      const r = await store.addWelcomeText(chat.id, text).catch(() => ({ added: false, reason: undefined }))
      lines.push(r.added ? locale.welcome.textSet : welcomeAddIssue(locale, r.reason))
      log.info('welcome_set', { chatId: chat.id, by: caller.id, kind: 'text', added: r.added })
    }
    await ack(lines.join('\n'))
    return
  }

  const current = await store.getWelcome(chat.id).catch(() => ({ enable: false }))
  await store.setWelcomeEnabled(chat.id, !current.enable).catch(() => { /* best-effort */ })
  log.info('welcome_toggle', { chatId: chat.id, by: caller.id, enabled: !current.enable })
  await ack(!current.enable ? locale.welcome.enabled : locale.welcome.disabled)
}

/**
 * /extra <name> (admin): reply to a message → save it under #name; no reply →
 * delete that extra. /extras → list names. Triggers fire on #name hashtags.
 */
const handleExtraCommand = async (message: Message, chat: Chat, caller: User, name: string | undefined): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  if (!name) {
    await sendView(message, { text: locale.extra.usage, buttons: [] })
    return
  }
  const cleanName = name.replace(/^#/, '')
  const replied = await gateway.fetchRepliedMessage(message)
  if (replied) {
    const extra: NormalizedExtra = { name: cleanName, text: replied.text ?? '', fileId: mediaFileId(replied) }
    await store.saveExtra(chat.id, extra).catch(() => { /* best-effort */ })
    log.info('extra_saved', { chatId: chat.id, by: caller.id, name: cleanName, hasMedia: extra.fileId !== null })
    await dropCommand()
    const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.extra.saved(cleanName))).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'extra_ack')
    return
  }
  const removed = await store.deleteExtra(chat.id, cleanName).catch(() => false)
  await dropCommand()
  if (removed) log.info('extra_deleted', { chatId: chat.id, by: caller.id, name: cleanName })
  const sent = await gateway.tg.sendText(chat.id, viewHtml(removed ? locale.extra.deleted(cleanName) : locale.extra.notFound(cleanName))).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'extra_ack')
}

const handleExtraList = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  const extras = await store.getExtras(chat.id).catch(() => [])
  const text = extras.length === 0
    ? locale.extra.listEmpty
    : [locale.extra.listTitle, '', ...extras.map((e) => `#${e.name}`)].join('\n')
  const sent = await gateway.tg.replyText(message, viewHtml(text)).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'extra_list')
}

/** Replay the extras a message's hashtags trigger (legit, non-spam messages). */
const fireExtras = async (message: Message, chat: Chat, text: string): Promise<void> => {
  const [extras, maxExtra] = await Promise.all([
    store.getExtras(chat.id).catch(() => []),
    store.getMaxExtra(chat.id).catch(() => 1)
  ])
  if (extras.length === 0) return
  for (const extra of matchExtras(text, extras, maxExtra)) {
    // extra.text is admin-authored — escape it before the HTML parser, else a
    // stray `<`/`&` throws and (previously, silently) drops the whole trigger.
    if (extra.fileId) {
      await replayMedia(chat.id, extra.fileId, {
        ...(extra.text ? { caption: escapeName(extra.text) } : {}),
        replyTo: message.id,
        tag: 'extra_send_failed',
        fields: { name: extra.name }
      })
    } else if (extra.text) {
      await gateway.tg.replyText(message, viewHtml(escapeName(extra.text)))
        .catch((err) => {
          log.warn('extra_send_failed', { chatId: chat.id, name: extra.name, kind: 'text', err: String(err) })
        })
    }
  }
}

/**
 * /top (by messages) and /top-banan (by banana count). One ephemeral
 * leaderboard message; names resolved live via MTProto so they never go stale.
 */
const handleTop = async (message: Message, chat: Chat, caller: User, kind: 'messages' | 'banan'): Promise<void> => {
  const locale = await localeFor(caller.id, caller.language)
  const rows = await store.getTopMembers(chat.id, kind, 10).catch(() => [])
  let entries: { name: string; value: number }[] = []
  if (rows.length > 0) {
    const users = await gateway.tg.getUsers(rows.map((r) => r.telegramId)).catch(() => [])
    const nameById = new Map<number, string>()
    for (const u of users) {
      if (u instanceof User) nameById.set(u.id, u.displayName)
    }
    entries = rows.map((r) => ({ name: nameById.get(r.telegramId) ?? `id${r.telegramId}`, value: r.value }))
  }
  const view = topList(locale, kind, entries)
  const sent = await gateway.tg.replyText(message, viewHtml(view.text)).catch(() => null)
  if (sent) {
    scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'cmd_top')
    scheduleDelete(chat.id, message.id, NOTIFY_TTL_TOP_MS, 'cmd_top')
  }
}

const handleMessage = async ({ message, isEdit }: IncomingMessage): Promise<void> => {
  const chat = message.chat
  if (!(chat instanceof Chat)) {
    // Private chat — only service commands live here (settings, /start).
    await handlePrivateMessage(message)
    return
  }
  if (chat.chatType !== 'supergroup' && chat.chatType !== 'group') return

  // Service messages (joins, leaves, pins…) never go through the spam
  // pipeline. Join service messages may trigger a welcome greeting.
  if (message.action) {
    const joiners = await extractJoiners(message)
    if (joiners.length > 0) {
      await handleWelcomeGreeting(message, chat, joiners)
      // Fire-and-forget: avatar download must never delay update handling.
      void screenJoinerAvatars(chat, joiners).catch(() => { /* best-effort */ })
    }
    return
  }

  const rawSender = message.sender
  /**
   * A message sent AS a channel (Telegram's "send as"), which any member who
   * owns a channel may use. The intake accepted `User` senders only, so this —
   * the one delivery method that advertises a channel by construction — was
   * never scanned at all (2026-07-30 review).
   *
   * Two things are deliberately still skipped: the linked channel's own posts
   * auto-forwarded into a discussion group (`isAutomaticForward` — moderating
   * those would mean the bot deleting the channel it serves and trying to ban
   * it from its own comment section), and anonymous admins, who are admins.
   */
  const userSender = rawSender instanceof User ? rawSender : null
  const channelSender = !userSender && rawSender instanceof Chat
    && !message.isAutomaticForward && !message.isChannelPost
    ? rawSender
    : null
  const sender = userSender ?? channelSender
  if (!sender) return
  if (sender.id === selfId) return

  const started = Date.now()

  // ── chat policy ─────────────────────────────────────────────────────
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const policy = groupDocToChatPolicy(groupDoc as never)

  // Commands are a USER surface: a channel posting "/banan" is not an admin,
  // and every handler below authorises by user id. Channel senders skip
  // straight to the spam pipeline.
  if (userSender) {
    // Group service commands. /settings never renders a panel in the chat —
    // PM deep link only; /start and /help reply with the one-line hint.
    const commandText = (message.text ?? '').trim()
    if (/^\/settings(@\w+)?$/.test(commandText) && selfUsername) {
      const locale = await localeFor(userSender.id, userSender.language)
      await sendView(message, settingsDeepLink(locale, selfUsername, chat.id))
      return
    }
    if (/^\/(start|help)(@\w+)?$/.test(commandText)) {
      const locale = await localeFor(userSender.id, userSender.language)
      await sendView(message, startGroupHint(locale))
      return
    }
    if (/^\/report(@\w+)?$/.test(commandText)) {
      await handleReport(message, chat, userSender)
      return
    }
    if (/^\/banan(@\w+)?(\s|$)/.test(commandText)) {
      await handleBanan(message, chat, userSender, commandText.split(/\s+/)[1])
      return
    }
    if (/^\/kick(@\w+)?$/.test(commandText)) {
      await handleKick(message, chat, userSender)
      return
    }
    if (/^\/untrust(@\w+)?$/.test(commandText)) {
      await handleUntrust(message, chat, userSender)
      return
    }
    if (/^\/check(@\w+)?$/.test(commandText)) {
      await handleCheck(message, chat, userSender)
      return
    }
    if (/^\/del(@\w+)?$/.test(commandText)) {
      await handleDelete(message, chat, userSender)
      return
    }
    if (/^\/mystats(@\w+)?$/.test(commandText) && selfUsername) {
      const locale = await localeFor(userSender.id, userSender.language)
      await sendView(message, {
        text: locale.stats.openInPm,
        buttons: [[{ text: locale.stats.openButton, url: `https://t.me/${selfUsername}?start=mystats_${chat.id}` }]]
      })
      return
    }
    if (/^\/top[-_]banan(@\w+)?$/.test(commandText)) {
      await handleTop(message, chat, userSender, 'banan')
      return
    }
    if (/^\/top(@\w+)?$/.test(commandText)) {
      await handleTop(message, chat, userSender, 'messages')
      return
    }
    if (/^\/ping(@\w+)?$/.test(commandText)) {
      const sent = await gateway.tg.replyText(message, '🏓 pong').catch(() => null)
      if (sent) {
        scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'cmd_ping')
        scheduleDelete(chat.id, message.id, NOTIFY_TTL_BANAN_MS, 'cmd_ping')
      }
      return
    }
    if (/^\/extras(@\w+)?$/.test(commandText)) {
      await handleExtraList(message, chat, userSender)
      return
    }
    if (/^\/extra(@\w+)?(\s|$)/.test(commandText)) {
      await handleExtraCommand(message, chat, userSender, commandText.split(/\s+/)[1])
      return
    }
    if (/^\/welcome(@\w+)?(\s|$)/.test(commandText)) {
      await handleWelcomeCommand(message, chat, userSender, commandText.replace(/^\/welcome(@\w+)?\s*/, ''))
      return
    }
  }

  // Hashtag triggers ("extras") are a standalone chat utility — they fire
  // independently of antispam state, so the `!policy.enabled` gate below must
  // not silence them, and they never depend on the moderation pipeline
  // completing. Uses raw message text (no normalize / replied fetch needed).
  const rawText = message.text ?? ''
  if (rawText.includes('#')) {
    await fireExtras(message, chat, rawText).catch(() => { /* extras are best-effort */ })
  }

  if (!policy.enabled) return

  // Telegram has refused us both message removal and sender actions here within
  // the last quarter of an hour, so there is no verdict we could act on. Keep
  // asking the admins for rights, but stop paying for enrichment and LLM calls
  // to reach a conclusion nothing can be done with. The block expires by
  // itself, so rights granted later resume moderation with no restart.
  if (rights.cannotEnforce(chat.id)) {
    log.debug('enforcement_blocked', { chatId: chat.id, chat: chat.title ?? undefined })
    if (shouldWarnMissingRights(chat.id, ['CHAT_ADMIN_REQUIRED'])) {
      const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
      const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.notification.missingRights))
        .catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'missing_rights')
      log.warn('missing_rights', {
        chatId: chat.id, chat: chat.title ?? undefined, action: 'all', blocked: true
      })
    }
    return
  }

  // ── normalize (budget call 1: replied message, only for replies) ───
  const replied = await gateway.fetchRepliedMessage(message)
  const normalized = normalizeMessage(message, { isEdit, repliedMessage: replied })

  // ── user snapshot ───────────────────────────────────────────────────
  await store.touchUser(sender.id).catch(() => { /* counters are best-effort */ })
  const userDoc = await store.getUserDoc(sender.id).catch(() => null)
  // Increments the per-chat counters and returns the pre-increment count —
  // exactly what the "new in chat" signal must see.
  const memberCount = await store.touchMember(chat.id, sender.id, normalized.text.length)
    .catch(() => 0)
  const history = userDocToHistory(userDoc as never, memberCount)

  const newish = (history?.messagesGlobal ?? 0) <= 5 || memberCount <= 3

  /**
   * Whether the sender will be waved through by the core's established-regular
   * fast path anyway (same thresholds). Mirrored here only to decide whether
   * paying for enrichment is worth it — the authoritative exempt still lives in
   * the pipeline, where hard account verdicts can cancel it.
   */
  const exemptish = (memberCount >= 10 || (history?.messagesGlobal ?? 0) >= 50) &&
    history?.firstSeenUnix != null &&
    (Date.now() / 1000 - history.firstSeenUnix) >= 7 * 86_400

  /**
   * Profile enrichment: bio, personal channel, avatar and — most importantly —
   * `unofficial_security_risk`, the heaviest single account signal we have.
   *
   * This used to be gated on `newish`, i.e. six messages of "ok" made the whole
   * profile layer unreachable for that account forever (2026-07-30 review). It
   * is now fetched for everyone the pipeline actually judges, and cached per
   * user for days: one `getFullUser` per sender per few days, not per message.
   * Channels have no such profile at all — asking would be an error, not a null.
   */
  const profile = userSender && !exemptish
    ? await cachedUserProfile(userSender.id)
    : EMPTY_PROFILE

  // Authoritative chat join time (channels.getParticipant). Only for newish
  // senders — "joined seconds ago then posted" is the pattern it catches, and
  // it costs one admin-only call. Degrades to null on anything unexpected.
  let joinedAgoSeconds: number | null = null
  if (newish) {
    const joinedDate = await gateway.tg.getChatMember({ chatId: chat.id, userId: sender.id })
      .then((m) => m?.joinedDate ?? null)
      .catch(() => null)
    if (joinedDate) joinedAgoSeconds = Math.max(0, (Date.now() - joinedDate.getTime()) / 1000)
  }

  // External ban databases (lols/CAS): one cheap HTTP call, so it runs for
  // EVERY sender (not just newish) — an established member added to CAS
  // tomorrow must still be re-checked once the TTL lapses. Persist the
  // result and use it for THIS message so a first post is caught.
  let externalBan = history?.externalBan ?? null
  if (policy.externalBanEnabled) {
    const cached = (userDoc as { externalBan?: {
      lols?: { checkedAt?: Date }; cas?: { checkedAt?: Date }
    } } | null)?.externalBan
    const now = Date.now()
    if (needsExternalRecheck(cached?.lols?.checkedAt, now) || needsExternalRecheck(cached?.cas?.checkedAt, now)) {
      const fresh = await fetchExternalBan(sender.id)
      if (fresh) {
        store.saveExternalBan(sender.id, fresh).catch(() => { /* cache is best-effort */ })
        externalBan = mergeExternalBan({
          lols: fresh.lols ?? (cached?.lols as never),
          cas: fresh.cas ?? (cached?.cas as never)
        })
      }
    }
  }

  // A channel has no registration date, bio, avatar or client to be flagged
  // for, so its snapshot carries none of them: the verdict rests on the
  // message, which is the right basis for one anyway.
  const user = userSender
    ? buildUserSnapshot(
        userSender,
        history === null ? null : { ...history, avatars: profile.avatars, externalBan },
        undefined,
        { unofficialClientRisk: profile.unofficialClientRisk, joinedAgoSeconds }
      )
    : buildChannelSnapshot(channelSender!, history)

  // Photo for LLM vision — only when a newish user posts media.
  const photoBase64 = newish && message.media?.type === 'photo'
    ? await downloadPhotoBase64(gateway.tg, message.media)
    : null

  // NSFW moderation of profile media — newish senders only (this gate is what
  // makes nsfw_avatar/nsfw_stories new-account signals). Avatar reuses bytes
  // cached at join when fresh; stories are best-effort (user-only surface).
  let avatarBase64: string | null = null
  let storyBase64: string[] = []
  // `userSender`: profile media is a user surface — a channel has none, and
  // asking would be an error rather than a null.
  if (newish && userSender && ports.moderation) {
    const cached = avatarCache.get(sender.id)
    if (cached && cached.expiresAt > Date.now()) {
      avatarBase64 = cached.base64
    } else {
      // Reuse the photo fetchUserProfile already retrieved. Calling
      // downloadAvatarBase64 here would repeat photos.getUserPhotos for the
      // same user inside one evaluation — the source of the flood waits in
      // production. Fall back to the standalone fetch only if enrichment
      // failed to produce a photo (e.g. getFullUser errored).
      avatarBase64 = profile.latestAvatar
        ? await rawPhotoToBase64(gateway.tg, profile.latestAvatar, AVATAR_MAX_BYTES)
        : await downloadAvatarBase64(gateway.tg, sender.id)
      pruneExpired(avatarCache, AVATAR_CACHE_MAX)
      avatarCache.set(sender.id, { base64: avatarBase64, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS })
    }
    if (storiesSurfaceAvailable) {
      storyBase64 = await downloadStoriesBase64(gateway.tg, sender.id)
      // downloadStoriesBase64 swallows the MTProto refusal and returns [], so
      // an empty first result is our only evidence the surface is unavailable.
      // Users legitimately have no stories, hence "probe once, then stop":
      // worst case we skip a signal that on a bot account never fires anyway.
      if (storyBase64.length === 0) {
        storiesSurfaceAvailable = false
        log.debug('stories_surface_disabled', { userId: sender.id })
      }
    }
  }

  const input: EvaluationInput = {
    message: normalized,
    chat: {
      id: chat.id,
      kind: normalized.channelComment ? 'discussion' : 'group',
      title: chat.title ?? '',
      // Best available proxy for the chat's main language until a stats layer
      // exists: the group's configured UI locale (uk/ru/en/by/tr).
      topLanguage: (groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale ?? null
    },
    user,
    // The chat's stored settings plus one capability of the running bot: the
    // policy may offer a captcha under a channel post only if it can be
    // whispered to the commenter rather than posted into the thread.
    policy: { ...policy, ephemeralCaptcha: config.ephemeralCaptcha },
    enrichment: {
      bio: profile.bio,
      personalChannelId: profile.personalChannelId,
      resolvedMentions: resolveMentionKinds(normalized.mentions),
      // Preceding chat lines — the current message is recorded after the
      // verdict so spam never pollutes its own context window.
      conversationWindow: conversationWindow.snapshot(chat.id),
      photoBase64,
      avatarBase64,
      storyBase64
    }
  }

  // ── evaluate ────────────────────────────────────────────────────────
  const verdict = await evaluateMessage(input, ports)

  // ── execute ─────────────────────────────────────────────────────────
  const senderIsAdmin = verdict.action !== 'none' && verdict.action !== 'observe'
    ? await isChatAdmin(chat.id, sender.id)
    : false

  const result = await applyVerdict(
    verdict,
    { chatId: chat.id, userId: sender.id, messageId: message.id },
    {
      senderIsAdmin,
      senderIsSelf: sender.id === selfId,
      senderIsTrusted: policy.trustedUserIds.includes(sender.id)
    },
    gateway.moderationActions
  )

  // Operational log: one line per actioned message (and per skipped action),
  // so prod moderation is fully auditable from the container logs. Carries the
  // human context (chat title, sender name/@username, message text) so a line
  // is readable on its own without cross-referencing ids.
  const logContext = {
    chat: chat.title ?? undefined,
    user: sender.displayName,
    username: sender.username ?? undefined,
    text: normalized.text ? normalized.text.slice(0, 160) : undefined,
    // Media-only spam logs no text at all, which leaves the line unreadable and
    // the verdict unreproducible (2026-07-30 12:33 was exactly that: a photo
    // job-scam at 0.99 with nothing but ids in the log).
    media: normalized.attachments.length > 0
      ? [...new Set(normalized.attachments.map((a) => a.kind))].join(',')
      : undefined,
    // A channel author is a different accountability story than a member.
    as: channelSender ? 'channel' : undefined
  }
  if (verdict.action !== 'none' && verdict.action !== 'observe') {
    log.info('moderation', {
      chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext,
      action: verdict.action, applied: result.applied, skipped: result.skippedReason ?? undefined,
      pSpam: Math.round(verdict.pSpam * 100) / 100, decidedBy: verdict.decidedBy,
      ruleId: verdict.ruleId ?? undefined, reason: verdict.reasonCode,
      signals: formatSignals(verdict.signals),
      cappedFrom: verdict.meta['cappedFrom'] ?? undefined,
      needsVote: verdict.needsVote || undefined,
      errors: result.errors.length > 0 ? result.errors : undefined,
      latencyMs: Date.now() - started
    })
    // A refusal is the authoritative statement of what we may do here; remember
    // it per capability so the next messages are not evaluated at full price
    // for nothing.
    rights.noteFailures(chat.id, result.errors)
    // Spam caught but we couldn't act → tell admins to grant rights (once/hr).
    if (!result.applied && shouldWarnMissingRights(chat.id, result.errors)) {
      const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
      const sent = await gateway.tg.sendText(chat.id, viewHtml(locale.notification.missingRights)).catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'missing_rights')
      log.warn('missing_rights', { chatId: chat.id, chat: chat.title ?? undefined, action: verdict.action })
    }
  } else if (verdict.action === 'observe') {
    log.debug('observe', {
      chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext,
      pSpam: Math.round(verdict.pSpam * 100) / 100, reason: verdict.reasonCode,
      signals: formatSignals(verdict.signals)
    })
  }

  // The message joins the chat context only if it stayed in the chat —
  // deleted spam must not poison the window for the next evaluation.
  const removed = result.applied && isEnforcementAction(verdict.action)
  if (!removed && normalized.text.trim().length > 0) {
    conversationWindow.record(chat.id, {
      authorId: normalized.channelComment ? null : sender.id,
      authorKind: normalized.channelComment ? 'channel_post' : 'user',
      textPreview: normalized.text
    })
  }

  // ── record + notify ─────────────────────────────────────────────────
  await store.recordDecision({
    chatId: chat.id,
    userId: sender.id,
    messageId: message.id,
    textPreview: normalized.text,
    verdict,
    latencyMs: Date.now() - started
  }).catch(() => { /* telemetry must never break moderation */ })

  // `captchaRequired` already means the restriction took hold (the executor
  // only claims a gate it managed to close), so no `result.applied` check: for
  // a capped verdict that is about the deleted message, not about the gate.
  if (result.captchaRequired) {
    log.info('captcha_issued', {
      chatId: chat.id, userId: sender.id, ...logContext, action: verdict.action
    })
    const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
    await deliverCaptcha(chat.id, sender.id, sender.displayName, locale)
  }

  if (result.applied && verdict.action !== 'none' && verdict.action !== 'observe' && verdict.action !== 'captcha') {
    void sessionPort.reset(chat.id, sender.id).catch(() => { /* best-effort */ })
    rememberVerdict(chat.id, message.id, verdict)
    rememberFacts(chat.id, message.id, factsFromSnapshot(user, {
      promoInBio: verdict.signals.some((s) => s.name === 'promo_in_bio'),
      personalChannel: input.enrichment.personalChannelId !== null
    }))
    void learnFromAutoVerdict(verdict, normalized.text, chat.id)
    // Forwarded spam builds the long-term reputation of its origin.
    if (normalized.forward) {
      rememberForward(chat.id, message.id, normalized.forward)
      if (verdict.pSpam >= 0.9) {
        await forwardPort.reportSpam(normalized.forward, chat.id, normalized.text || null)
          .catch(() => { /* reputation is best-effort */ })
      }
    }
    const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)

    // Grey-zone verdicts ask the community: the vote prompt (with the quoted
    // text) replaces the compact line. An admin's 👌 resolves it instantly,
    // which doubles as the override path for voted decisions.
    if (verdict.needsVote && policy.votingEnabled) {
      const opened = await store.openVote({
        chatId: chat.id, messageId: message.id, targetUserId: sender.id,
        targetLabel: sender.displayName, textPreview: normalized.text, openedBy: selfId
      }).catch(() => false)
      if (opened) {
        log.info('vote_opened', { chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext, pSpam: Math.round(verdict.pSpam * 100) / 100, reason: verdict.reasonCode })
        const view = votePrompt(locale, {
          chatId: chat.id, messageId: message.id,
          userLabel: sender.displayName, textPreview: normalized.text
        }, { spam: 0, ham: 0, outcome: 'pending' })
        const prompt = await gateway.tg.sendText(chat.id, viewHtml(view.text), {
          replyMarkup: toKeyboard(view.buttons)
        }).catch(() => null)
        if (prompt) await store.setVotePrompt(chat.id, message.id, prompt.id).catch(() => { /* ok */ })
        return
      }
    }

    const view = compactNotification(locale, verdict, {
      chatId: chat.id, messageId: message.id, userId: sender.id, userLabel: sender.displayName
    }, { botUsername: selfUsername ?? undefined })
    const sent = await gateway.tg.sendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
    }).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_COMPACT_MS, `mod_event:${verdict.action}`)
  }
}

const wireCallbacks = (): void => {
  gateway.onCallbackQuery(async (query) => {
    const { kind, parts } = parseCallback(query.dataStr ?? '')
    const locale = await localeFor(query.user.id, query.user.language)

    if (kind === 'help') {
      await query.answer({})
      await gateway.tg.sendText(query.user.id, viewHtml(helpView(locale).text))
        .catch(() => { /* PM closed */ })
      return
    }

    if (kind === 'lang') {
      const code = parts[0]
      if (code && LOCALES[code]) {
        await store.setUserLocale(query.user.id, code).catch(() => { /* non-fatal */ })
        await query.answer({ text: LOCALES[code].lang.saved })
        return
      }
      const view = langPicker(locale)
      await query.answer({})
      await gateway.tg.sendText(query.user.id, viewHtml(view.text), { replyMarkup: toKeyboard(view.buttons) })
        .catch(() => { /* PM closed */ })
      return
    }

    if (kind === 'set') {
      const [chatIdRaw = '', action = '', value = ''] = parts
      const chatId = Number(chatIdRaw)
      if (!Number.isFinite(chatId) || !(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      // Navigation only (no DB write): open the language sub-screen, or return
      // to the root panel from it.
      if (action === 'lang_open' || action === 'root') {
        const navView = action === 'lang_open'
          ? await renderLangPanel(locale, chatId)
          : await renderSettingsPanel(locale, chatId)
        await gateway.tg.editMessage({
          chatId: query.user.id, message: query.messageId,
          text: viewHtml(navView.text), replyMarkup: toKeyboard(navView.buttons)
        }).catch(() => { /* unchanged → MESSAGE_NOT_MODIFIED, fine */ })
        await query.answer({})
        return
      }

      const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
      const policy = groupDocToChatPolicy(groupDoc as never)
      if (action === 'toggle_enabled') {
        await store.updateGroupSettings(chatId, { enabled: !policy.enabled })
      } else if (action === 'toggle_captcha') {
        await store.updateGroupSettings(chatId, { captchaEnabled: !policy.captchaEnabled })
      } else if (action === 'toggle_voting') {
        await store.updateGroupSettings(chatId, { votingEnabled: !policy.votingEnabled })
      } else if (action === 'preset' && (value === 'soft' || value === 'standard' || value === 'strict')) {
        await store.updateGroupSettings(chatId, { confidenceThreshold: presetToThreshold(value) })
      } else if (action === 'toggle_bandb') {
        await store.updateGroupSettings(chatId, { banDatabase: !policy.externalBanEnabled })
      } else if (action === 'banan_default') {
        const sec = Number(value)
        if (!Number.isFinite(sec) || sec <= 0) { await query.answer({}); return }
        await store.updateGroupSettings(chatId, { bananDefault: sec })
      } else if (action === 'lang' && LOCALES[value]) {
        await store.updateGroupSettings(chatId, { locale: value })
      } else {
        await query.answer({})
        return
      }
      log.info('settings_changed', { chatId, by: query.user.id, action, value: value || undefined })
      // Every mutation re-renders the root panel — including a language pick,
      // which returns the admin from the sub-screen back to the main panel.
      const view = await renderSettingsPanel(locale, chatId)
      await gateway.tg.editMessage({
        chatId: query.user.id, message: query.messageId,
        text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
      }).catch(() => { /* unchanged content → MESSAGE_NOT_MODIFIED, fine */ })
      await query.answer(action === 'lang' ? { text: locale.settings.languageSaved } : {})
      return
    }

    // Pager labels / max-count display carry no action.
    if (kind === 'noop') { await query.answer({}); return }

    // PM welcome + extras editors. Both share chatId + admin gate + in-place
    // message edits; content input is captured via pendingInput, not callbacks.
    if (kind === 'wel' || kind === 'ext') {
      const [chatIdRaw = '', action = '', arg = ''] = parts
      const chatId = Number(chatIdRaw)
      if (!Number.isFinite(chatId) || !(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      const edit = async (view: ViewMessage): Promise<void> => {
        await gateway.tg.editMessage({
          chatId: query.user.id, message: query.messageId,
          text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
        }).catch(() => { /* unchanged content / message gone */ })
      }
      const page = Number(arg) || 0

      if (kind === 'wel') {
        if (action === 'toggle') {
          const cur = await store.getWelcome(chatId).catch(() => ({ enable: false }))
          await store.setWelcomeEnabled(chatId, !cur.enable).catch(() => { /* best-effort */ })
        } else if (action === 'tdel') {
          await store.removeWelcomeText(chatId, Number(arg)).catch(() => false)
          await edit(await renderWelcomeTexts(locale, chatId, 0))
          await query.answer({ text: locale.welcome.editor.removed }); return
        } else if (action === 'gdel') {
          await store.removeWelcomeGif(chatId, Number(arg)).catch(() => false)
          await edit(await renderWelcomeGifs(locale, chatId, 0))
          await query.answer({ text: locale.welcome.editor.removed }); return
        } else if (action === 'taddc') {
          pendingInput.set(query.user.id, { type: 'welcome.text', chatId })
          await gateway.tg.sendText(query.user.id, viewHtml(locale.welcome.editor.promptText)).catch(() => { /* PM closed */ })
          await query.answer({}); return
        } else if (action === 'gaddc') {
          pendingInput.set(query.user.id, { type: 'welcome.gif', chatId })
          await gateway.tg.sendText(query.user.id, viewHtml(locale.welcome.editor.promptGif)).catch(() => { /* PM closed */ })
          await query.answer({}); return
        } else if (action === 'preview') {
          await sendWelcomePreview(query.user.id, query.user.displayName ?? 'Alex', chatId, locale)
          await query.answer({}); return
        }
        const view = action === 'texts' ? await renderWelcomeTexts(locale, chatId, 0)
          : action === 'gifs' ? await renderWelcomeGifs(locale, chatId, 0)
          : action === 'tpage' ? await renderWelcomeTexts(locale, chatId, page)
          : action === 'gpage' ? await renderWelcomeGifs(locale, chatId, page)
          : await renderWelcomeEditor(locale, chatId)
        await edit(view)
        await query.answer({})
        return
      }

      // kind === 'ext'
      if (action === 'del') {
        const extras = await store.getExtras(chatId).catch(() => [] as NormalizedExtra[])
        const target = extras[Number(arg)]
        if (target) await store.deleteExtra(chatId, target.name).catch(() => false)
        await edit(await renderExtrasEditor(locale, chatId, 0))
        await query.answer({ text: locale.extra.editor.removed }); return
      }
      if (action === 'maxinc' || action === 'maxdec') {
        const cur = await store.getMaxExtra(chatId).catch(() => 3)
        await store.setMaxExtra(chatId, cur + (action === 'maxinc' ? 1 : -1)).catch(() => { /* best-effort */ })
        await edit(await renderExtrasEditor(locale, chatId, 0))
        await query.answer({}); return
      }
      if (action === 'addc') {
        pendingInput.set(query.user.id, { type: 'extra.name', chatId })
        await gateway.tg.sendText(query.user.id, viewHtml(locale.extra.editor.promptName)).catch(() => { /* PM closed */ })
        await query.answer({}); return
      }
      await edit(await renderExtrasEditor(locale, chatId, action === 'page' ? page : 0))
      await query.answer({})
      return
    }

    if (kind === 'tr') {
      const [chatIdRaw = '', userIdRaw = '', flagRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const userId = Number(userIdRaw)
      if (!Number.isFinite(chatId) || !Number.isFinite(userId)) { await query.answer({}); return }
      if (!(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      const makeTrusted = flagRaw === '1'
      if (makeTrusted) await store.addTrustedUser(chatId, userId).catch(() => { /* best-effort */ })
      else await store.removeTrustedUser(chatId, userId).catch(() => { /* best-effort */ })
      log.info('trust', { chatId, userId, by: query.user.id, trusted: makeTrusted })
      // Flip the card's single button to the opposite action (markup-only edit).
      const flipped = toKeyboard([[{
        text: makeTrusted ? locale.trust.untrustButton : locale.trust.button,
        data: `tr:${chatId}:${userId}:${makeTrusted ? '0' : '1'}`
      }]])
      await gateway.tg.editMessage({ chatId, message: query.messageId, replyMarkup: flipped }).catch(() => { /* card may be gone */ })
      await query.answer({ text: makeTrusted ? locale.trust.added : locale.trust.removed })
      return
    }

    if (kind === 'un') {
      const [chatIdRaw = '', userIdRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const userId = Number(userIdRaw)
      if (!(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      await gateway.tg.restrictChatMember({ chatId, userId, restrictions: {} })
        .catch(() => { /* already expired */ })
      log.info('banan_lifted', { chatId, userId, by: query.user.id, via: 'undo' })
      const label = bananLabels.get(`${chatId}:${userId}`)
      if (label) {
        await gateway.tg.editMessage({
          chatId, message: query.messageId, text: viewHtml(locale.banan.lifted(escapeName(label)))
        }).catch(() => { /* ok */ })
      } else {
        await gateway.tg.deleteMessagesById(chatId, [query.messageId]).catch(() => { /* ok */ })
      }
      await query.answer({})
      return
    }

    if (kind === 'vt') {
      const [chatIdRaw = '', messageIdRaw = '', choiceRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const messageId = Number(messageIdRaw)
      const choice = choiceRaw === 's' ? 'spam' : choiceRaw === 'h' ? 'ham' : null
      if (!Number.isFinite(chatId) || !Number.isFinite(messageId) || !choice) {
        await query.answer({})
        return
      }
      const existing = await store.getVote(chatId, messageId).catch(() => null)
      if (!existing || existing['status'] !== 'open') {
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }
      const voterIsAdmin = await isChatAdmin(chatId, query.user.id)
      await store.castBallot({ chatId, messageId, userId: query.user.id, isAdmin: voterIsAdmin, choice })
        .catch(() => { /* race with close — tally below re-checks */ })

      const vote = await store.getVote(chatId, messageId).catch(() => null)
      if (!vote) { await query.answer({}); return }
      const tally = tallyVotes((vote['ballots'] ?? []) as VoteBallot[])

      if (tally.outcome === 'pending') {
        const view = votePrompt(locale, {
          chatId, messageId,
          userLabel: String(vote['targetLabel'] ?? ''), textPreview: String(vote['textPreview'] ?? '')
        }, tally)
        await gateway.tg.editMessage({
          chatId, message: query.messageId,
          text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
        }).catch(() => { /* unchanged */ })
        await query.answer({ text: locale.vote.counted })
        return
      }

      // Resolution runs exactly once — closeVote is atomic.
      if (!(await store.closeVote(chatId, messageId, tally.outcome))) {
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }
      log.info('vote_resolved', {
        chatId, userId: Number(vote['targetUserId'] ?? 0), messageId,
        outcome: tally.outcome, spam: tally.spam, ham: tally.ham, by: 'community'
      })
      if (tally.outcome === 'spam') {
        await enforceVoteSpam({
          chatId, messageId,
          targetUserId: Number(vote['targetUserId'] ?? 0),
          learnText: String(vote['learnText'] ?? vote['textPreview'] ?? ''),
          tally: { spam: tally.spam, ham: tally.ham }
        }, 'community_vote')
      } else {
        // Ham: lift whatever the pipeline applied. Admin ham ballot carries
        // override authority → the user also becomes trusted in this chat.
        const targetUserId = Number(vote['targetUserId'] ?? 0)
        await gateway.tg.restrictChatMember({ chatId, userId: targetUserId, restrictions: {} })
          .catch(() => { /* was not muted */ })
        await gateway.tg.unbanChatMember({ chatId, participantId: targetUserId })
          .catch(() => { /* was not banned */ })
        const ballots = (vote['ballots'] ?? []) as VoteBallot[]
        if (ballots.some((b) => b.isAdmin && b.choice === 'ham')) {
          await store.addTrustedUser(chatId, targetUserId).catch(() => { /* best-effort */ })
        }
      }
      await gateway.tg.editMessage({
        chatId, message: query.messageId,
        text: viewHtml(tally.outcome === 'spam' ? locale.vote.resolvedSpam : locale.vote.resolvedHam)
      }).catch(() => { /* ok */ })
      // The resolved prompt lingers briefly as a receipt, then cleans up.
      scheduleDelete(chatId, query.messageId, NOTIFY_TTL_VOTE_RESULT_MS, 'vote_result')
      await query.answer({ text: locale.vote.counted })
      return
    }

    if (kind === 'cap') {
      const [chatIdRaw = '', userIdRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const userId = Number(userIdRaw)
      if (query.user.id !== userId) {
        await query.answer({ text: locale.captcha.notForYou })
        return
      }
      await passCaptcha(chatId, userId, locale, async (text) => {
        await query.answer(text === undefined ? {} : { text })
      })
      return
    }

    if (kind === 'why') {
      const [chatId = '', messageId = ''] = parts
      const verdict = await recallVerdict(Number(chatId), Number(messageId))
      await query.answer({
        text: verdict ? whyView(locale, verdict).slice(0, 200) : '…',
        alert: true
      })
      return
    }

    if (kind === 'ovr') {
      const [chatIdRaw = '', messageIdRaw = '', userIdRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      if (!(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      const verdict = await recallVerdict(chatId, Number(messageIdRaw))
      await store.recordOverride({
        chatId,
        messageId: Number(messageIdRaw),
        userId: Number(userIdRaw),
        adminId: query.user.id,
        verdict: verdict ?? { decidedBy: 'error', ruleId: null, reasonCode: 'unknown' }
      }).catch(() => { /* keep going — unban matters more */ })
      // Lift restrictions (empty restrictions object = unrestrict).
      await gateway.tg.restrictChatMember({
        chatId, userId: Number(userIdRaw), restrictions: {}
      }).catch(() => { /* may not have been muted */ })
      await gateway.tg.unbanChatMember({ chatId, participantId: Number(userIdRaw) })
        .catch(() => { /* may not have been banned */ })
      // The admin vouched — auto-trust this user in this chat from now on.
      await store.addTrustedUser(chatId, Number(userIdRaw))
        .catch(() => { /* trust write is best-effort */ })
      // A forwarded FP also earns its origin a clean point (v1 2:1 math).
      const forward = recentForwards.get(`${chatIdRaw}:${messageIdRaw}`)
      if (forward) {
        await forwardPort.reportClean(forward).catch(() => { /* best-effort */ })
        recentForwards.delete(`${chatIdRaw}:${messageIdRaw}`)
      }
      recentVerdicts.delete(`${chatIdRaw}:${messageIdRaw}`)
      log.info('override', {
        chatId, userId: Number(userIdRaw), messageId: Number(messageIdRaw), by: query.user.id,
        wasDecidedBy: verdict?.decidedBy, wasReason: verdict?.reasonCode
      })
      await query.answer({ text: locale.notification.overrideDone })
      // Remove the notification message itself — keep chats clean.
      await gateway.tg.deleteMessagesById(chatId, [query.messageId]).catch(() => { /* ok */ })
    }
  })

  // Taps on a whispered prompt arrive as their own update type, so they need
  // their own subscription. The captcha is the only thing sent ephemerally, and
  // anything else reaching here is not something we put on screen.
  gateway.onEphemeralCallbackQuery(async (query) => {
    const { kind, parts } = parseCallback(query.dataStr)
    if (kind !== 'cap') return
    const [chatIdRaw = '', userIdRaw = ''] = parts
    const chatId = Number(chatIdRaw)
    const userId = Number(userIdRaw)
    // A whisper is delivered to one user, but the button data still travels
    // through the client — so the identity check is not redundant.
    if (query.user.id !== userId) return
    const locale = await localeFor(query.user.id, query.user.language)
    await passCaptcha(chatId, userId, locale, async (text) => {
      await gateway.tg.answerCallbackQuery(query.id, text === undefined ? {} : { text })
    })
  })
}

const main = async (): Promise<void> => {
  await store.connect(config.mongoUri)
  gateway.onMessage(handleMessage)
  gateway.onError((err) => log.error('handler_error', { err: err instanceof Error ? err : String(err) }))
  wireCallbacks()
  const self = await gateway.start()
  selfId = self.id
  selfUsername = self.username
  log.info('started', { username: self.username, id: self.id })

  // Populate the Telegram command menu (slash button + autocomplete). Fire and
  // forget — it self-swallows errors and must not delay readiness.
  void registerBotCommands(gateway.tg)

  // Clear deletions that came due while we were down, then sweep periodically
  // as the backstop for the in-memory timers.
  await processDueDeletions()
  const sweepTimer = setInterval(() => { void processDueDeletions() }, 60 * 1000)
  sweepTimer.unref?.()

  const shutdown = async (): Promise<void> => {
    log.info('shutdown')
    await gateway.stop().catch(() => { /* ignore */ })
    await store.close().catch(() => { /* ignore */ })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// A single failed promise must never take the moderation bot down.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { err: reason instanceof Error ? reason : String(reason) })
})
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { err })
})

main().catch((err) => {
  log.error('fatal', { err })
  process.exit(1)
})
