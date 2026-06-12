/**
 * Composition root: wires core (pure pipeline) + adapters (mtcute) +
 * data (Mongo/Qdrant/LLM) + ui (views). No business logic lives here —
 * only assembly, the per-message flow, and callback handling.
 */
import { BotKeyboard, Chat, User, html, type Message } from '@mtcute/node'
import {
  evaluateMessage,
  type EvaluationInput, type PipelinePorts, type Verdict
} from '@lyadmin/core'
import {
  TelegramGateway, applyVerdict, buildUserSnapshot, normalizeMessage,
  fetchUserProfile, downloadPhotoBase64,
  type IncomingMessage
} from '@lyadmin/adapters'
import {
  MongoStore, MongoSignaturePort, QdrantVectorPort, OpenAiModerationPort,
  OpenRouterLlmPort, MemoryVelocityPort, MemorySessionPort,
  groupDocToChatPolicy, presetToThreshold, userDocToHistory
} from '@lyadmin/data'
import {
  captchaPrompt, compactNotification, helpView, langPicker, parseCallback,
  resolveLocale, settingsDeepLink, settingsPanel, startCard, startGroupHint,
  whyView, LOCALES, type Locale, type ViewMessage
} from '@lyadmin/ui'
import { loadConfig } from './config.js'

const config = loadConfig()

const store = new MongoStore()
const sessionPort = new MemorySessionPort()
const velocityPort = new MemoryVelocityPort()

const buildPorts = (): PipelinePorts => {
  const ports: PipelinePorts = {
    signatures: new MongoSignaturePort(store),
    velocity: velocityPort,
    session: sessionPort
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

const sendView = async (message: Message, view: ViewMessage): Promise<void> => {
  await gateway.tg.replyText(message, viewHtml(view.text), {
    ...(view.buttons.length > 0 ? { replyMarkup: toKeyboard(view.buttons) } : {})
  }).catch(() => { /* user may have blocked the bot / no rights */ })
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
  if (!text.startsWith('/start')) return

  const payload = text.split(/\s+/)[1] ?? ''
  if (payload.startsWith('settings_')) {
    const chatId = Number(payload.slice('settings_'.length))
    if (Number.isFinite(chatId) && await isChatAdmin(chatId, sender.id)) {
      await sendView(message, await renderSettingsPanel(locale, chatId))
      return
    }
  }

  await sendView(message, startCard(locale, sender.displayName, selfUsername ?? ''))
}

const handleMessage = async ({ message, isEdit }: IncomingMessage): Promise<void> => {
  const chat = message.chat
  if (!(chat instanceof Chat)) {
    // Private chat — only service commands live here (settings, /start).
    await handlePrivateMessage(message)
    return
  }
  if (chat.chatType !== 'supergroup' && chat.chatType !== 'group') return
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

  if (!policy.enabled) return

  // ── normalize (budget call 1: replied message, only for replies) ───
  const replied = await gateway.fetchRepliedMessage(message)
  const normalized = normalizeMessage(message, { isEdit, repliedMessage: replied })

  // ── user snapshot ───────────────────────────────────────────────────
  await store.touchUser(sender.id).catch(() => { /* counters are best-effort */ })
  const userDoc = await store.getUserDoc(sender.id).catch(() => null)
  const memberCount = await store.getMemberMessageCount(
    (groupDoc as { _id?: unknown } | null)?._id, sender.id
  ).catch(() => 0)
  const history = userDocToHistory(userDoc as never, memberCount)

  const newish = (history?.messagesGlobal ?? 0) <= 5 || memberCount <= 3
  // Budget calls 2-3: profile enrichment only for newish senders.
  const profile = newish
    ? await fetchUserProfile(gateway.tg, sender.id)
    : { bio: null, avatars: null, unofficialClientRisk: null }

  const user = buildUserSnapshot(sender, history === null ? null : { ...history, avatars: profile.avatars }, undefined, {
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
      topLanguage: null
    },
    user,
    policy,
    enrichment: {
      bio: profile.bio,
      resolvedMentions: [],
      conversationWindow: [],
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
    const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
    const view = compactNotification(locale, verdict, {
      chatId: chat.id, messageId: message.id, userId: sender.id, userLabel: sender.displayName
    })
    await gateway.tg.sendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
    }).catch(() => { /* notification failure is non-fatal */ })
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
      const view = await renderSettingsPanel(locale, chatId)
      await gateway.tg.editMessage({
        chatId: query.user.id, message: query.messageId,
        text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
      }).catch(() => { /* unchanged content → MESSAGE_NOT_MODIFIED, fine */ })
      await query.answer({})
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
      recentVerdicts.delete(`${chatIdRaw}:${messageIdRaw}`)
      await query.answer({ text: locale.notification.overrideDone })
      // Remove the notification message itself — keep chats clean.
      await gateway.tg.deleteMessagesById(chatId, [query.messageId]).catch(() => { /* ok */ })
    }
  })
}

const main = async (): Promise<void> => {
  await store.connect(config.mongoUri)
  gateway.onMessage(handleMessage)
  wireCallbacks()
  const self = await gateway.start()
  selfId = self.id
  selfUsername = self.username
  console.log(`[bot] started as @${self.username} (${self.id})`)

  const shutdown = async (): Promise<void> => {
    console.log('[bot] shutting down…')
    await gateway.stop().catch(() => { /* ignore */ })
    await store.close().catch(() => { /* ignore */ })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// A single failed promise must never take the moderation bot down.
process.on('unhandledRejection', (reason) => {
  console.error('[bot] unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[bot] uncaught exception:', err)
})

main().catch((err) => {
  console.error('[bot] fatal:', err)
  process.exit(1)
})
