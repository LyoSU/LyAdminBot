/**
 * Composition root: wires core (pure pipeline) + adapters (mtcute) +
 * data (Mongo/Qdrant/LLM) + ui (views). No business logic lives here —
 * only assembly, the per-message flow, and callback handling.
 */
import { BotKeyboard, Chat, User, html, type Message } from '@mtcute/node'
import {
  evaluateMessage, tallyVotes,
  type EvaluationInput, type ForwardOrigin, type PipelinePorts,
  type Verdict, type VoteBallot
} from '@lyadmin/core'
import {
  TelegramGateway, applyVerdict, buildUserSnapshot, normalizeMessage,
  fetchUserProfile, downloadPhotoBase64,
  fetchExternalBan, needsExternalRecheck, resolveMentionKinds,
  type IncomingMessage
} from '@lyadmin/adapters'
import {
  MongoStore, MongoSignaturePort, MongoForwardPort, QdrantVectorPort,
  OpenAiModerationPort, OpenRouterLlmPort, MemoryVelocityPort,
  MemorySessionPort, MemoryConversationWindow,
  matchExtras,
  groupDocToChatPolicy, presetToThreshold, userDocToHistory, mergeExternalBan,
  type NormalizedExtra
} from '@lyadmin/data'
import {
  captchaPrompt, compactNotification, escapeHtml as escapeName, helpView,
  langPicker, parseCallback, resolveLocale, settingsDeepLink, settingsPanel,
  startCard, startGroupHint, topList, votePrompt, whyCard, whyView,
  LOCALES, type Locale, type ViewMessage
} from '@lyadmin/ui'
import { loadConfig } from './config.js'
import { formatDuration, parseBananDuration } from './duration.js'
import { log } from './logger.js'

const config = loadConfig()

const store = new MongoStore()
const sessionPort = new MemorySessionPort()
const velocityPort = new MemoryVelocityPort()
const signaturePort = new MongoSignaturePort(store)
const forwardPort = new MongoForwardPort(store)
const conversationWindow = new MemoryConversationWindow()

const buildPorts = (): PipelinePorts => {
  const ports: PipelinePorts = {
    signatures: signaturePort,
    velocity: velocityPort,
    session: sessionPort,
    forwards: forwardPort
  }
  if (config.qdrantUrl && config.openaiApiKey) {
    ports.vectors = new QdrantVectorPort({
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey ?? undefined,
      openaiApiKey: config.openaiApiKey
    })
  }
  if (config.openaiApiKey) {
    ports.moderation = new OpenAiModerationPort(config.openaiApiKey)
  }
  if (config.openrouterApiKey) {
    ports.llm = new OpenRouterLlmPort({
      apiKey: config.openrouterApiKey,
      cheapModel: config.llmCheapModel,
      strongModel: config.llmStrongModel
    }, store)
  }
  return ports
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
 */
const CAPTCHA_TTL_MS = 10 * 60 * 1000
const pendingCaptchas = new Map<string, number>() // chatId:userId → expiresMs
const issueCaptcha = (chatId: number, userId: number): void => {
  if (pendingCaptchas.size > 2000) {
    for (const [key, expires] of pendingCaptchas) {
      if (expires <= Date.now()) pendingCaptchas.delete(key)
    }
  }
  pendingCaptchas.set(`${chatId}:${userId}`, Date.now() + CAPTCHA_TTL_MS)
}
const consumeCaptcha = (chatId: number, userId: number): boolean => {
  const key = `${chatId}:${userId}`
  const expires = pendingCaptchas.get(key)
  if (expires === undefined) return false
  pendingCaptchas.delete(key)
  return expires > Date.now()
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
const RIGHTS_ERROR_REGEX = /ADMIN_REQUIRED|FORBIDDEN|not enough rights|RIGHT/i
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
 * A vote resolved to spam (instant admin ballot or community threshold):
 * remove the message, mute the author, learn the signature so the same
 * text is caught automatically next time.
 */
const enforceVoteSpam = async (vote: {
  chatId: number
  messageId: number
  targetUserId: number
  textPreview: string
}, learnSource: string): Promise<void> => {
  await gateway.moderationActions.deleteMessage(vote.chatId, vote.messageId)
    .catch(() => { /* already gone */ })
  await gateway.moderationActions.mute(vote.chatId, vote.targetUserId, MUTE_AFTER_VOTE_SECONDS)
    .catch(() => { /* may lack rights */ })
  if (vote.textPreview.trim().length > 0) {
    await signaturePort.learn(vote.textPreview, learnSource, 'confirmed').catch(() => { /* best-effort */ })
  }
}

/** Settings panel always renders from a fresh group document. */
const renderSettingsPanel = async (locale: Locale, chatId: number): Promise<ViewMessage> => {
  const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
  const policy = groupDocToChatPolicy(groupDoc as never)
  return settingsPanel(locale, chatId, {
    enabled: policy.enabled,
    preset: policy.preset,
    captchaEnabled: policy.captchaEnabled,
    votingEnabled: policy.votingEnabled
  })
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

/** PM entry: /start card, /help, /lang, settings deep links. */
const handlePrivateMessage = async (message: Message): Promise<void> => {
  const sender = message.sender
  if (!(sender instanceof User) || sender.isBot) return
  const text = (message.text ?? '').trim()
  const locale = await localeFor(sender.id, sender.language)

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
    const verdict = recentVerdicts.get(`${chatId}:${Number(messageIdRaw)}`)
    if (verdict) {
      const canOverride = Number.isFinite(chatId) && await isChatAdmin(chatId, sender.id)
      await sendView(message, whyCard(locale, verdict, {
        chatId, messageId: Number(messageIdRaw), userId: Number(userIdRaw)
      }, { canOverride }))
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

  const textPreview = (replied.text ?? '').slice(0, 200)
  await store.openVote({
    chatId: chat.id,
    messageId: replied.id,
    targetUserId: target.id,
    targetLabel: target.displayName,
    textPreview,
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
      chatId: chat.id, messageId: replied.id, targetUserId: target.id, textPreview
    }, 'admin_report')
    const verdict: Verdict = {
      pSpam: 0.99, action: 'mute', needsVote: false, decidedBy: 'deterministic',
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

/** Greet new members when welcome is enabled (off by default). */
const handleWelcomeGreeting = async (message: Message, chat: Chat, joiners: User[]): Promise<void> => {
  if (joiners.length === 0) return
  const welcome = await store.getWelcome(chat.id).catch(() => null)
  if (!welcome || !welcome.enable) return
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
  const names = joiners.map((j) => `<b>${escapeName(j.displayName)}</b>`).join(', ')
  const template = pickRandom(welcome.texts)
  const body = template ? template.replace(/%name%/g, names) : locale.welcome.defaultGreeting(names)
  const gif = pickRandom(welcome.gifs)
  const sent = gif
    ? await gateway.tg.sendMedia(chat.id, gif, { replyTo: message.id, caption: viewHtml(body) }).catch(() => null)
    : await gateway.tg.sendText(chat.id, viewHtml(body), { replyTo: message.id }).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, welcome.timer * 1000, 'welcome')
  log.info('welcome', { chatId: chat.id, chat: chat.title ?? undefined, joiners: joiners.map((j) => j.id) })
}

/** /welcome: toggle, or set text (`/welcome <text>`), or set gif (reply). */
const handleWelcomeCommand = async (message: Message, chat: Chat, caller: User, rest: string): Promise<void> => {
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const locale = await localeFor(caller.id, caller.language)
  const ack = async (text: string): Promise<void> => {
    const sent = await gateway.tg.replyText(message, viewHtml(text)).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'welcome_ack')
  }
  const replied = await gateway.fetchRepliedMessage(message)
  if (replied) {
    const fileId = mediaFileId(replied)
    if (fileId) {
      await store.setWelcomeGif(chat.id, fileId).catch(() => { /* best-effort */ })
      log.info('welcome_set', { chatId: chat.id, by: caller.id, kind: 'gif' })
      await ack(locale.welcome.gifSet)
      return
    }
  }
  if (rest.trim().length > 0) {
    await store.setWelcomeText(chat.id, rest.trim()).catch(() => { /* best-effort */ })
    log.info('welcome_set', { chatId: chat.id, by: caller.id, kind: 'text' })
    await ack(locale.welcome.textSet)
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
    if (extra.fileId) {
      await gateway.tg.sendMedia(chat.id, extra.fileId, {
        replyTo: message.id,
        ...(extra.text ? { caption: viewHtml(extra.text) } : {})
      }).catch(() => { /* file id may have expired — skip */ })
    } else if (extra.text) {
      await gateway.tg.replyText(message, viewHtml(extra.text)).catch(() => { /* non-fatal */ })
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
    if (joiners.length > 0) await handleWelcomeGreeting(message, chat, joiners)
    return
  }

  const sender = message.sender
  if (!(sender instanceof User)) return // anonymous admins / channel posts
  if (sender.id === selfId) return

  const started = Date.now()

  // ── chat policy ─────────────────────────────────────────────────────
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const policy = groupDocToChatPolicy(groupDoc as never)

  // Group service commands. /settings never renders a panel in the chat —
  // PM deep link only; /start and /help reply with the one-line hint.
  const commandText = (message.text ?? '').trim()
  if (/^\/settings(@\w+)?$/.test(commandText) && selfUsername) {
    const locale = await localeFor(sender.id, sender.language)
    await sendView(message, settingsDeepLink(locale, selfUsername, chat.id))
    return
  }
  if (/^\/(start|help)(@\w+)?$/.test(commandText)) {
    const locale = await localeFor(sender.id, sender.language)
    await sendView(message, startGroupHint(locale))
    return
  }
  if (/^\/report(@\w+)?$/.test(commandText)) {
    await handleReport(message, chat, sender)
    return
  }
  if (/^\/banan(@\w+)?(\s|$)/.test(commandText)) {
    await handleBanan(message, chat, sender, commandText.split(/\s+/)[1])
    return
  }
  if (/^\/kick(@\w+)?$/.test(commandText)) {
    await handleKick(message, chat, sender)
    return
  }
  if (/^\/del(@\w+)?$/.test(commandText)) {
    await handleDelete(message, chat, sender)
    return
  }
  if (/^\/mystats(@\w+)?$/.test(commandText) && selfUsername) {
    const locale = await localeFor(sender.id, sender.language)
    await sendView(message, {
      text: locale.stats.openInPm,
      buttons: [[{ text: locale.stats.openButton, url: `https://t.me/${selfUsername}?start=mystats_${chat.id}` }]]
    })
    return
  }
  if (/^\/top[-_]banan(@\w+)?$/.test(commandText)) {
    await handleTop(message, chat, sender, 'banan')
    return
  }
  if (/^\/top(@\w+)?$/.test(commandText)) {
    await handleTop(message, chat, sender, 'messages')
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
    await handleExtraList(message, chat, sender)
    return
  }
  if (/^\/extra(@\w+)?(\s|$)/.test(commandText)) {
    await handleExtraCommand(message, chat, sender, commandText.split(/\s+/)[1])
    return
  }
  if (/^\/welcome(@\w+)?(\s|$)/.test(commandText)) {
    await handleWelcomeCommand(message, chat, sender, commandText.replace(/^\/welcome(@\w+)?\s*/, ''))
    return
  }

  if (!policy.enabled) return

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
  // Budget calls 2-3: profile enrichment only for newish senders.
  const profile = newish
    ? await fetchUserProfile(gateway.tg, sender.id)
    : { bio: null, avatars: null, unofficialClientRisk: null }

  // External ban databases (lols/CAS): refresh a newish sender past the TTL,
  // persist the result, and use it for THIS message so a first post is caught.
  let externalBan = history?.externalBan ?? null
  if (newish && policy.externalBanEnabled) {
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

  const user = buildUserSnapshot(sender, history === null ? null : { ...history, avatars: profile.avatars, externalBan }, undefined, {
    unofficialClientRisk: profile.unofficialClientRisk
  })

  // Photo for LLM vision — only when a newish user posts media.
  const photoBase64 = newish && message.media?.type === 'photo'
    ? await downloadPhotoBase64(gateway.tg, message.media)
    : null

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
    policy,
    enrichment: {
      bio: profile.bio,
      resolvedMentions: resolveMentionKinds(normalized.mentions),
      // Preceding chat lines — the current message is recorded after the
      // verdict so spam never pollutes its own context window.
      conversationWindow: conversationWindow.snapshot(chat.id),
      photoBase64
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
    text: normalized.text ? normalized.text.slice(0, 160) : undefined
  }
  if (verdict.action !== 'none' && verdict.action !== 'observe') {
    log.info('moderation', {
      chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext,
      action: verdict.action, applied: result.applied, skipped: result.skippedReason ?? undefined,
      pSpam: Math.round(verdict.pSpam * 100) / 100, decidedBy: verdict.decidedBy,
      ruleId: verdict.ruleId ?? undefined, reason: verdict.reasonCode,
      needsVote: verdict.needsVote || undefined,
      errors: result.errors.length > 0 ? result.errors : undefined,
      latencyMs: Date.now() - started
    })
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
      pSpam: Math.round(verdict.pSpam * 100) / 100, reason: verdict.reasonCode
    })
  }

  // The message joins the chat context only if it stayed in the chat —
  // deleted spam must not poison the window for the next evaluation.
  const removed = result.applied && (verdict.action === 'delete' || verdict.action === 'mute' || verdict.action === 'ban')
  if (!removed && normalized.text.trim().length > 0) {
    conversationWindow.record(chat.id, {
      authorKind: normalized.channelComment ? 'channel_post' : 'user',
      textPreview: normalized.text
    })
    // Hashtag triggers fire only on messages that survived moderation.
    if (normalized.text.includes('#')) await fireExtras(message, chat, normalized.text)
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

  if (result.captchaRequired && result.applied) {
    issueCaptcha(chat.id, sender.id)
    log.info('captcha_issued', { chatId: chat.id, userId: sender.id, ...logContext })
    const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
    const view = captchaPrompt(locale, {
      chatId: chat.id, userId: sender.id, userLabel: sender.displayName
    })
    await gateway.tg.sendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
    }).catch(() => { /* prompt failure: the restriction simply expires on its own */ })
  }

  if (result.applied && verdict.action !== 'none' && verdict.action !== 'observe' && verdict.action !== 'captcha') {
    sessionPort.reset(chat.id, sender.id)
    rememberVerdict(chat.id, message.id, verdict)
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
      } else {
        await query.answer({})
        return
      }
      log.info('settings_changed', { chatId, by: query.user.id, action, value: value || undefined })
      const view = await renderSettingsPanel(locale, chatId)
      await gateway.tg.editMessage({
        chatId: query.user.id, message: query.messageId,
        text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
      }).catch(() => { /* unchanged content → MESSAGE_NOT_MODIFIED, fine */ })
      await query.answer({})
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
          textPreview: String(vote['textPreview'] ?? '')
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
      // Forgeable payload: lift the gate only if WE issued it, and only once.
      if (!consumeCaptcha(chatId, userId)) {
        await query.answer({})
        return
      }
      // One tap proves liveness: lift the gate restriction, drop the prompt.
      await gateway.tg.restrictChatMember({ chatId, userId, restrictions: {} })
        .catch(() => { /* window may have expired already */ })
      log.info('captcha_passed', { chatId, userId })
      await query.answer({ text: locale.captcha.passed })
      await gateway.tg.deleteMessagesById(chatId, [query.messageId]).catch(() => { /* ok */ })
      return
    }

    if (kind === 'why') {
      const [chatId = '', messageId = ''] = parts
      const verdict = recentVerdicts.get(`${chatId}:${messageId}`)
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
      const verdict = recentVerdicts.get(`${chatIdRaw}:${messageIdRaw}`)
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
