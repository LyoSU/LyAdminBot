/**
 * Composition root: wires core (pure pipeline) + adapters (mtcute) +
 * data (Mongo/Qdrant/LLM) + ui (views). No business logic lives here —
 * only assembly, the per-message flow, and callback handling.
 */
import { BotKeyboard, Chat, User, html, type Message } from '@mtcute/node'
import {
  evaluateMessage, tallyVotes, extractBioSignals, BIO_PROMO_SIGNALS,
  isEnforcementAction, countsAsDetection,
  countsAgainstSender,
  shouldAutoLearn, autoLearnSource, VOTE_LEARN_STATUS, conversationLineFor, nsfwProfileHit,
  voterRoster, voteEligibility, voteMayRecordDetection, needsRestitution, restitutionLiftsRestrictions,
  type VoterStanding,
  classifyUrl, strongestTelegramLink, removesSender, truncate, mediaCategoryOf,
  BURST_GREY_FLOOR, ESTABLISHED_MIN_TENURE_DAYS,
  type ChannelPreview, type EditBaseline, type EvaluationInput, type ForwardOrigin,
  type MediaCategory, type PipelinePorts, type UserSnapshot, type Verdict, type VoteBallot
} from '@lyadmin/core'
import {
  TelegramGateway, applyVerdict, buildUserSnapshot, buildChannelSnapshot, normalizeMessage,
  editBaselineOf,
  fetchUserProfile, downloadPhotoBase64, downloadAvatarBase64, downloadStoriesBase64, rawPhotoToBase64,
  fetchExternalBan, sourcesToQuery, resolveMentionKinds, shouldScanChannelSender,
  createChatDescriptionCache, fetchChatDescription, createTmePreviewResolver,
  type ExternalBanCacheView, type IncomingMessage
} from '@lyadmin/adapters'
import {
  MongoStore, MongoSignaturePort, MongoForwardPort, QdrantVectorPort,
  OpenAiModerationPort, OpenRouterLlmPort,
  PersistentVelocityPort, PersistentSessionPort, PersistentBurstPort, MemoryConversationWindow,
  matchExtras, buildWelcomeGreeting, PendingInput,
  groupDocToChatPolicy, presetToThreshold, userDocToHistory, mergeExternalBan,
  type NormalizedExtra, type PendingEntry
} from '@lyadmin/data'
import {
  captchaPrompt, compactNotification, escapeHtml as escapeName, helpView,
  langPanel, langPicker, parseCallback, resolveLocale, settingsDeepLink, settingsPanel,
  nameIsPromo, startCard, startGroupHint, topList, userMention, userProfileCard, votePrompt, voteResult,
  voterListView, whyCard, whyView,
  welcomeEditor, welcomeTextsScreen, welcomeGifsScreen, extrasEditor,
  LOCALES, type Locale, type UserFacts, type ViewMessage
} from '@lyadmin/ui'
import { loadConfig } from './config.js'
import { registerBotCommands } from './commands.js'
import { formatDuration, parseBananDuration } from './duration.js'
import { formatSignals, log } from './logger.js'
import { RightsMemory, RIGHTS_ERROR_REGEX } from './rights.js'
import { LlmHealth } from './llm-health.js'
import { MemberFactsCache, type MemberFacts } from './member-facts.js'
import { JOIN_WINDOW_MS, JoinRateTracker } from './join-rate.js'
import { IncidentTracker, SenderMessageLog, incidentPowerFor, type Incident } from './incident.js'
import { ArrivalLog, arrivalMessageIds } from './arrival-log.js'

const config = loadConfig()

const store = new MongoStore()
// Velocity/session live in Mongo (TTL-expired) so the flood window and
// abstain accumulation survive restarts and are shared across instances.
const sessionPort = new PersistentSessionPort(store)
// A sender's recent judged messages, with what the pipeline made of each — the
// one input that describes a run rather than a message. See PersistentBurstPort.
const burstPort = new PersistentBurstPort(store)
const velocityPort = new PersistentVelocityPort(store)
const signaturePort = new MongoSignaturePort(store)
const forwardPort = new MongoForwardPort(store)
const conversationWindow = new MemoryConversationWindow()
// Transient per-admin input state for the PM welcome/extras editor. Memory-only
// on purpose — a half-finished "add" is not worth persisting across restarts.
const pendingInput = new PendingInput()
// Whether the classifier is reachable, which the per-message failure warning
// cannot say. Deliberately not persisted: an outage that ended while we were
// down is not an outage, and the first live call re-establishes the truth.
const llmHealth = new LlmHealth()
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
    burst: burstPort,
    forwards: forwardPort
  }
  if (vectorPort) ports.vectors = vectorPort
  if (config.openaiApiKey) {
    ports.moderation = new OpenAiModerationPort(config.openaiApiKey)
  }
  if (config.openrouterApiKey) {
    ports.llm = new OpenRouterLlmPort({
      apiKey: config.openrouterApiKey,
      model: config.llmModel,
      requireSchema: config.llmRequireSchema,
      ...(config.llmTemperature !== null ? { temperature: config.llmTemperature } : {}),
      briefingProvider: campaignBriefing,
      // A classifier that answers nothing is not a neutral event: the pipeline
      // then decides on whatever weaker stage spoke, and a grey-zone message
      // nothing else flagged ends at `observe`, which writes no other line. So
      // this warning is both the diagnosis and the only evidence the call
      // happened — 2026-08-07 it was the whole record of a total outage.
      onFailure: ({ model, reason, status, detail, chatId, messageId }) => {
        log.warn('llm_unanswered', {
          chatId, messageId, model, reason,
          ...(status !== null ? { status } : {}),
          ...(detail !== undefined ? { detail } : {})
        })
        // Per-message warnings diagnose a message; they never say the classifier
        // itself is gone. See llm-health.ts for why consecutive and why once.
        const report = llmHealth.noteFailure()
        if (report?.kind === 'down') {
          log.error('llm_outage', {
            model, reason, consecutive: report.consecutive,
            ...(status !== null ? { status } : {}),
            ...(report.repeated ? { stillDown: true } : {})
          })
        }
      },
      onLiveAnswer: () => {
        const report = llmHealth.noteAnswer()
        if (report?.kind === 'recovered') {
          log.info('llm_recovered', { model: config.llmModel, missed: report.missed })
        }
      }
    }, store)
  }
  return ports
}

// Daily campaign briefing for the LLM: recent confirmed-spam samples, cached
// so the per-classify hook stays cheap. Null when there is nothing fresh.
/**
 * When the cluster is full enough to say so loudly. The free tier holds 512 MB
 * and refuses writes at the line, so the warning has to arrive with room to act
 * — 85% leaves weeks at the observed growth rate, not hours.
 */
const FREE_TIER_WARN_MB = 435

const BRIEFING_TTL_MS = 10 * 60 * 1000
const BRIEFING_WINDOW_MS = 7 * 86400 * 1000
let briefingCache: { text: string | null; at: number } = { text: null, at: 0 }
const campaignBriefing = async (): Promise<string | null> => {
  const now = Date.now()
  if (briefingCache.at !== 0 && now - briefingCache.at < BRIEFING_TTL_MS) return briefingCache.text
  const samples = await store.recentConfirmedSpamSamples(8, now - BRIEFING_WINDOW_MS).catch(() => [])
  const text = samples.length > 0
    ? samples.map((s) => `- ${truncate(s.replace(/\s+/g, ' '), 120)}`).join('\n')
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

// What each chat says it is for. Cached because a description is edited perhaps
// never while messages arrive constantly; see chat-profile.ts for why the
// classifier needs it at all.
const chatDescriptions = createChatDescriptionCache((chatId) => fetchChatDescription(gateway.tg, chatId))

/**
 * Where a t.me link leads, from Telegram's own public preview page.
 *
 * The only route a bot account has to the contents of a private invite —
 * `messages.checkChatInvite` is a user-only method — and it costs no MTProto
 * call, so it also spares the `contacts.resolveUsername` that earned a
 * 46-minute FLOOD_WAIT in production. See tme-preview.ts.
 */
const resolveTmePreview = createTmePreviewResolver()

const ports = buildPorts()
const joinRate = new JoinRateTracker()
/**
 * One spammer's run of messages, as one event: see `incident.ts` for the ceiling
 * that keeps it safe. Memory-only on purpose — an incident creates no judgement,
 * so a restart costs nothing but the saving.
 */
const incidents = new IncidentTracker()
/** Which of a removed sender's earlier messages go with them. */
const senderLog = new SenderMessageLog()
/**
 * What a newcomer's arrival left in the chat — Telegram's "joined" service line
 * and our greeting of them — so removing the person can take both down.
 */
const arrivals = new ArrivalLog()

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

/**
 * The message text a verdict was about, kept so an admin override can retire
 * what matched it.
 *
 * Not read back from `pipeline_decisions`: that record stores `textPreview`
 * truncated to 200 characters, and both retirement paths key on the WHOLE text
 * — `computeSignatureHashes` hashes it, `pointIdFor` derives the vector id from
 * it — so a preview addresses a different signature and a different point than
 * the one that actually fired.
 *
 * In-memory only, and bounded like the two maps above. After a restart an
 * override still lifts the punishment and files the feedback record; it just
 * cannot retire the rule, the same way the Why? card degrades to the verdict
 * alone. The community vote is unaffected — its `learnText` lives in Mongo.
 */
const recentTexts = new Map<string, string>()
const rememberText = (chatId: number, messageId: number, text: string): void => {
  if (!text) return
  recentTexts.set(`${chatId}:${messageId}`, text)
  if (recentTexts.size > 2000) {
    const firstKey = recentTexts.keys().next().value
    if (firstKey) recentTexts.delete(firstKey)
  }
}
const recallText = (chatId: number, messageId: number): string | undefined =>
  recentTexts.get(`${chatId}:${messageId}`)

/**
 * What each recent message carried, so that an EDIT of it can be measured.
 *
 * Edit-to-inject — post something ordinary, let it pass, then edit a link into
 * it — is the one spam shape whose evidence is a DIFFERENCE between two
 * deliveries. Telegram sends only the new version, so unless somebody kept the
 * old one there is nothing to subtract, and until this cache existed nobody did:
 * `editDelta` was computed from a parameter no caller ever passed, which left
 * the 2.5-weight signal and its 0.93 rule unreachable in production while both
 * were fully tested.
 *
 * Bounded like every other map here. A miss is not a failure — see
 * `recallEditBaseline`, which asks the decision record before giving up.
 */
const editBaselines = new Map<string, EditBaseline>()
const rememberEditBaseline = (chatId: number, messageId: number, baseline: EditBaseline): void => {
  editBaselines.set(`${chatId}:${messageId}`, baseline)
  if (editBaselines.size > 5000) {
    const firstKey = editBaselines.keys().next().value
    if (firstKey !== undefined) editBaselines.delete(firstKey)
  }
}
/**
 * The earlier version's counters: memory first, then the decision record.
 *
 * The same two-tier shape as `recallVerdict`, for the same reason and one more.
 * The reason: a restart must not hand a spammer a free window in which edits
 * cannot be measured. The extra one: a verdict has to be reproducible from
 * stored state — `tools/replay` and every calibration argument rest on that, and
 * a signal computed purely from process memory is one nothing can re-derive.
 *
 * Costs a read only on an actual edit, which is a small share of traffic.
 *
 * Memory wins over the store deliberately, and it is only correct because this
 * bot runs as ONE instance — the same assumption `claimDueDeletions` already
 * documents. Within one process the cache is written in handler order and always
 * holds the newest version, while the decision record is written later in the
 * same handler; reading the store first would sometimes measure an edit against
 * a version older than the one we just saw. On a second instance this would
 * invert, and the fix then is a revision stamp, not a reordering.
 */
const recallEditBaseline = async (chatId: number, messageId: number): Promise<EditBaseline | null> => {
  const cached = editBaselines.get(`${chatId}:${messageId}`)
  if (cached) return cached
  return store.getEditBaseline(chatId, messageId).catch(() => null)
}

/**
 * Chat titles for the PM "Why?" card. An admin opens that card by link, out of
 * context, for one of many chats — without the title the card describes a
 * removal somewhere. Filled from the message flow (free, always current) and,
 * for a card opened after a restart, from one getChat per chat.
 */
const chatTitles = new Map<number, string>()
const rememberChatTitle = (chatId: number, title: string | null | undefined): void => {
  if (!title) return
  if (chatTitles.get(chatId) === title) return
  chatTitles.set(chatId, title)
  if (chatTitles.size > 2000) {
    const firstKey = chatTitles.keys().next().value
    if (firstKey !== undefined) chatTitles.delete(firstKey)
  }
}
const chatTitleFor = async (chatId: number): Promise<string | null> => {
  const known = chatTitles.get(chatId)
  if (known) return known
  const fetched = await gateway.tg.getChat(chatId).then((c) => c.title || null).catch(() => null)
  rememberChatTitle(chatId, fetched)
  return fetched
}

/** Map a UserSnapshot to the ui's display contract. */
const factsFromSnapshot = (
  user: UserSnapshot,
  flags: { promoInBio: boolean; personalChannel: boolean }
): UserFacts => {
  const eb = user.externalBan
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
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

/**
 * How long after a gate expires its visible prompt is removed. Small, and only
 * there so a tap arriving on the last second is not racing the deletion.
 */
const CAPTCHA_CLEANUP_GRACE_MS = 5 * 1000

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

/**
 * The gate this tap belongs to, WITHOUT spending it; null if forged or expired.
 *
 * Split from spending it, because the two used to happen in the wrong order.
 * The gate was consumed first and the unrestrict attempted after, inside a
 * swallowing catch — so a permissions or network failure left the newcomer
 * still muted, holding a toast that said "Готово, пиши", with the only valid
 * gate already gone and nothing left to tap. A restriction the user cannot
 * lift is the one failure mode the whole whisper-first design exists to avoid.
 */
const peekCaptcha = (chatId: number, userId: number): CaptchaGate | null => {
  const gate = pendingCaptchas.get(captchaKey(chatId, userId))
  if (gate === undefined) return null
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
    const sent = await tgSendText(chatId, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons)
      // Prompt failure is survivable: the restriction expires on its own.
    }).catch(() => null)
    if (!sent) return
    gate.publicMessageId = sent.id
    /**
     * Scheduled against the gate's own expiry, not a TTL of its own.
     *
     * A tap deletes this message immediately, so the schedule only ever fires
     * on prompts nobody answered — and those had no deletion at all: the
     * cleanup lived in `passCaptcha` and ran on success only. What was left
     * behind was permanent chrome with a button that can no longer work, one
     * per unanswered gate, which during a join raid is the raid's whole
     * footprint sitting in the chat after we handled it.
     *
     * Persistent, via `scheduleDelete`, because the ten-minute window
     * comfortably outlives a restart and the sweep is the backstop.
     */
    scheduleDelete(
      chatId, sent.id,
      Math.max(gate.expiresMs - Date.now(), 0) + CAPTCHA_CLEANUP_GRACE_MS,
      'captcha_expired'
    )
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
  // Forgeable payload: lift the gate only if WE issued it.
  const gate = peekCaptcha(chatId, userId)
  if (!gate) {
    await answer()
    return false
  }
  const lifted = await gateway.tg.restrictChatMember({ chatId, userId, restrictions: {} })
    .then(() => true).catch(() => false)
  if (!lifted) {
    // The gate stays. Another tap is the only thing the member can do, and it
    // is worth something — the usual cause is transient.
    log.warn('captcha_unrestrict_failed', { chatId, userId })
    await answer(locale.captcha.retry)
    return false
  }
  // Spent only now that it worked. A second tap arriving in the window between
  // these two lines costs an idempotent unrestrict, which is nothing.
  forgetCaptcha(captchaKey(chatId, userId))
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

/**
 * Adminship and join date, from one cached `getChatMember` per person per chat.
 * See `member-facts.ts` for why a failed lookup is not written down.
 */
const memberFacts = new MemberFactsCache()
const chatMemberFacts = (chatId: number, userId: number): Promise<MemberFacts> =>
  memberFacts.get(chatId, userId, () => gateway.tg.getChatMember({ chatId, userId }))

const isChatAdmin = async (chatId: number, userId: number): Promise<boolean> =>
  (await chatMemberFacts(chatId, userId)).isAdmin

/**
 * What the chat knows about someone reaching for a ballot.
 *
 * Two reads and one Telegram lookup, and only on a tap: votes are rare next to
 * messages, so this never touches the hot path. The lookup is the adminship
 * check, which every ballot needs anyway — the join date rides along on the
 * same response, at no extra cost. It used to be discarded there, and tenure
 * was read from our own first sighting alone, which is exactly the reading that
 * refused a chat's whole membership for a week after the bot joined it.
 *
 * Both halves of the volume test now read standing rather than traffic, and
 * mean the same thing by it. The global half always did (`userDocToHistory`
 * subtracts); the in-chat half read raw traffic until 2026-08-23, so one
 * criterion was adding up two different quantities. The consequence was not
 * theoretical: messages the chat had removed still counted toward the vote of
 * whoever sent them, and `spamDetections` cannot cover that case, because a
 * chat produces at most one detection against an account — a sender working a
 * single room never reaches the two that take the vote away.
 */
const voterStandingFor = async (
  chatId: number, userId: number, targetUserId: number
): Promise<VoterStanding> => {
  const [facts, doc, stats] = await Promise.all([
    chatMemberFacts(chatId, userId),
    store.getUserDoc(userId).catch(() => null),
    store.getMemberStats(chatId, userId).catch(() => ({ messagesCount: 0, standingInChat: 0, bananCount: 0 }))
  ])
  const history = userDocToHistory(doc as Parameters<typeof userDocToHistory>[0], stats.standingInChat)
  const firstSeenUnix = history?.firstSeenUnix ?? null
  return {
    isAdmin: facts.isAdmin,
    isTarget: userId === targetUserId,
    messagesInChat: stats.standingInChat,
    messagesGlobal: history?.messagesGlobal ?? 0,
    localAgeDays: firstSeenUnix === null ? null : (Date.now() / 1000 - firstSeenUnix) / 86400,
    joinedAgoSeconds: facts.joinedAgoSeconds,
    spamDetections: history?.spamDetections ?? 0
  }
}

/** The refusal text for a ballot that does not count, or null when it does. */
const ballotRefusal = (locale: Locale, standing: VoterStanding): string | null => {
  switch (voteEligibility(standing)) {
    case 'eligible': return null
    case 'is_target': return locale.vote.voters.notForTarget
    case 'known_bad': return locale.vote.voters.knownBad
    case 'no_standing': return locale.vote.voters.noStanding
  }
}

let selfId = 0
let selfUsername: string | null = null

/** ViewMessage buttons → mtcute keyboard (callback or url). */
const toKeyboard = (buttons: ViewMessage['buttons']): ReturnType<typeof BotKeyboard.inline> =>
  BotKeyboard.inline(buttons.map((row) => row.map((b) =>
    b.url ? BotKeyboard.url(b.text, b.url) : BotKeyboard.callback(b.text, b.data ?? ''))))

/**
 * The locale a GROUP is configured in, for anything the whole group reads.
 *
 * Distinct from `localeFor`, which answers "what language does this person
 * read" and is right for a toast or a PM. It is wrong for a shared message:
 * the ballot is re-rendered on every counted vote, so resolving its language
 * from the voter meant one Turkish-locale member turned the question Turkish
 * for everybody, and the next voter turned it back.
 */
const groupLocale = async (chatId: number): Promise<Locale> => {
  const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
  return resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
}

/**
 * Locale resolution for ONE PERSON: stored preference first, Telegram client
 * language second.
 *
 * Right for a PM and for a callback toast, which only that person sees. Wrong
 * for anything posted into a group — `groupLocale` is for that. Every group
 * command used to resolve its reply through this, so a chat configured in
 * Ukrainian answered `/banan` in Russian for one admin and in English for the
 * next, in the same chat, minutes apart.
 */
const localeFor = async (userId: number, clientLanguage: string | null): Promise<Locale> => {
  const stored = await store.getUserLocale(userId).catch(() => null)
  return resolveLocale(stored ?? clientLanguage)
}

/**
 * A `<pre>` block and everything in it. Non-global on purpose — `split` splits
 * on every match regardless, and the capture group is what keeps the block
 * itself in the resulting array.
 */
const PRE_BLOCK = /(<pre>[\s\S]*?<\/pre>)/

/**
 * View texts use \n; the HTML parser collapses whitespace, so map to <br>.
 *
 * Everywhere EXCEPT inside a `<pre>`. There the parser ignores every tag that
 * is not another `pre` — a `<br>` is dropped rather than turned into a newline —
 * while real whitespace is preserved as written. A blanket replacement would
 * therefore weld a multi-line quoted message into one run-on line, which is
 * precisely the message the ballot exists to show. So: convert outside the
 * blocks, leave the newlines inside them alone.
 */
const viewHtml = (text: string): ReturnType<typeof html> =>
  html(text
    .split(PRE_BLOCK)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\n/g, '<br>')))
    .join(''))

type RichText = ReturnType<typeof viewHtml>

/**
 * A `tg://user?id=` mention, in both spellings it can have by send time: the
 * parser emits `messageEntityMentionName`, and `_normalizeInputText` rewrites
 * it IN PLACE to the input form once it resolves the peer. A retry has to look
 * for either, because the mutation happens before the call that failed.
 */
const MENTION_ENTITIES = new Set(['messageEntityMentionName', 'inputMessageEntityMentionName'])

const hasMention = (text: RichText | string): boolean =>
  typeof text !== 'string' && (text.entities ?? []).some((e) => MENTION_ENTITIES.has(e._))

/** The same notice with its names as plain text. */
const withoutMentions = (text: RichText): RichText => ({
  ...text,
  entities: (text.entities ?? []).filter((e) => !MENTION_ENTITIES.has(e._))
})

/** Errors Telegram returns for a mention it will not accept. */
const MENTION_REJECTED = /ENTITY|MENTION|USER_INVALID|PEER_ID_INVALID/i

/**
 * Send, and if the only thing wrong was a name, send it again without the name.
 *
 * A mention is the one part of a notice that can fail for a reason that has
 * nothing to do with the notice: mtcute resolves `tg://user?id=` against the
 * peer cache, and on a miss it logs a warning and leaves an entity the server
 * rejects — taking the whole message with it. Every send here is wrapped in
 * `.catch(() => null)`, so that would not surface as an error, it would surface
 * as silence: an enforcement nobody in the chat was told about, which is the
 * one failure mode this bot's notices exist to prevent. A name is worth having
 * and never worth the notice.
 */
const tgSendText = async (
  ...[peer, text, params]: Parameters<typeof gateway.tg.sendText>
): ReturnType<typeof gateway.tg.sendText> => {
  try {
    return await gateway.tg.sendText(peer, text, params)
  } catch (err) {
    if (!hasMention(text) || !MENTION_REJECTED.test(String(err))) throw err
    log.warn('mention_flattened', { op: 'send', error: String(err) })
    return await gateway.tg.sendText(peer, withoutMentions(text as RichText), params)
  }
}

/** `replyText` under the same rule as `tgSendText`. */
const tgReplyText = async (
  ...[message, text, params]: Parameters<typeof gateway.tg.replyText>
): ReturnType<typeof gateway.tg.replyText> => {
  try {
    return await gateway.tg.replyText(message, text, params)
  } catch (err) {
    if (!hasMention(text) || !MENTION_REJECTED.test(String(err))) throw err
    log.warn('mention_flattened', { op: 'reply', error: String(err) })
    return await gateway.tg.replyText(message, withoutMentions(text as RichText), params)
  }
}

/** `editMessage` under the same rule as `tgSendText`. */
const tgEditMessage = async (
  ...[params]: Parameters<typeof gateway.tg.editMessage>
): ReturnType<typeof gateway.tg.editMessage> => {
  try {
    return await gateway.tg.editMessage(params)
  } catch (err) {
    const text = (params as { text?: RichText | string }).text
    if (text === undefined || !hasMention(text) || !MENTION_REJECTED.test(String(err))) throw err
    log.warn('mention_flattened', { op: 'edit', error: String(err) })
    return await gateway.tg.editMessage({ ...params, text: withoutMentions(text as RichText) })
  }
}

/**
 * Auto-delete TTLs for transient in-group chrome (ms). The compact mod
 * notification and the banan/vote prompts are ephemeral — they clean
 * themselves up so chats stay readable. Mirrors v1 cleanup-policy.
 */
/**
 * The compact notice carries the only two routes to reviewing what the bot did:
 * the "why?" link and the "Not spam" button. Ninety seconds was long enough to
 * read the notice and far too short to act on it — a moderator who was doing
 * something else for two minutes came back to an enforcement they could neither
 * inspect nor undo, on a message that no longer existed to reply to.
 *
 * Ten minutes, matching the incident window: the span this bot itself treats as
 * "the same event". Grouping already collapses a run into one notice, so this
 * costs one line per sender per ten minutes and buys the correction channel
 * through which nearly every false positive in this system has been caught.
 */
const NOTIFY_TTL_COMPACT_MS = 10 * 60 * 1000
const NOTIFY_TTL_BANAN_MS = 60 * 1000
// Long enough that "who voted" is still reachable by someone who saw the
// result scroll by, short enough that a settled question leaves the chat.
const NOTIFY_TTL_VOTE_RESULT_MS = 15 * 60 * 1000
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

/**
 * Retire questions the chat never answered.
 *
 * A vote used to have no end at all: the prompt is the only notice this bot
 * posts without a deletion timer, so an unanswered one sat in the chat while
 * its document expired underneath it after seven days, leaving live buttons on
 * a question that no longer existed. Expiry decides nothing — a tally below the
 * quorum is not a verdict, and pretending otherwise would make one ballot a
 * ruling — but it does end the question and say so in the log, which is the
 * only way to find out how many corrections the chats are letting lapse.
 */
const expireStaleVotes = async (): Promise<void> => {
  const expired = await store.claimExpiredVotes().catch(() => [])
  for (const vote of expired) {
    log.info('vote_expired', {
      chatId: vote.chatId, userId: vote.targetUserId, messageId: vote.messageId
    })
    if (vote.promptMessageId !== null) {
      await gateway.tg.deleteMessagesById(vote.chatId, [vote.promptMessageId])
        .catch(() => { /* already gone */ })
    }
  }
}

/** Backstop sweep: delete everything whose deleteAt has passed. */
const processDueDeletions = async (): Promise<void> => {
  const due = await store.claimDueDeletions(200).catch(() => [])
  for (const d of due) {
    await gateway.tg.deleteMessagesById(d.chatId, [d.messageId]).catch(() => { /* already gone */ })
  }
}

const sendView = async (message: Message, view: ViewMessage): Promise<void> => {
  await tgReplyText(message, viewHtml(view.text), {
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
 * What Telegram has recently refused us here, per capability. See rights.ts —
 * the reasoning is load-bearing enough to live with its tests.
 */
const rights = new RightsMemory(Date.now, (chatId, record) => {
  // Fire-and-forget by contract: the hot path answers "may I enforce here"
  // synchronously, and a lost write costs one evaluation — the very thing this
  // saves — not correctness.
  void store.saveRightsBlock(chatId, record).catch(() => { /* retried by the next refusal */ })
})

/**
 * When the bot catches spam but can't act (not an admin / missing rights), it
 * posts a warning in the chat so admins know to grant rights.
 *
 * The quiet period doubles with every consecutive refusal, from an hour to a
 * day, and lives in `RightsMemory` with everything else — it used to be a Map
 * here, so each restart reset it to the first hour and the same chats were asked
 * again (three times on 2026-08-07). A flat hourly notice reads as useful the
 * first time and as nagging the tenth: production 2026-08-01 had chats refusing
 * every action for hours, which at the old cadence is two dozen public messages
 * a day into a group where the bot can do nothing — and each one tells whoever
 * is posting the spam that it cannot be touched here.
 */
const shouldWarnMissingRights = (chatId: number, errors: string[]): boolean =>
  errors.some((e) => RIGHTS_ERROR_REGEX.test(e)) && rights.shouldWarn(chatId)

/**
 * The cheap half of the rights question: are we an admin in this chat at all?
 *
 * Allowed to LIFT a block and never to create one, which is what makes reading
 * it safe (see `RightsMemory.noteProbe`). Only `status` is consulted, not the
 * individual admin rights: a promoted bot missing one specific right will be
 * told so by the very next attempt, and that attempt is the evidence this whole
 * mechanism is built on. Reading the rights bitmask here would add a second,
 * more brittle way to be wrong about the same question.
 */
const probeRights = async (chatId: number): Promise<boolean> => {
  const granted = await gateway.tg.getChatMember({ chatId, userId: selfId })
    .then((m) => m !== null && (m.status === 'admin' || m.status === 'creator'))
    .catch(() => false)
  rights.noteProbe(chatId, granted)
  if (granted) log.info('rights_restored', { chatId })
  return granted
}

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
  await vectorPort?.learn(learnText, source, 'candidate', chatId)
    .catch(() => { /* best-effort */ })
  log.debug('auto_learned', { decidedBy: verdict.decidedBy, reason: verdict.reasonCode })
}

/** What a resolved-spam vote actually managed to do. */
interface VoteEnforcement {
  deleted: boolean
  muted: boolean
}

/**
 * A vote resolved to spam: remove the message, mute the author, record the
 * detection against the account, and teach the stores — as a candidate only.
 *
 * `tallyVotes` resolves instantly on a single admin ballot, which is right for
 * acting on this message and wrong as grounds for a rule that fires in every
 * chat for the next 90 days. Ballots used to set the learning strength; since
 * 2026-08-23 they no longer can (see `VOTE_LEARN_STATUS`) and promotion is left
 * to a second, independent chat reporting the same text.
 */
const enforceVoteSpam = async (vote: {
  chatId: number
  messageId: number
  targetUserId: number
  /** Full text to learn (not the truncated display preview). */
  learnText: string
  tally: { spam: number; ham: number }
}, learnSource: string): Promise<VoteEnforcement> => {
  // Both outcomes are reported, on the same reasoning `ExecutionResult` already
  // separates `applied` from `deleted`: "the message went, the person stayed"
  // is a different fact from "nothing happened", and the receipt used to
  // announce "Прибрав" for both. A chat that loses the bot's rights mid-ballot
  // got a settled-looking result over a message still on screen, written by an
  // author still posting — and moderators stop checking a settled result.
  const deleted = await gateway.moderationActions.deleteMessage(vote.chatId, vote.messageId)
    .then(() => true).catch(() => false)
  const muted = await gateway.moderationActions.mute(vote.chatId, vote.targetUserId, MUTE_AFTER_VOTE_SECONDS)
    .then(() => true).catch(() => false)
  if (!deleted || !muted) {
    log.warn('vote_enforce_incomplete', {
      chatId: vote.chatId, userId: vote.targetUserId, messageId: vote.messageId,
      deleted, muted, source: learnSource
    })
  }
  /**
   * The chat confirmed it, so it is now a fact about the account and not only
   * about the message.
   *
   * `spamDetections` is read by three mechanisms — the `prior_spam_detections`
   * signal, the established-regular exempt, and the right to vote — and until
   * 2026-08-23 only automatic enforcement ever wrote it. So somebody the
   * community had voted a spammer ten times over stayed a full member in every
   * one of those readings, including as a voter on the next question. The
   * counter had a reader before it had this writer.
   *
   * The detection alone, deliberately: the uncertain enforcement that opened
   * this question already debited the message. Adding a second debit here would
   * make one message cost two messages of standing.
   *
   * And only when the question had something in it — see
   * `voteMayRecordDetection`, which is also the condition the learning below
   * already used. The removal and the mute still stand on a wordless ballot;
   * the durable counter does not.
   */
  const hasContent = voteMayRecordDetection(vote.learnText)
  if (hasContent) {
    await store.recordSpamDetection(vote.chatId, vote.targetUserId)
      .catch(() => { /* counters are best-effort */ })
  } else {
    log.info('vote_spam_no_content', {
      chatId: vote.chatId, userId: vote.targetUserId, messageId: vote.messageId,
      spam: vote.tally.spam, ham: vote.tally.ham, source: learnSource
    })
  }

  if (hasContent) {
    const requested = VOTE_LEARN_STATUS
    const signature = await signaturePort.learn(vote.learnText, learnSource, requested, vote.chatId)
      .catch(() => null)
    // Seed the vector layer too, so semantic matching learns alongside
    // signatures instead of staying frozen at the v1 snapshot.
    const vector = await vectorPort?.learn(vote.learnText, learnSource, requested, vote.chatId)
      .catch(() => null) ?? null
    /**
     * Logged AFTER the writes, and reporting all three values.
     *
     * It used to log the requested status before either port ran, so a text
     * the distinctiveness bar downgraded — or dropped entirely — still appeared
     * in the log as a confirmed cross-chat rule. Any count of "how many
     * deciding rules did votes create" taken from these lines was too high.
     */
    log.info('vote_learned', {
      chatId: vote.chatId, requested, signature, vector,
      spam: vote.tally.spam, ham: vote.tally.ham, source: learnSource
    })
  }

  return { deleted, muted }
}

/**
 * Undo everything a verdict cost somebody, and write down that we were wrong.
 *
 * Both ways of saying "not spam" run this. They used to diverge: the admin
 * button gave the standing back, filed the feedback record replay calibrates
 * against and cleared the forward origin, while a chat voting ham only lifted
 * the mute. So a community ham verdict — the one form of correction that
 * arrives without anybody having to be an admin — cost its victim their
 * standing permanently and taught the corpus nothing. Whether a correction is
 * recorded should not depend on which button carried it.
 *
 * Trust is deliberately NOT here: vouching for somebody in a chat is an
 * authority the community vote only has when an admin voted in it, and its
 * caller decides that.
 */
/**
 * Whether the restitution a correction PROMISES actually landed.
 *
 * `lifted` is vacuously true when there was nothing to lift — a delete-only
 * verdict restricts nobody. It is false only when we tried and failed, which
 * is exactly the case the override toast used to describe as "розблокований".
 */
interface RestitutionResult {
  lifted: boolean
}

const restoreFalsePositive = async (params: {
  chatId: number
  messageId: number
  userId: number
  /** Who said so — an admin's id, or the voter who closed a community vote. */
  byUserId: number
  source: 'admin' | 'community_vote'
  /**
   * The full text the verdict was about, when we still have it. Only an admin
   * correction retires anything with it — see the retirement block below.
   */
  learnText?: string | undefined
}): Promise<RestitutionResult> => {
  const verdict = await recallVerdict(params.chatId, params.messageId)
  /**
   * A chat may only undo what WE did. See `needsRestitution`: the calls below
   * lift whatever restriction is in place regardless of who imposed it, and a
   * vote can be opened by `/report` on any message at all — so without this,
   * three ham ballots would quietly take an admin's own `/banan` off.
   *
   * The gate is on the community path alone, deliberately. An admin pressing
   * the override button has the authority whatever we did or did not do, and
   * `recallVerdict` swallows a failed Mongo read as `null` — so gating them too
   * would turn a database hiccup into "the override button stopped working".
   */
  if (params.source === 'community_vote' && !needsRestitution(verdict)) {
    log.info('restore_skipped', {
      chatId: params.chatId, userId: params.userId, messageId: params.messageId,
      by: params.byUserId, source: params.source, reason: verdict === null ? 'no_verdict' : verdict.action
    })
    // Nothing was ours to undo, so nothing failed to be undone.
    return { lifted: true }
  }
  /**
   * An incident must not outlive the verdict that opened it: without this it
   * would go on deleting the messages of somebody the chat has just vouched for,
   * unread, for the rest of its ten minutes.
   *
   * Its count is also the only honest answer to "what did this mistake cost".
   * Lifting a ban and giving standing back are both reversible; the deletions are
   * not, and a correction that cannot say how many messages it could not restore
   * is a correction nobody can price. Reported only when the incident is the one
   * this message opened — a live incident from a LATER verdict is a different
   * event and its count is not this one's.
   */
  const incident = incidents.live(params.chatId, params.userId)
  const removedCount = incident?.triggerMessageId === params.messageId
    ? incident.removedCount
    : undefined
  incidents.close(params.chatId, params.userId)
  senderLog.forget(params.chatId, params.userId)
  await store.recordOverride({
    chatId: params.chatId,
    messageId: params.messageId,
    userId: params.userId,
    adminId: params.byUserId,
    source: params.source,
    ...(removedCount !== undefined ? { removedCount } : {}),
    // A label with no recallable verdict keeps no evidence — the decision
    // record expired or the bot restarted. Recorded anyway (somebody did say
    // "not spam"), but it cannot take part in calibration replay.
    verdict: verdict ?? {
      decidedBy: 'error', ruleId: null, reasonCode: 'unknown',
      pSpam: 0, action: 'none', signals: [], meta: {}
    }
  }).catch(() => { /* keep going — lifting the punishment matters more */ })
  /**
   * Lift restrictions (empty restrictions object = unrestrict) — but only the
   * ones our own verdict imposed. These two calls undo whatever is in place
   * whoever put it there, so after a delete-only verdict, which restricts
   * nobody, the only thing they can lift is somebody else's decision.
   */
  let lifted = true
  if (restitutionLiftsRestrictions(verdict)) {
    // Either call succeeding is enough: only one of the two restrictions was
    // ever in place, and the other one failing means "there was nothing there",
    // not "we could not". Both failing is the case worth reporting — the person
    // is still silenced and the moderator was about to be told otherwise.
    const unmuted = await gateway.tg.restrictChatMember({ chatId: params.chatId, userId: params.userId, restrictions: {} })
      .then(() => true).catch(() => false)
    const unbanned = await gateway.tg.unbanChatMember({ chatId: params.chatId, participantId: params.userId })
      .then(() => true).catch(() => false)
    lifted = unmuted || unbanned
    if (!lifted) {
      log.warn('restore_lift_failed', {
        chatId: params.chatId, userId: params.userId, messageId: params.messageId,
        by: params.byUserId, source: params.source
      })
    }
  }
  // Give the standing back. Enforcing debited it, and the debit withholds the
  // benefit of the doubt — leaving it in place after a correction would let one
  // false positive make the next one against the same person more likely.
  //
  // The detection goes back unconditionally, not only when the original verdict
  // had earned one. A deliberate asymmetry: this is the strongest
  // counter-evidence the system ever receives, the counter has a floor at zero,
  // and two detections strip an account of every benefit of the doubt at once.
  await store.adjustSpamMessages(params.chatId, params.userId, -1, true)
    .catch(() => { /* counters are best-effort */ })
  /**
   * Retire what matched, so the same mistake is not made about the next person.
   *
   * Admin only, and deliberately so. `recordOverride` already retires the
   * signature that DECIDED, and states the reason the community may not: a
   * signature fires in every chat for ninety days, so switching one off is a
   * network-wide act, and a crew posting spam in a group they control could
   * otherwise vote their own text clean and take the rule down everywhere.
   * Nothing here widens that authority.
   *
   * What it widens is reach, on two fronts the id-based retirement cannot see:
   *  - a candidate that only contributed `signature_candidate_match` to an LLM
   *    verdict is never the decider, so no `ruleId` ever pointed at it;
   *  - the vector twin, whose `disabledAt` the search has always honoured and
   *    nobody ever wrote — a false positive there was unretirable by anyone.
   */
  if (params.source === 'admin' && params.learnText) {
    await signaturePort.retire(params.learnText).catch(() => { /* best-effort */ })
    await vectorPort?.retire(params.learnText).catch(() => { /* best-effort */ })
  }

  // A forwarded FP also earns its origin a clean point (v1 2:1 math).
  const key = `${params.chatId}:${params.messageId}`
  const forward = recentForwards.get(key)
  if (forward) {
    await forwardPort.reportClean(forward).catch(() => { /* best-effort */ })
    recentForwards.delete(key)
  }
  recentVerdicts.delete(key)
  return { lifted }
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
  const current = (groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale ?? 'en'
  return langPanel(locale, chatId, current)
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
    const member = await store.getMemberStats(chatId, userId).catch(() => ({ messagesCount: 0, standingInChat: 0, bananCount: 0 }))
    // The card is read in a PM, where "this chat" names nothing.
    const title = await chatTitleFor(chatId)
    lines.push(locale.stats.inChat(member.messagesCount, title === null ? null : escapeName(title)))
    if (member.bananCount > 0) lines.push(locale.stats.bananCaught(member.bananCount))
  }
  lines.push(locale.stats.global(userDoc?.globalStats?.totalMessages ?? 0))
  // Shown only where a score actually exists. `reputation.*` is a v1 field that
  // v2 writes nothing to, so `?? 50` was printing an invented number to every
  // account this bot has judged on its own — a figure a user could read as a
  // rating we keep, and reasonably ask us to explain.
  const reputation = userDoc?.reputation
  if (typeof reputation?.score === 'number') {
    lines.push(locale.stats.reputation(reputation.score, locale.stats.repStatus[reputation.status ?? 'neutral']))
  }
  return lines.join('\n')
}

/**
 * Send the admin a live preview of the greeting a newcomer would see, using
 * their own name in the %name% slot. Best-effort — a preview must never throw.
 */
const sendWelcomePreview = async (userId: number, sampleName: string, chatId: number, locale: Locale): Promise<void> => {
  const w = await store.getWelcome(chatId).catch(() => ({ texts: [] as string[], gifs: [] as string[] }))
  if (w.texts.length === 0 && w.gifs.length === 0) {
    await tgSendText(userId, viewHtml(locale.welcome.editor.previewEmpty)).catch(() => { /* PM closed */ })
    return
  }
  const names = `<b>${escapeName(sampleName)}</b>`
  const body = buildWelcomeGreeting(pickRandom(w.texts), names, locale.welcome.defaultGreeting(names))
  const gif = pickRandom(w.gifs)
  if (gif) {
    await replayMedia(userId, gif, { caption: body, tag: 'welcome_preview_failed', fields: { forChat: chatId } })
  } else {
    await tgSendText(userId, viewHtml(body)).catch(() => { /* PM closed */ })
  }
}

/**
 * Whether the capture window is finished with.
 *
 * `keep` covers two different situations that both need the same thing: a
 * recoverable validation or write failure, where the admin's corrected next
 * message must still land in this flow, and the extra-name step, which has
 * already replaced the entry with the next one itself.
 */
type PendingOutcome = 'consume' | 'keep'

/**
 * Capture the next PM message as input for an in-progress editor flow (add a
 * welcome text/gif, name/define an extra). After a successful add we echo the
 * refreshed list so the admin can keep adding without re-opening the menu.
 */
const handlePendingInput = async (
  message: Message, userId: number, entry: PendingEntry, locale: Locale
): Promise<PendingOutcome> => {
  const reply = (text: string): Promise<void> =>
    tgSendText(userId, viewHtml(text)).then(() => undefined).catch(() => { /* PM closed */ })
  const text = (message.text ?? '').trim()

  if (entry.type === 'welcome.text') {
    const r = await store.addWelcomeText(entry.chatId, text).catch(() => ({ added: false as const, reason: undefined }))
    await reply(r.added ? locale.welcome.editor.added : welcomeAddIssue(locale, r.reason))
    await sendView(message, await renderWelcomeTexts(locale, entry.chatId, 0))
    // A rejected text is a text the admin can fix and resend; the prompt stays.
    return r.added ? 'consume' : 'keep'
  }
  if (entry.type === 'welcome.gif') {
    const fileId = mediaFileId(message)
    if (!fileId) { await reply(locale.welcome.editor.invalidGif); return 'keep' }
    const r = await store.addWelcomeGif(entry.chatId, fileId).catch(() => ({ added: false as const, reason: undefined }))
    await reply(r.added ? locale.welcome.editor.added : welcomeAddIssue(locale, r.reason))
    await sendView(message, await renderWelcomeGifs(locale, entry.chatId, 0))
    return r.added ? 'consume' : 'keep'
  }
  if (entry.type === 'extra.name') {
    const name = text.replace(/^#/, '')
    if (!/^[\p{L}\p{N}_]+$/u.test(name)) { await reply(locale.extra.editor.invalidName); return 'keep' }
    // Second step of the flow: now wait for the content under this name. The
    // entry it just wrote is the state — 'keep' so the caller leaves it alone.
    pendingInput.set(userId, { type: 'extra.content', chatId: entry.chatId, arg: name })
    await reply(locale.extra.editor.promptContent(name))
    return 'keep'
  }
  if (entry.type === 'extra.content') {
    const name = entry.arg ?? ''
    const fileId = mediaFileId(message)
    if (!text && !fileId) { await reply(locale.extra.editor.cancelled); return 'consume' }
    const extra: NormalizedExtra = { name, text, fileId }
    // Reported, not swallowed. "✅ Збережено #name" over a write Mongo refused
    // sends the admin away believing a trigger exists that will never fire.
    const saved = await store.saveExtra(entry.chatId, extra).then(() => true).catch(() => false)
    await reply(saved ? locale.extra.editor.added(escapeName(name)) : locale.writeFailed)
    await sendView(message, await renderExtrasEditor(locale, entry.chatId, 0))
    return saved ? 'consume' : 'keep'
  }
  return 'consume'
}

/** PM entry: /start card, /help, /lang, settings deep links, editor input. */
const handlePrivateMessage = async (message: Message): Promise<void> => {
  const sender = message.sender
  if (!(sender instanceof User) || sender.isBot) return
  const text = (message.text ?? '').trim()
  const locale = await localeFor(sender.id, sender.language)

  // In-progress editor flow: this message is the input the admin was asked for.
  const pending = pendingInput.peek(sender.id)
  if (pending === 'expired') {
    // Said out loud. The five-minute window lapsing used to be silent, so the
    // admin's next message was read as a fresh command and answered with the
    // /start card — which reads exactly like the editor having forgotten them.
    await tgSendText(sender.id, viewHtml(locale.welcome.editor.expired))
      .catch(() => { /* PM closed */ })
    return
  }
  if (pending) {
    if (/^\/cancel\b/i.test(text)) {
      pendingInput.cancel(sender.id)
      await tgSendText(sender.id, viewHtml(locale.welcome.editor.cancelled)).catch(() => { /* PM closed */ })
      return
    }
    if (await handlePendingInput(message, sender.id, pending, locale) === 'consume') {
      pendingInput.cancel(sender.id)
    }
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
      }, {
        canOverride,
        facts: recallFacts(chatId, Number(messageIdRaw)),
        chatTitle: Number.isFinite(chatId) ? await chatTitleFor(chatId) : null
      }))
    } else {
      await sendView(message, { text: locale.why.expired, buttons: [] })
    }
    return
  }
  if (payload === 'lang') {
    await sendView(message, langPicker(locale))
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
 *   `/banan` with no reply, by an admin → they show the banana, nobody is muted
 *   `/banan` with no reply, by anyone else → self-banan (the classic joke)
 */
const handleBanan = async (message: Message, chat: Chat, caller: User, arg: string | undefined): Promise<void> => {
  const locale = await groupLocale(chat.id)
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const defaultSeconds = Number((groupDoc as { settings?: { banan?: { default?: number } } } | null)
    ?.settings?.banan?.default) || 600
  const { seconds, explicit } = parseBananDuration(arg, defaultSeconds)
  const human = formatDuration(seconds, locale.banan.units)
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })

  const replied = await gateway.fetchRepliedMessage(message)

  if (!replied) {
    /**
     * An admin typing a bare `/banan` holds the banana up for the chat — and
     * mutes nobody. It is the oldest joke in this bot (v1 `banan.show`) and v2
     * shipped without the branch, so an admin who typed it fell through to the
     * self-banan below and silenced themselves for ten minutes. Restored
     * 2026-08-07: the pose is the whole point, and the punishment was never it.
     */
    if (await isChatAdmin(chat.id, caller.id)) {
      await tgSendText(chat.id, viewHtml(locale.banan.show(userMention(caller.id, caller.displayName))))
        .catch(() => { /* non-fatal */ })
      return
    }

    // Everyone else: no reply needed, anyone can sit on their own banana.
    const ok = await gateway.moderationActions.mute(chat.id, caller.id, seconds)
      .then(() => true).catch(() => false)
    if (ok) {
      log.info('banan', { chatId: chat.id, chat: chat.title ?? undefined, userId: caller.id, user: caller.displayName, by: caller.id, kind: 'self', seconds })
      await tgSendText(chat.id, viewHtml(locale.banan.self(userMention(caller.id, caller.displayName), human)))
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
      await tgSendText(chat.id, viewHtml(locale.banan.lifted(userMention(target.id, target.displayName))))
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
  const sent = await tgSendText(chat.id, viewHtml(locale.banan.success(userMention(target.id, target.displayName), human)), {
    replyMarkup: toKeyboard([[{ text: locale.banan.undoButton, data: `un:${chat.id}:${target.id}` }]])
  }).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'banan')
}

/**
 * /kick — admin removes a member (ban then unban, so they can rejoin).
 * Reply required; admins are kick-proof; the notice auto-deletes.
 */
const handleKick = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await groupLocale(chat.id)
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
      const sent = await tgSendText(chat.id, viewHtml(locale.notification.missingRights)).catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'missing_rights')
    }
    return
  }
  log.info('kick', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id })
  const sent = await tgSendText(chat.id, viewHtml(locale.kick.success(userMention(target.id, target.displayName)))).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'kick')
}

/**
 * /untrust — admin revokes the chat-level auto-trust an override granted.
 * The reversible counterpart to the override's addTrustedUser, closing the
 * "one wrong override protects a spammer forever" gap. Reply required.
 */
const handleUntrust = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await groupLocale(chat.id)
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
  const who = userMention(target.id, target.displayName)
  const text = removed ? locale.untrust.success(who) : locale.untrust.notTrusted(who)
  const sent = await tgSendText(chat.id, viewHtml(text)).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'untrust')
}

/**
 * Live profile facts for one user in one chat: stored history + getFullUser +
 * external ban + join time, mapped to the ui's display contract.
 *
 * Shared by /check and by the profile button on the "Why?" card, so both cards
 * are built from the same reading — a profile that differed by which surface
 * asked for it would be a second source of truth about the same account.
 */
const buildLiveFacts = async (chatId: number, target: User): Promise<UserFacts> => {
  const userDoc = await store.getUserDoc(target.id).catch(() => null)
  const history = userDocToHistory(userDoc as never, 0)
  const profile = await fetchUserProfile(gateway.tg, target.id)
  let externalBan = history?.externalBan ?? null
  const fresh = await fetchExternalBan(target.id).catch(() => null)
  if (fresh) externalBan = mergeExternalBan({ lols: fresh.lols as never, cas: fresh.cas as never })
  const joinedDate = await gateway.tg.getChatMember({ chatId, userId: target.id })
    .then((m) => m?.joinedDate ?? null).catch(() => null)
  const joinedAgoSeconds = joinedDate ? Math.max(0, (Date.now() - joinedDate.getTime()) / 1000) : null

  const user = buildUserSnapshot(
    target,
    history === null ? null : { ...history, avatars: profile.avatars, externalBan },
    undefined,
    { unofficialClientRisk: profile.unofficialClientRisk, joinedAgoSeconds }
  )
  return factsFromSnapshot(user, {
    promoInBio: extractBioSignals(profile.bio).length > 0,
    personalChannel: profile.personalChannelId !== null
  })
}

/**
 * /check — admin looks up the profile of the replied-to user. Builds a LIVE
 * snapshot (history + getFullUser + external-ban + join time) and renders the
 * profile card. Reply required; admin-only; the card auto-deletes.
 */
const handleCheck = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await groupLocale(chat.id)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  const replied = await gateway.fetchRepliedMessage(message)
  await dropCommand()
  if (!replied || !(replied.sender instanceof User)) {
    const sent = await tgSendText(chat.id, viewHtml(locale.profile.checkNeedReply)).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'check')
    return
  }
  const target = replied.sender

  const facts = await buildLiveFacts(chat.id, target)
  log.info('check', { chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName, by: caller.id })
  const checkPolicy = groupDocToChatPolicy(await store.getGroupDoc(chat.id).catch(() => null) as never)
  const card = userProfileCard(locale, facts, {
    chatId: chat.id,
    isTrusted: checkPolicy.trustedUserIds.includes(target.id)
  })
  const sent = await tgSendText(chat.id, viewHtml(card.text), {
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
 *
 * Raising the alarm is open to everyone; only the ballot needs standing. See
 * the eligibility block below for why the two rights are split.
 */
const handleReport = async (message: Message, chat: Chat, reporter: User): Promise<void> => {
  const locale = await groupLocale(chat.id)
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
  const textPreview = truncate(fullText, 200)
  // Through the normalizer rather than reading `replied.media` here: it is the
  // one place that knows every TL constructor, and a ballot that misnames what
  // it is asking about is the thing this is meant to stop.
  const media = mediaCategoryOf(normalizeMessage(replied).attachments)
  await store.openVote({
    chatId: chat.id,
    messageId: replied.id,
    targetUserId: target.id,
    targetLabel: target.displayName,
    textPreview,
    media,
    learnText: fullText,
    openedBy: reporter.id
  }).catch(() => false) // duplicate vote → just add the ballot below

  const reporterStanding = await voterStandingFor(chat.id, reporter.id, target.id)
  const reporterIsAdmin = reporterStanding.isAdmin
  log.info('report', {
    chatId: chat.id, chat: chat.title ?? undefined, userId: target.id, user: target.displayName,
    by: reporter.id, byName: reporter.displayName, byAdmin: reporterIsAdmin, messageId: replied.id,
    text: textPreview ? truncate(textPreview, 160) : undefined
  })
  /**
   * Reporting and voting are different rights, on purpose. Anyone may raise
   * the alarm — that is the channel through which the chat tells us about spam
   * we missed, and closing it to newcomers would close it to exactly the people
   * a fresh spam wave lands on. Deciding the question is what needs standing,
   * so an ineligible report opens the vote and casts nothing.
   */
  if (voteEligibility(reporterStanding) === 'eligible') {
    await store.castBallot({
      chatId: chat.id, messageId: replied.id,
      userId: reporter.id, isAdmin: reporterIsAdmin, choice: 'spam',
      label: reporter.displayName
    }).catch(() => { /* vote may have closed a moment ago */ })
  }
  await dropCommand()

  const vote = await store.getVote(chat.id, replied.id).catch(() => null)
  if (!vote || vote['status'] !== 'open') return
  const tally = tallyVotes((vote['ballots'] ?? []) as VoteBallot[])

  if (tally.outcome === 'spam') {
    // Admin ballot resolved instantly.
    if (!(await store.closeVote(chat.id, replied.id, 'spam'))) return
    log.info('vote_resolved', { chatId: chat.id, userId: target.id, messageId: replied.id, outcome: 'spam', by: 'admin_report' })
    const enforced = await enforceVoteSpam({
      chatId: chat.id, messageId: replied.id, targetUserId: target.id, learnText: fullText,
      tally: { spam: tally.spam, ham: tally.ham }
    }, 'admin_report')
    /**
     * The action is read off what happened, not asserted.
     *
     * This used to be a hard-coded `action: 'mute'` with `banDurationSeconds:
     * null` — a notice announcing a mute the bot may never have applied, and
     * announcing it without the duration it did apply. When neither the delete
     * nor the mute lands there is no enforcement to announce at all, and
     * `compactNotification` rightly refuses to render one: the chat gets the
     * missing-rights notice instead, which is the true and actionable thing.
     */
    const action = enforced.muted ? 'mute' : enforced.deleted ? 'delete' : 'observe'
    const verdict: Verdict = {
      pSpam: 0.99, action, needsVote: false,
      banDurationSeconds: enforced.muted ? MUTE_AFTER_VOTE_SECONDS : null,
      decidedBy: 'deterministic',
      ruleId: 'admin_report', signals: [], reasonCode: 'admin_report',
      reasonEvidence: textPreview || null, meta: {}
    }
    rememberVerdict(chat.id, replied.id, verdict)
    if (action === 'observe') {
      const warned = await tgSendText(chat.id, viewHtml(locale.notification.missingRights))
        .catch(() => null)
      if (warned) scheduleDelete(chat.id, warned.id, NOTIFY_TTL_COMPACT_MS, 'missing_rights:admin_report')
    } else {
      const view = compactNotification(locale, verdict, {
        chatId: chat.id, messageId: replied.id, userId: target.id, userLabel: target.displayName
      }, { botUsername: selfUsername ?? undefined })
      const sent = await tgSendText(chat.id, viewHtml(view.text), {
        replyMarkup: toKeyboard(view.buttons),
        // The inline "why?" link must not drag a preview card of our own bot
        // under a notice whose whole point is being one line.
        disableWebPreview: true
      }).catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_COMPACT_MS, 'mod_event:admin_report')
    }
    // An admin arriving mid-vote closes the question, and the prompt it was
    // asked through must stop asking. Without this the buttons stayed live on a
    // closed vote and answered "already ended" to every tap, forever: the
    // expiry sweep only claims votes still marked open.
    const openPrompt = vote['promptMessageId']
    if (typeof openPrompt === 'number') {
      const receipt = voteResult(await groupLocale(chat.id), {
        chatId: chat.id, messageId: replied.id,
        userId: target.id, userLabel: target.displayName
      }, 'spam', { botUsername: selfUsername ?? undefined, enforced })
      await tgEditMessage({
        chatId: chat.id, message: openPrompt,
        text: viewHtml(receipt.text), replyMarkup: toKeyboard(receipt.buttons),
        // The "why?" anchor points at our own bot; without this a preview card
        // of it unfurls under a one-line receipt.
        disableWebPreview: true
      }).catch(() => { /* prompt already gone */ })
      scheduleDelete(chat.id, openPrompt, NOTIFY_TTL_VOTE_RESULT_MS, 'vote_result')
    }
    return
  }

  // Community path: post (or refresh) the vote prompt.
  // No `botUsername` here on purpose: a ballot opened by a person has no bot
  // reasoning behind it to link to, and `recallVerdict` would answer the deep
  // link with "expired" — a link that leads to a shrug is worse than none.
  const view = votePrompt(locale, {
    chatId: chat.id, messageId: replied.id,
    userId: target.id, userLabel: target.displayName, textPreview, media
  }, tally)
  if (vote['promptMessageId']) {
    await tgEditMessage({
      chatId: chat.id, message: vote['promptMessageId'] as number,
      text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons),
      disableWebPreview: true
    }).catch(() => { /* unchanged */ })
  } else {
    const prompt = await tgSendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons),
      disableWebPreview: true
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
  const follow = await tgSendText(chatId, viewHtml(opts.caption), reply)
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
  bio: null, businessTexts: [], avatars: null, unofficialClientRisk: null,
  personalChannelId: null, linkedChannel: null, latestAvatar: null
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

const maybeSendJoinSurgeAlert = async (chat: Chat): Promise<void> => {
  const alert = joinRate.takeSurgeAlert(chat.id)
  if (!alert) return
  const groupDoc = await store.getGroupDoc(chat.id).catch(() => null)
  const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
  const buttons = selfUsername
    ? settingsDeepLink(locale, selfUsername, chat.id).buttons
    : []
  const sent = await tgSendText(
    chat.id,
    viewHtml(locale.welcome.surgeAlert(alert.total, alert.riskCount)),
    { ...(buttons.length > 0 ? { replyMarkup: toKeyboard(buttons) } : {}) }
  ).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_COMPACT_MS, 'join_surge')
}

/**
 * Lookups already on the wire, so concurrent screenings of one account collapse
 * into a single `photos.getUserPhotos` — the same guard `chat-profile.ts` needed
 * for chat descriptions, and for the same reason.
 */
const joinerAvatarsInFlight = new Map<number, Promise<string | null>>()

/**
 * The joiner's avatar bytes, at most one download per account per TTL.
 *
 * This path used to WRITE `avatarCache` without ever reading it, so a spammer
 * seeding six chats — or, before update deduplication, one join delivered more
 * than once — paid a fresh `photos.getUserPhotos` and a fresh moderation call
 * every time. Production 2026-08-21 ended that burst in a flood wait, which
 * stalls the shared connection and with it moderation everywhere. The message
 * path had already learned this twice; the join path had not.
 *
 * `screenJoinerAvatars` is fire-and-forget, so several runs genuinely overlap —
 * a plain cache read is not enough on its own, hence the in-flight map.
 */
const joinerAvatar = async (userId: number): Promise<string | null> => {
  const cached = avatarCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.base64
  const pending = joinerAvatarsInFlight.get(userId)
  if (pending) return pending
  const task = downloadAvatarBase64(gateway.tg, userId)
    .then((base64) => {
      pruneExpired(avatarCache, AVATAR_CACHE_MAX)
      avatarCache.set(userId, { base64, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS })
      return base64
    })
    .catch(() => null)
    .finally(() => { joinerAvatarsInFlight.delete(userId) })
  joinerAvatarsInFlight.set(userId, task)
  return task
}

const screenJoinerAvatars = async (chat: Chat, joiners: User[]): Promise<void> => {
  // A bulk add can carry dozens of users; screening all of them sequentially
  // would stall the update loop and burn a moderation call each. The cap keeps
  // the join path bounded — the authoritative check still runs per message.
  const candidates = joiners.filter((joiner) => joiner.id !== selfId)
  const granted = Math.min(JOIN_SCREEN_MAX, joinRate.claimScreening(chat.id, candidates.length))
  for (const joiner of candidates.slice(0, granted)) {
    const history = await store.getUserDoc(joiner.id)
      .then((doc) => userDocToHistory(doc as never, 0))
      .catch(() => null)
    if (history?.externalBan?.banned) {
      joinRate.noteRisk(chat.id, joiner.id)
      await maybeSendJoinSurgeAlert(chat)
    }
    if (!ports.moderation) continue
    const base64 = await joinerAvatar(joiner.id)
    if (!base64) continue
    try {
      const result = await ports.moderation.check('', base64)
      // The same question the message path asks, for the same reason: the
      // provider's `flagged` boolean spans violence and self-harm, and an
      // `nsfw_avatar_join` raised over a war photograph is a log line that
      // teaches admins to ignore the log.
      const hit = nsfwProfileHit(result)
      if (hit) {
        log.info('nsfw_avatar_join', {
          chatId: chat.id, chat: chat.title ?? undefined, userId: joiner.id, hit
        })
        joinRate.noteRisk(chat.id, joiner.id)
        await maybeSendJoinSurgeAlert(chat)
      }
    } catch { /* dead key / API error surfaces via the message-path meta log */ }
  }
}

/** Greet new members when welcome is enabled (off by default). */
const handleWelcomeGreeting = async (message: Message, chat: Chat, joiners: User[]): Promise<void> => {
  if (joiners.length === 0) return
  const welcome = await store.getWelcome(chat.id).catch(() => null)
  if (!welcome || !welcome.enable) return
  if (!joinRate.claimWelcome(chat.id)) return
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
    : await tgSendText(chat.id, viewHtml(body), { replyTo: message.id })
        .then((m) => [m.id])
        .catch((err) => { log.warn('welcome_send_failed', { chatId: chat.id, kind: 'text', err: String(err) }); return [] })
  for (const id of sentIds) scheduleDelete(chat.id, id, welcome.timer * 1000, 'welcome')
  // Attached to the arrival, so a verdict that removes one of these people
  // takes our own greeting of them down along with the join notice.
  arrivals.noteGreeting(chat.id, joiners.map((j) => j.id), sentIds)
  // The service message id is what makes a repeat diagnosable: the same id
  // twice is a redelivery, two ids is a person who really did join twice.
  // Without it, production 2026-08-21 (one joiner greeted twelve times) could
  // not be attributed to either.
  log.info('welcome', {
    chatId: chat.id, chat: chat.title ?? undefined,
    messageId: message.id, joiners: joiners.map((j) => j.id)
  })
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
  const locale = await groupLocale(chat.id)
  const ack = async (text: string): Promise<void> => {
    const sent = await tgReplyText(message, viewHtml(text)).catch(() => null)
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
  const toggled = await store.setWelcomeEnabled(chat.id, !current.enable)
    .then(() => true).catch(() => false)
  log.info('welcome_toggle', { chatId: chat.id, by: caller.id, enabled: !current.enable, ok: toggled })
  // "Увімкнув" over a write that failed leaves the admin waiting for greetings
  // that will never come, with nothing to suggest looking again.
  await ack(!toggled
    ? locale.writeFailed
    : !current.enable ? locale.welcome.enabled : locale.welcome.disabled)
}

/**
 * /extra <name> (admin): reply to a message → save it under #name; no reply →
 * delete that extra. /extras → list names. Triggers fire on #name hashtags.
 */
const handleExtraCommand = async (message: Message, chat: Chat, caller: User, name: string | undefined): Promise<void> => {
  const locale = await groupLocale(chat.id)
  if (!(await isChatAdmin(chat.id, caller.id))) return
  const dropCommand = (): Promise<void> =>
    gateway.tg.deleteMessagesById(chat.id, [message.id]).catch(() => { /* no rights */ })
  if (!name) {
    await sendView(message, { text: locale.extra.usage, buttons: [] })
    return
  }
  const cleanName = name.replace(/^#/, '')
  /**
   * The same bar the PM editor applies, which this path did not.
   *
   * Two separate consequences of skipping it. A name is interpolated into
   * Telegram HTML by every acknowledgement and by the list, so `<b>x</b>`
   * restyled the reply — and a name holding anything a hashtag cannot contain
   * was reported as saved while being unable to ever fire, because the trigger
   * matches `#name` in chat text.
   */
  if (!/^[\p{L}\p{N}_]+$/u.test(cleanName)) {
    await dropCommand()
    const bad = await tgSendText(chat.id, viewHtml(locale.extra.editor.invalidName)).catch(() => null)
    if (bad) scheduleDelete(chat.id, bad.id, NOTIFY_TTL_BANAN_MS, 'extra_invalid')
    return
  }
  const shown = escapeName(cleanName)
  const replied = await gateway.fetchRepliedMessage(message)
  if (replied) {
    const extra: NormalizedExtra = { name: cleanName, text: replied.text ?? '', fileId: mediaFileId(replied) }
    const saved = await store.saveExtra(chat.id, extra).then(() => true).catch(() => false)
    log.info('extra_saved', { chatId: chat.id, by: caller.id, name: cleanName, hasMedia: extra.fileId !== null, ok: saved })
    await dropCommand()
    const sent = await tgSendText(chat.id, viewHtml(saved ? locale.extra.saved(shown) : locale.writeFailed))
      .catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'extra_ack')
    return
  }
  const removed = await store.deleteExtra(chat.id, cleanName).catch(() => false)
  await dropCommand()
  if (removed) log.info('extra_deleted', { chatId: chat.id, by: caller.id, name: cleanName })
  const sent = await tgSendText(chat.id, viewHtml(removed ? locale.extra.deleted(shown) : locale.extra.notFound(shown))).catch(() => null)
  if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_BANAN_MS, 'extra_ack')
}

const handleExtraList = async (message: Message, chat: Chat, caller: User): Promise<void> => {
  const locale = await groupLocale(chat.id)
  const extras = await store.getExtras(chat.id).catch(() => [])
  const text = extras.length === 0
    ? locale.extra.listEmpty
    : [locale.extra.listTitle, '', ...extras.map((e) => `#${e.name}`)].join('\n')
  const sent = await tgReplyText(message, viewHtml(text)).catch(() => null)
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
      await tgReplyText(message, viewHtml(escapeName(extra.text)))
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
  const locale = await groupLocale(chat.id)
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
  const sent = await tgReplyText(message, viewHtml(view.text)).catch(() => null)
  if (sent) {
    scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'cmd_top')
    scheduleDelete(chat.id, message.id, NOTIFY_TTL_TOP_MS, 'cmd_top')
  }
}

/**
 * True only if we KNOW this user is an admin here, from the cache and without a
 * network call.
 *
 * The incident short-circuit runs before any enrichment, and asking Telegram
 * would spend the very call the short-circuit exists to avoid. A cache miss
 * reads as "not known to be an admin", which is safe here for a specific
 * reason: an incident only exists because `applyVerdict` already removed this
 * sender, and it refuses to touch admins — so the cache was warm and said no
 * when the incident opened. The window this leaves is a promotion inside the
 * incident's ten minutes, and a failed delete closes the incident anyway.
 */
const knownAdmin = (chatId: number, userId: number): boolean =>
  memberFacts.peek(chatId, userId)?.isAdmin === true

/**
 * Re-render the incident's card in place with the running count.
 *
 * Editing rather than posting is the whole point: a run of eight messages used
 * to leave eight cards, so the chat read our bookkeeping instead of the
 * conversation. The verdict is recalled rather than stored on the incident —
 * `recentVerdicts` holds it for exactly this kind of lookup, and after a restart
 * `pipeline_decisions` answers instead.
 */
const refreshIncidentCard = async (
  chatId: number,
  userId: number,
  incident: Incident,
  userLabel: string,
  locale: Locale
): Promise<boolean> => {
  if (incident.cardMessageId === null) return false
  const verdict = await recallVerdict(chatId, incident.triggerMessageId)
  // `compactNotification` speaks only for enforcement actions, and a recalled
  // verdict that is not one means the card we are holding is not ours.
  if (!verdict || verdict.action === 'none' || verdict.action === 'observe') return false
  const view = compactNotification(locale, verdict, {
    chatId, messageId: incident.triggerMessageId, userId, userLabel
  }, { botUsername: selfUsername ?? undefined, incidentCount: incident.removedCount })
  // The count is in the text and rises with every message, so an edit that
  // "changed nothing" is not a case that arises — a failure here means the card
  // is gone (its 90-second TTL expired under a run that is allowed ten minutes),
  // and the caller posts a fresh one rather than leaving the run unannounced.
  return await tgEditMessage({
    chatId, message: incident.cardMessageId,
    text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons),
    disableWebPreview: true
  }).then(() => true).catch(() => false)
}

/**
 * A message from a sender we have already removed from this chat.
 *
 * Everything the pipeline would do here has been done: the evidence was weighed
 * once, cleared the bar for taking the chat away from this account, and the
 * account was removed. What arrives after that is the tail of a flood — messages
 * already in flight, or a mute that does not stop the client from trying — and
 * judging each of them again buys nothing but a bill.
 *
 * So: no enrichment, no ports, no classifier, no second card and no second
 * decision record. The one thing that DOES happen is the count, because a
 * correction has to be able to say how many messages the verdict cost.
 */
const silenceUnderIncident = async (params: {
  chat: Chat
  senderId: number
  senderLabel: string
  messageId: number
  /** Album parts delivered with it — one post, so they go together. */
  albumIds: readonly number[]
  incident: Incident
  locale: Locale
}): Promise<void> => {
  const { chat, senderId, messageId, incident } = params
  const deleted = await gateway.tg.deleteMessagesById(chat.id, [messageId, ...params.albumIds])
    .then(() => true)
    .catch(() => false)
  if (!deleted) {
    // Telegram refusing the delete is the only evidence we get that our standing
    // in this chat has changed — rights revoked, or the sender back and legitimate.
    // Closing the incident sends the next message through the full pipeline,
    // which is the honest default when we no longer know where we stand.
    incidents.close(chat.id, senderId)
    log.warn('incident_echo_failed', { chatId: chat.id, userId: senderId, messageId })
    return
  }
  const updated = incidents.addRemoved(chat.id, senderId, 1 + params.albumIds.length) ?? incident
  await store.appendIncidentMessage(chat.id, incident.triggerMessageId, [messageId, ...params.albumIds])
    .catch(() => { /* telemetry must never break moderation */ })
  // The card, if it is still up. It lives ninety seconds and the run lives ten
  // minutes, so most of a long flood is announced once and then simply stops
  // arriving — which is the quiet this whole path exists to produce. The count
  // keeps rising either way, because a correction still has to be able to say
  // what the verdict cost.
  log.info('incident_echo', {
    chatId: chat.id, chat: chat.title ?? undefined, userId: senderId, user: params.senderLabel,
    messageId, action: incident.action, reason: incident.reasonCode,
    // The saving, stated in the log so it can be counted rather than assumed.
    removed: updated.removedCount, sinceMs: Date.now() - incident.openedAt
  })
  await refreshIncidentCard(chat.id, senderId, updated, params.senderLabel, params.locale)
}

const handleMessage = async ({ message, isEdit, albumSiblings }: IncomingMessage): Promise<void> => {
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
      const rate = joinRate.note(chat.id, joiners.length, joiners.map((joiner) => joiner.id))
      if (rate.started) {
        log.info('join_surge', { chatId: chat.id, count: rate.total, windowMs: JOIN_WINDOW_MS })
        void maybeSendJoinSurgeAlert(chat).catch(() => { /* best-effort */ })
      }
      // Noted before the greeting and independently of it: the service line is
      // Telegram's own and exists whether or not this chat greets anybody.
      arrivals.noteJoin(chat.id, joiners.map((joiner) => joiner.id), message.id)
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
   * Which senders are skipped, and why, is `shouldScanChannelSender` — the
   * anonymous-admin case used to be claimed here and not actually implemented,
   * because it has no marker of its own and is only visible as `senderId ===
   * chatId` (production 2026-07-31 reached a ban verdict on a chat's own post).
   */
  const userSender = rawSender instanceof User ? rawSender : null
  const channelSender = !userSender && rawSender instanceof Chat && shouldScanChannelSender({
    senderId: rawSender.id,
    chatId: chat.id,
    isAutomaticForward: message.isAutomaticForward,
    isChannelPost: message.isChannelPost
  })
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
      const locale = await groupLocale(chat.id)
      await sendView(message, settingsDeepLink(locale, selfUsername, chat.id))
      return
    }
    if (/^\/start(@\w+)?$/.test(commandText)) {
      const locale = await groupLocale(chat.id)
      await sendView(message, startGroupHint(locale))
      return
    }
    /**
     * `/help` answers with the help.
     *
     * It used to answer with the group hint — whose own text says "/help
     * команди". Someone following the instruction printed in front of them got
     * the same instruction back, forever. The button beside it did work, but a
     * typed command that loops reads as a broken bot, not as a hint to tap.
     *
     * It is a wall of text in a group, so it cleans itself up on the same timer
     * `/top` uses: long enough to read, short enough not to live there.
     */
    if (/^\/help(@\w+)?$/.test(commandText)) {
      const locale = await groupLocale(chat.id)
      const sent = await tgReplyText(message, viewHtml(helpView(locale).text), {
        disableWebPreview: true
      }).catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'help')
      return
    }
    /**
     * `/lang` is advertised by the help text and had no branch at all, so it
     * fell through to the spam pipeline and did nothing visible.
     *
     * Two different settings share the word. A member changing "my language"
     * changes what the bot says to THEM, which is a PM matter. An admin
     * changing the group's language changes what the chat reads, and that lives
     * in the settings panel. So the reply points at whichever the caller can
     * actually do.
     */
    if (/^\/lang(@\w+)?$/.test(commandText) && selfUsername) {
      const locale = await groupLocale(chat.id)
      const view = await isChatAdmin(chat.id, userSender.id)
        ? settingsDeepLink(locale, selfUsername, chat.id)
        : {
          text: locale.lang.openInPm,
          buttons: [[{ text: locale.lang.openButton, url: `https://t.me/${selfUsername}?start=lang` }]]
        }
      await sendView(message, view)
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
      const locale = await groupLocale(chat.id)
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
      const sent = await tgReplyText(message, '🏓 pong').catch(() => null)
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

  /**
   * The sender is already out of this chat by a verdict of ours, minutes ago.
   *
   * Placed here on purpose: after the commands, because a removed sender has no
   * commands to give, and BEFORE the hashtag utilities, because somebody we are
   * mid-way through removing does not get to trigger the chat's extras either.
   *
   * The two guards are defence in depth. An incident cannot open for an admin or
   * a trusted member — `applyVerdict` refuses to act on them, and no application
   * means no incident — but trust can be GRANTED in the meantime, by an override
   * or a ham vote, and that must take effect on the next message rather than in
   * ten minutes.
   */
  if (policy.enabled) {
    const memo = incidents.silencing(chat.id, sender.id)
    if (memo &&
        !policy.trustedUserIds.includes(sender.id) &&
        !knownAdmin(chat.id, sender.id)) {
      await silenceUnderIncident({
        chat,
        senderId: sender.id,
        senderLabel: sender.displayName,
        messageId: message.id,
        albumIds: albumSiblings.map((part) => part.id),
        incident: memo,
        locale: resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
      })
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

  // Telegram has refused us both message removal and sender actions here, so
  // there is no verdict we could act on. Keep asking the admins for rights, but
  // stop paying for enrichment and LLM calls to reach a conclusion nothing can
  // be done with.
  //
  // What lifts the block is one cheap membership lookup, rate-limited to at
  // worst a quarter of an hour, so rights granted later resume moderation
  // without a restart — and, since 2026-08-07, a restart no longer resumes it
  // for free either: the refusal is a persisted fact, not an expiry the process
  // forgets when it dies.
  if (rights.cannotEnforce(chat.id) && !(rights.mayProbe(chat.id) && await probeRights(chat.id))) {
    log.debug('enforcement_blocked', { chatId: chat.id, chat: chat.title ?? undefined })
    if (shouldWarnMissingRights(chat.id, ['CHAT_ADMIN_REQUIRED'])) {
      const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
      const sent = await tgSendText(chat.id, viewHtml(locale.notification.missingRights))
        .catch(() => null)
      if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_TOP_MS, 'missing_rights')
      log.warn('missing_rights', {
        chatId: chat.id, chat: chat.title ?? undefined, action: 'all', blocked: true
      })
    }
    return
  }

  /**
   * Where the time before the pipeline goes.
   *
   * `portMs` covers the pipeline's own stages and nothing else, so everything
   * here — the replied message, Mongo, `getFullUser`, `getChatMember`, the
   * lols/CAS HTTP call, the chat description — was invisible. A deterministic
   * verdict runs no ports at all, and one of those took 4.4 seconds on
   * 2026-07-31 with a log line that could only say `latencyMs`. Same fix as
   * `portMs`, one layer up: name each call and what it cost.
   */
  const enrichMs: string[] = []
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now()
    try {
      return await run()
    } finally {
      enrichMs.push(`${name}=${Date.now() - at}`)
    }
  }

  // ── normalize (budget call 1: replied message, only for replies) ───
  const replied = await timed('reply', () => gateway.fetchRepliedMessage(message))
  // What this message said last time, when it is an edit and anybody remembers.
  const previousBaseline = isEdit
    ? await timed('baseline', () => recallEditBaseline(chat.id, message.id))
    : null
  const normalized = normalizeMessage(message, {
    isEdit,
    repliedMessage: replied,
    previousBaseline,
    // The rest of the album, so a caption riding on the ninth photo is read as
    // part of this post rather than never at all.
    albumSiblings
  })
  // Remembered for the NEXT edit, including when this delivery was itself an
  // edit: the honest question is what a given edit injected, not what has
  // accumulated since the original.
  rememberEditBaseline(chat.id, message.id, editBaselineOf(normalized))

  // ── user snapshot ───────────────────────────────────────────────────
  const memberCount = await timed('mongo', async () => {
    await store.touchUser(sender.id).catch(() => { /* counters are best-effort */ })
    // Increments the per-chat counters and returns the pre-increment standing —
    // exactly what the "new in chat" signal must see.
    return store.touchMember(chat.id, sender.id, normalized.text.length).catch(() => 0)
  })
  const userDoc = await timed('userdoc', () => store.getUserDoc(sender.id).catch(() => null))
  const history = userDocToHistory(userDoc as never, memberCount)

  const newish = (history?.messagesGlobal ?? 0) <= 5 || memberCount <= 3

  /**
   * Whether the sender will be waved through by the core's established-regular
   * fast path anyway (same thresholds). Mirrored here only to decide whether
   * paying for enrichment is worth it — the authoritative exempt still lives in
   * the pipeline, where hard account verdicts can cancel it.
   */
  const localTenureDays = history?.firstSeenUnix != null
    ? (Date.now() / 1000 - history.firstSeenUnix) / 86_400
    : null
  const exemptish = (memberCount >= 10 || (history?.messagesGlobal ?? 0) >= 50) &&
    localTenureDays !== null && localTenureDays >= ESTABLISHED_MIN_TENURE_DAYS

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
    ? await timed('profile', () => cachedUserProfile(userSender.id))
    : EMPTY_PROFILE

  /**
   * Authoritative chat join time (channels.getParticipant). One admin-only call,
   * so it is asked for only when the answer can change a decision.
   *
   * Two cases now, not one. The original is "joined seconds ago then posted" —
   * the drive-by, which is what `newish` selects. The second arrived with
   * `tenureDays` (2026-08-20): this date is also the only tenure fact that
   * survives our own database, and a short or missing local record is exactly
   * when our clock cannot be trusted. Gating on `newish` alone would have left
   * the shield unavailable precisely where it is needed — for the member whose
   * counters look established while our first-seen row was recreated yesterday.
   *
   * Self-limiting: it stops firing for an account once our own record of them
   * passes the tenure bar, so this is a call per sender for their first week,
   * not a call per message forever. Degrades to null on anything unexpected.
   */
  const tenureUncertain = localTenureDays === null ||
    localTenureDays < ESTABLISHED_MIN_TENURE_DAYS
  let joinedAgoSeconds: number | null = null
  if (newish || tenureUncertain) {
    const joinedDate = await timed('joined', () =>
      gateway.tg.getChatMember({ chatId: chat.id, userId: sender.id })
        .then((m) => m?.joinedDate ?? null)
        .catch(() => null))
    if (joinedDate) joinedAgoSeconds = Math.max(0, (Date.now() - joinedDate.getTime()) / 1000)
  }

  // External ban databases (lols/CAS): one cheap HTTP call, so it runs for
  // EVERY sender (not just newish) — an established member added to CAS
  // tomorrow must still be re-checked once the TTL lapses. Persist the
  // result and use it for THIS message so a first post is caught.
  //
  // The cached answer is gated too, not just the refresh. Until 2026-08-24 only
  // the lookup below sat behind the setting, while the line seeding the variable
  // did not — so a chat that had turned the ban databases OFF still received
  // whatever a chat with them ON had written to the shared user document, and
  // acted on it: the `external_ban` signal at weight 2.5, the `external_ban_new`
  // rule, and the veto on standing. The switch stopped new questions and let
  // every old answer through, which is the one behaviour its label rules out.
  //
  // Gating the SNAPSHOT rather than each reader is deliberate. There were three
  // consumers and each had to remember the setting; one of them, the pipeline's
  // hard-verdict test, was the only one that did. Now the fact simply is not
  // there, and every reader downstream agrees without being told.
  let externalBan = policy.externalBanEnabled ? (history?.externalBan ?? null) : null
  if (policy.externalBanEnabled) {
    const cached = (userDoc as { externalBan?: ExternalBanCacheView } | null)?.externalBan
    // Per source: a fresh lols answer must not be thrown away because CAS is
    // stale, and a source that just failed must not be asked again on the very
    // next message. Both used to happen — see EXTERNAL_BAN_RETRY_MS.
    const sources = sourcesToQuery(cached, Date.now())
    if (sources.lols || sources.cas) {
      const fresh = await timed('extban', () => fetchExternalBan(sender.id, { sources }))
      if (fresh) {
        // An outage in a ban database has to be visible while it is happening.
        // 2026-08-18, ~10:45 to ~17:30: one source timed out at its 2s ceiling
        // and the only trace was the `extban` field of unrelated log lines
        // reading 2001. The cache knew (`failedAt`, 10-minute retry) and said
        // nothing out loud, so every verdict in the window silently rested on
        // one database instead of two.
        if (fresh.failed.lols || fresh.failed.cas) {
          log.warn('external_ban_source_down', {
            chatId: chat.id,
            userId: sender.id,
            down: (['lols', 'cas'] as const).filter((n) => fresh.failed[n]).join('+'),
            // What DID answer, so one line says whether the lookup was blind or
            // merely one-eyed.
            answered: (['lols', 'cas'] as const).filter((n) => fresh[n] !== null).join('+') || 'none'
          })
        }
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
        {
          unofficialClientRisk: profile.unofficialClientRisk,
          joinedAgoSeconds,
          joinedDuringSurge: joinRate.joinedDuringSurge(chat.id, userSender.id)
        }
      )
    : buildChannelSnapshot(channelSender!, history)

  // Photo for LLM vision — only when a newish user posts media.
  //
  // The FIRST part's photo, for an album. The other parts' images are not sent
  // to vision or to moderation: ten images is ten times the bill for a marginal
  // gain, and their captions — which is where albums carry their text — are
  // merged into the judged message either way.
  const photoBase64 = newish && message.media?.type === 'photo'
    ? await downloadPhotoBase64(gateway.tg, message.media)
    : null

  // NSFW moderation of profile media — newish senders only (this gate is what
  // makes nsfw_avatar/nsfw_stories new-account signals). Avatar reuses bytes
  // cached at join when fresh; stories are best-effort (user-only surface).
  let avatarBase64: string | null = null
  let storyBase64: string[] = []
  let linkedChannelAvatar: string | null = null
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
    // The picture of the channel the profile points at, on the same gate and
    // from bytes `fetchUserProfile` already has.
    if (profile.linkedChannel?.photo) {
      linkedChannelAvatar = await rawPhotoToBase64(
        gateway.tg, profile.linkedChannel.photo, AVATAR_MAX_BYTES)
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

  // Where the links in THIS message go, read from Telegram's public web
  // preview. Deliberately NOT gated on newness, unlike the profile media above:
  // the lookup exculpates as often as it accuses, and the case that prompted it
  // was a member with standing pasting an invite into a conversation that had
  // asked for one. Gating it on newness would have withheld it from exactly
  // that person. Bounded instead by what it costs: two links, resolved in
  // parallel, answers cached by URL for six hours.
  const messageChannels = await timed('tmelinks', async () => {
    const targets = normalized.urls
      .map((u) => u.target)
      .filter((t) => {
        const kind = classifyUrl(t).kind
        return kind === 'private_invite' || kind === 'telegram_internal'
      })
      .slice(0, 2)
    if (targets.length === 0) return []
    const previews = await Promise.all(targets.map((t) => resolveTmePreview(t)))
    return previews.flatMap((p): ChannelPreview[] => p === null ? [] : [{
      source: 'message_link' as const,
      title: p.title,
      description: p.description,
      subscribers: null,
      // The page's picture is a URL on Telegram's CDN, not bytes we hold, and
      // fetching it would be a second request per link for a signal the profile
      // path already covers. Text only.
      avatarBase64: null
    }])
  })

  /**
   * Where a t.me link in the PROFILE goes — the other half of the same lookup,
   * and the one this module was written for. `ChannelPreview` has carried
   * `source: 'bio_link'` since it was introduced and nothing ever produced one:
   * `extractLinkedChannelSignals` could already read a channel reached from a
   * bio, `label()` already had a phrase for it, `screenProfileMedia` already
   * screened it before the abstain gate. The only missing piece was the fetch.
   *
   * Not gated on newness, for the reason `profile` itself stopped being
   * (2026-07-30): gating the profile layer on newness makes it unreachable for
   * an account after six messages of "ok". Bounded by cost instead — one link,
   * the strongest one, answers cached by URL for six hours across every chat,
   * which is exactly what a bio copied between accounts is worth.
   *
   * Honest about direction: today this can only accuse. `private_invite_in_bio`
   * is raised on the link's shape whatever sits behind it, and nothing
   * subtracts when the destination turns out to be an ordinary community.
   *
   * The message path is only a little better and it is worth being exact about
   * how: a clean destination there does not lift `private_invite_link` either,
   * and `private_invite_new` still fires deterministically for an account with
   * no global history. What reading the destination buys on that side is
   * context for the LLM, for the sender who HAS history — which is exactly the
   * 2026-08-01 case it was built for. There is no such route here, because a
   * profile never reaches a content stage.
   *
   * Making this cut both ways would mean conditioning the weight on the
   * destination, and there is nothing labelled to price that with: the 62.5%
   * it was calibrated on is a rate over private-invite bios of every kind, so
   * subtracting for an ordinary-LOOKING preview would adjust twice for the same
   * mix. "No promo token in the blurb" is weak evidence of ordinary intent.
   */
  const bioChannels = await timed('biolinks', async () => {
    const target = strongestTelegramLink([profile.bio ?? '', ...profile.businessTexts])
    // Already in the list below, and asking again would be asking about the
    // same channel: a public link naming the account's own channel is the same
    // fact arriving by a second route.
    //
    // Identity, never resemblance. Comparing TITLES was the first version and it
    // was wrong twice over: channels share generic names constantly, so a bio
    // channel whose blurb is a price list would be discarded for agreeing with
    // an innocent personal channel called the same thing — and even for one
    // genuine channel, `channels.getFullChannel` can fail and leave the MTProto
    // description null while the web preview carries it, so the match would
    // throw away the richer of the two. A username is a name Telegram enforces
    // as unique; a title is a coincidence waiting to happen.
    if (target === null) return []
    if (target.username !== null &&
      target.username === profile.linkedChannel?.username?.toLowerCase()) return []
    const preview = await resolveTmePreview(target.url)
    if (preview === null) return []
    return [{
      source: 'bio_link' as const,
      title: preview.title,
      description: preview.description,
      subscribers: null,
      // Text only, like the message path: the picture is a URL on Telegram's
      // CDN rather than bytes we hold, and the profile path already covers
      // imagery.
      avatarBase64: null
    }]
  })

  // Free while the flow is here anyway; the PM "Why?" card reads it later.
  rememberChatTitle(chat.id, chat.title)

  const input: EvaluationInput = {
    message: normalized,
    chat: {
      id: chat.id,
      kind: normalized.channelComment ? 'discussion' : 'group',
      title: chat.title ?? '',
      // Best available proxy for the chat's main language until a stats layer
      // exists: the group's configured UI locale (uk/ru/en/by/tr).
      topLanguage: (groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale ?? null,
      // What the chat says it is for. Amortised to roughly one MTProto call per
      // chat per six hours, and null whenever the chat has none — no stage may
      // treat its absence as meaning anything.
      description: await timed('chatdesc', () => chatDescriptions.get(chat.id))
    },
    user,
    // The chat's stored settings plus one capability of the running bot: the
    // policy may offer a captcha under a channel post only if it can be
    // whispered to the commenter rather than posted into the thread.
    policy: { ...policy, ephemeralCaptcha: config.ephemeralCaptcha },
    enrichment: {
      bio: profile.bio,
      businessTexts: profile.businessTexts,
      personalChannelId: profile.personalChannelId,
      // What the profile points at, as far as we can see it. Shape, never
      // message evidence: it says the account is a promo vehicle, not that this
      // sentence is an advert.
      linkedChannels: [
        ...(profile.linkedChannel
          ? [{
              source: 'personal_channel' as const,
              title: profile.linkedChannel.title,
              description: profile.linkedChannel.description,
              subscribers: profile.linkedChannel.subscribers,
              avatarBase64: linkedChannelAvatar
            }]
          : []),
        ...bioChannels,
        ...messageChannels
      ],
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

  /**
   * The rest of the run goes with the sender.
   *
   * `applyVerdict` is given one message id, because a verdict is about one
   * message. Spam does not arrive that way: it arrives as a run, and the verdict
   * lands on whichever message finally crossed the bar — so banning the sender of
   * the sixth advert used to leave the first five in the chat for good.
   *
   * Only on `removesSender`, and only for messages the pipeline had already
   * declined to call clean (`BURST_GREY_FLOOR`, the same 0.35 that opens the
   * classifier's grey band). Both halves matter. Removing the person is the one
   * action that has passed `SENDER_REMOVAL_MIN_EVIDENCE`, and deleting is the one
   * thing an override cannot undo — so the blast radius of a false positive is
   * decided by this bar and nothing else. An ordinary exchange scores around 0.1,
   * which is what keeps the member who was mid-argument out of this.
   */
  /**
   * The rest of the album goes with the message.
   *
   * `applyVerdict` is given one message id because a verdict is about one
   * message — but an album is one message only to the sender, and to Telegram it
   * is N. Deleting the part the verdict landed on left the other nine photos of
   * an advert in the chat, which is most of the advert.
   *
   * Unconditional on the action, unlike the retro-purge below: every enforcement
   * action deletes the message, and these ids ARE the message. Nothing here is
   * a second judgement — the content of every part was already folded into the
   * text that was judged.
   */
  const albumIds = albumSiblings.map((part) => part.id)
  let albumRemoved = 0
  // `deleted`, like the conversation window below and for the same reason: the
  // question is whether the message went, and on a ban `applied` answers whether
  // the PERSON did. A ban the bot lacked the right to perform used to leave the
  // other nine photos of an advert standing next to the one it had successfully
  // deleted — the outcome this purge exists to prevent, produced by reading the
  // wrong field.
  if (result.deleted === true && isEnforcementAction(verdict.action) && albumIds.length > 0) {
    const purged = await gateway.tg.deleteMessagesById(chat.id, albumIds)
      .then(() => true)
      .catch(() => false)
    if (purged) albumRemoved = albumIds.length
    log.info('album_purge', {
      chatId: chat.id, chat: chat.title ?? undefined, userId: sender.id,
      user: sender.displayName, parts: albumIds.length, applied: purged,
      action: verdict.action
    })
  }

  let retroPurged = 0
  if (result.applied && removesSender(verdict.action)) {
    const targets = senderLog.purgeTargets(chat.id, sender.id, {
      except: message.id, minPSpam: BURST_GREY_FLOOR
    })
    if (targets.length > 0) {
      const purged = await gateway.tg.deleteMessagesById(chat.id, targets)
        .then(() => true)
        .catch(() => false)
      if (purged) retroPurged = targets.length
      // Either way the run is spent: a failed sweep must not be retried on the
      // next verdict against the same person, and a successful one has nothing
      // left to sweep.
      senderLog.forget(chat.id, sender.id)
      log.info('retro_purge', {
        chatId: chat.id, chat: chat.title ?? undefined, userId: sender.id,
        user: sender.displayName, messages: targets.length, applied: purged,
        action: verdict.action, minPSpam: BURST_GREY_FLOOR
      })
    }
  }

  /**
   * What this person's arrival left in the chat.
   *
   * Two messages announce a newcomer and neither is about anything they said:
   * Telegram's "joined" service line, and — when the chat has welcome on — our
   * greeting of them by name. Left up after a removal they stand next to the
   * hole where the advert was and reprint the display name twice, which for an
   * account whose name IS the advert (`promo_in_name`) undoes part of the
   * removal. The service line is the worse of the two: it has no timer at all.
   *
   * Gated on `removesSender`, not on the delete. A `delete` leaves the member in
   * the chat, so both messages are still true — and it is the action we measured
   * at 22.7 % overturned (2026-08-25), which is not a rate to hand an
   * irreversible second deletion to. Removal has passed
   * `SENDER_REMOVAL_MIN_EVIDENCE`, the same bar the retro-purge above rests on.
   *
   * `applied`, not `deleted`: the question is whether the PERSON went.
   */
  let arrivalPurged = 0
  if (result.applied && removesSender(verdict.action)) {
    const arrival = arrivals.take(chat.id, sender.id)
    // A bulk add produces one service line and one greeting for everybody in
    // it, and both are still true about the people we did not remove. Purging
    // would quietly erase their arrival as well, so a shared one stays.
    if (arrival && arrival.subjects > 1) {
      log.info('arrival_purge_kept', {
        chatId: chat.id, chat: chat.title ?? undefined, userId: sender.id,
        user: sender.displayName, subjects: arrival.subjects
      })
    } else if (arrival) {
      const ids = arrivalMessageIds(arrival)
      const dropped = ids.length > 0 && await gateway.tg.deleteMessagesById(chat.id, ids)
        .then(() => true)
        .catch(() => false)
      if (dropped) {
        arrivalPurged = ids.length
        // Each greeting had a persistent row waiting to delete it later; those
        // rows are now sweeps against messages that no longer exist.
        for (const id of arrival.greetingMessageIds) {
          await store.unscheduleDeletion(chat.id, id)
            .catch(() => { /* the sweep is harmless and the TTL collects it */ })
        }
      }
      log.info('arrival_purge', {
        chatId: chat.id, chat: chat.title ?? undefined, userId: sender.id,
        user: sender.displayName, messages: ids.length, applied: dropped,
        // Which of the two was there. A chat that hides join notices, or a
        // greeting that never sent, both read as "nothing happened" otherwise.
        service: arrival.serviceMessageId !== null,
        greeting: arrival.greetingMessageIds.length || undefined,
        action: verdict.action
      })
    }
  }

  // Operational log: one line per actioned message (and per skipped action),
  // so prod moderation is fully auditable from the container logs. Carries the
  // human context (chat title, sender name/@username, message text) so a line
  // is readable on its own without cross-referencing ids.
  const logContext = {
    chat: chat.title ?? undefined,
    user: sender.displayName,
    username: sender.username ?? undefined,
    text: normalized.text ? truncate(normalized.text, 160) : undefined,
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
      action: verdict.action, applied: result.applied,
      // Beside `applied`, never folded into it: on a removal `applied` is about
      // the SENDER, and `applied=false deleted=true` — the shape of a chat where
      // the bot may delete but not ban — used to read from a log line as though
      // nothing had happened at all.
      deleted: result.deleted ?? undefined,
      skipped: result.skippedReason ?? undefined,
      pSpam: Math.round(verdict.pSpam * 100) / 100, decidedBy: verdict.decidedBy,
      ruleId: verdict.ruleId ?? undefined, reason: verdict.reasonCode,
      // Permanent or timed, and for how long. Only meaningful for a ban, and
      // omitted otherwise. Added 2026-07-31 with the change that made a
      // third-party ban listing expire: the difference between a 30-day ban and
      // one that never lifts was invisible in the very log line that records it,
      // so the change could not be confirmed from production output.
      banFor: verdict.action === 'ban'
        ? (verdict.banDurationSeconds === null
            ? 'permanent'
            : `${Math.round(verdict.banDurationSeconds / 86400)}d`)
        : undefined,
      signals: formatSignals(verdict.signals),
      cappedFrom: verdict.meta['cappedFrom'] ?? undefined,
      // Everything below was already computed for exactly this purpose and then
      // never printed, so a verdict still could not be reconstructed from its
      // log line (2026-07-31). `scorePSpam` is what arithmetic said before any
      // model spoke — the gap between it and `pSpam` is the LLM's contribution.
      // `contentEvidence` is the quantity that licenses enforcing without
      // reading the message, so a surprising action is diagnosed by this number
      // and no other. `capped` names the correlated ceilings that bit.
      scorePSpam: verdict.meta['scorePSpam'] ?? undefined,
      contentEvidence: verdict.meta['contentEvidence'] ?? undefined,
      capped: verdict.meta['cappedGroups'] ?? undefined,
      // Which reason hit the imitable-act ceiling. `cappedFrom` alone says a
      // ceiling bit but not which one, and there are now two that produce the
      // same downgrade for opposite reasons — one because the pipeline stopped
      // believing its reason, this one because it believes it and still will not
      // remove somebody over an act members also perform.
      cappedImitable: verdict.meta['cappedImitable'] ?? undefined,
      // Present only when the message evidence WAS sufficient and the sender's
      // standing in the chat overruled it — the one branch whose cost is a
      // judgement call rather than a measurement, so it has to be countable.
      cappedStanding: verdict.meta['cappedStanding'] ?? undefined,
      llmKey: verdict.meta['llmKey'] ?? undefined,
      // The model is an environment variable, so it changes between restarts
      // with nothing in the data to say so (2026-08-07).
      llmModel: verdict.meta['llmModel'] ?? undefined,
      portMs: verdict.meta['portMs'] ?? undefined,
      // Everything the pipeline's own timings cannot see. A deterministic
      // verdict runs no ports, so without this a 4.4-second ban (2026-07-31)
      // had no explanation anywhere in its log line.
      enrichMs: enrichMs.length > 0 ? enrichMs.join(',') : undefined,
      // Who accused, and when. `external_ban_new` bans for 30 days on this
      // alone, without any stage reading the message, so the log line for the
      // action least able to justify itself has to carry its grounds.
      externalBan: user.externalBan?.banned
        ? `${user.externalBan.sources.join('+') || 'external'}${
            user.externalBan.bannedAt
              ? ` ${Math.round((Date.now() - user.externalBan.bannedAt.getTime()) / 86_400_000)}d`
              : ''
          }${user.externalBan.offenses > 1 ? ` ×${user.externalBan.offenses}` : ''}`
        : undefined,
      // A session verdict judged the sender's accumulated window, not the
      // message above: without the window the line cannot be reviewed.
      judged: typeof verdict.meta['judgedText'] === 'string'
        ? truncate((verdict.meta['judgedText'] as string).replace(/\n/g, ' ⏎ '), 300)
        : undefined,
      needsVote: verdict.needsVote || undefined,
      // Messages of the same run taken down with the sender. Absent when there
      // were none, so a line that carries it is a line worth reading twice.
      retroPurged: retroPurged || undefined,
      // Album parts taken down with the message they belong to. Absent for the
      // ordinary single message, so a line carrying it says "this was a post of
      // several parts and all of them went".
      albumRemoved: albumRemoved || undefined,
      // The join notice and our greeting, taken down with the person. Absent
      // when there was nothing to take — a removal further from the join than
      // `ARRIVAL_TTL_MS`, or a chat that hides join notices and has welcome off.
      arrivalPurged: arrivalPurged || undefined,
      errors: result.errors.length > 0 ? result.errors : undefined,
      latencyMs: Date.now() - started
    })
    // A refusal is the authoritative statement of what we may do here; remember
    // it per capability so the next messages are not evaluated at full price
    // for nothing.
    rights.noteOutcome(chat.id, result.errors)
    // Spam caught but we couldn't act → tell admins to grant rights (once/hr).
    //
    // Either half being refused counts. `!applied` alone missed the mirror case:
    // a ban that went through while the DELETE was forbidden left a rights error
    // recorded, `applied` true, and nobody told — so the one chat that needed
    // asking was the one that never got asked.
    const partlyRefused = !result.applied || result.deleted === false
    if (partlyRefused && shouldWarnMissingRights(chat.id, result.errors)) {
      const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)
      const sent = await tgSendText(chat.id, viewHtml(locale.notification.missingRights)).catch(() => null)
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

  // Standing was credited before the pipeline ran, because the count of prior
  // messages is an input to the verdict. A message we then judged to be spam
  // must not leave that credit behind: the newness signals, the trust weight and
  // the established-regular bypass all read those counters, so posting spam was
  // a way to buy the benefit of the doubt for the next one. Production
  // 2026-07-31: three senders, one advert reposted up to nine times into a
  // single chat, `new_globally` and `new_in_chat` dropping out of the signal
  // list as they went, the score falling 0.91 → 0.75 as the evidence grew.
  //
  // Unlike the conversation window below, this does NOT wait on
  // `result.applied`. Whether Telegram let us delete anything is a fact about
  // our rights in that chat, not about the sender — and a chat where enforcement
  // fails is precisely where the free standing piles up fastest.
  //
  // The second counter is about the ACCOUNT, not the message, and only firm
  // verdicts feed it — see `countsAsDetection`. Nothing in v2 wrote it until
  // 2026-08-01, which quietly disabled three mechanisms that read it: the
  // `prior_spam_detections` signal, the established-regular bypass, and the
  // shield that keeps an account with local standing at `mute` instead of
  // `ban`. The visible symptom was an advert reposted six times in a hundred
  // minutes, muted every time, never banned.
  // Both counters, not just the detection: a verdict the executor declined to
  // apply because of WHO sent it is not a finding about them, so neither the
  // standing debit nor the account record follows from it. `countsAgainstSender`
  // carries the distinction between "Telegram would not let us" (still counts)
  // and "we decided not to" (does not).
  if (isEnforcementAction(verdict.action) && countsAgainstSender(result.skippedReason)) {
    await store.adjustSpamMessages(chat.id, sender.id, 1, countsAsDetection(verdict))
      .catch(() => { /* counters are best-effort */ })
  }

  // The message joins the chat context only if it stayed in the chat —
  // deleted spam must not poison the window for the next evaluation.
  //
  // `deleted`, not `applied`. The question here is about the MESSAGE, and on a
  // ban or a kick `applied` answers a different one: whether the sender was
  // removed. In a chat where the bot may delete but not ban — the common shape
  // of a missing right — every banned spammer's text was therefore filed as
  // still present and fed to the next LLM prompt and to `isForeignScript`,
  // although the chat could no longer see it. The two facts were never
  // separable until `deleted` existed (2026-08-24).
  const removed = result.deleted === true && isEnforcementAction(verdict.action)
  if (!removed) {
    const line = conversationLineFor(normalized, { id: sender.id, isChannel: channelSender !== null })
    if (line) conversationWindow.record(chat.id, line)
  }

  /**
   * The sender's own run — recorded with what we made of this message, and
   * governed by the OPPOSITE rule to the conversation window above.
   *
   * That window is the chat's context and spam must not poison it. This one is
   * the sender's conduct, and their spam is precisely the thing worth
   * remembering: it is what tells the next evaluation that the run has been
   * scoring badly, and what decides which messages go if the sender does.
   *
   * Not for an established regular: the pipeline waves them through before it
   * reads any window, so recording theirs would be a write nothing ever reads.
   * Not for an edit either — the same message would be counted twice.
   */
  if (!isEdit && verdict.meta['established_regular'] !== true) {
    senderLog.note(chat.id, sender.id, message.id, verdict.pSpam)
    void burstPort.append(chat.id, sender.id, {
      text: normalized.text,
      pSpam: verdict.pSpam,
      at: Date.now()
    })
  }

  // ── record + notify ─────────────────────────────────────────────────
  await store.recordDecision({
    chatId: chat.id,
    userId: sender.id,
    messageId: message.id,
    textPreview: normalized.text,
    verdict,
    // Rides along so an edit arriving after a restart still has something to be
    // measured against, and so a replay can recompute the delta this verdict
    // was — or was not — given.
    editBaseline: editBaselineOf(normalized),
    /**
     * What actually happened, as opposed to what was decided.
     *
     * The record held only the verdict until 2026-08-24, so no query against
     * 244k stored decisions could answer the first question anyone asks of
     * them: was it carried out? A ban that Telegram refused, a verdict the
     * executor declined because the sender turned out to be an admin, and a ban
     * that went through were three identical rows. Every audit of this
     * pipeline's false positives had to assume enforcement it could not see,
     * and one earlier review drew the opposite conclusion from the same data —
     * that the bot was acting on almost nothing.
     *
     * `errors` is stored as a COUNT with the labels only. The messages are
     * Telegram's own strings, they are unbounded, and this collection is the
     * largest in a database that has been up against its quota twice.
     */
    execution: {
      applied: result.applied,
      deleted: result.deleted,
      skippedReason: result.skippedReason,
      failed: result.errors.map((e) => e.split(':')[0] ?? 'unknown'),
      albumRemoved,
      retroPurged
    },
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

  const enforced = verdict.action !== 'none' && verdict.action !== 'observe' && verdict.action !== 'captcha'

  /**
   * Knowledge outlives the attempt. Whether the bot holds a right in this chat
   * is a fact about permissions; whether a verdict is sound is a fact about the
   * verdict, and `shouldAutoLearn` already judges that one (a model or velocity
   * or an admin's own rule, pSpam ≥ 0.95, text distinctive enough to match on).
   *
   * These writes used to sit behind `result.applied`, which meant the chats
   * where the bot is weakest taught it nothing at all — and because signatures,
   * vectors and forward reputation are shared across every chat, one missing
   * right degraded detection everywhere. Production 2026-07-31: one advert
   * reposted seven times in a chat where the ban could not be executed cost
   * seven separate model calls and left nothing behind.
   */
  if (enforced) {
    void learnFromAutoVerdict(verdict, normalized.text, chat.id)
    // Forwarded spam builds the long-term reputation of its origin.
    if (normalized.forward && verdict.pSpam >= 0.9) {
      await forwardPort.reportSpam(normalized.forward, chat.id, normalized.text || null)
        .catch(() => { /* reputation is best-effort */ })
    }
  }

  /**
   * Something visibly happened to this message or its sender.
   *
   * `result.applied` alone was the test, and on a removal it reports only what
   * became of the SENDER. So a ban Telegram refused in a chat where the bot may
   * still delete produced `applied=false deleted=true`: the message vanished in
   * front of everybody, and this whole block was skipped — no notice, no ballot,
   * and none of the caches that make the override button work. A false positive
   * of exactly that shape was therefore invisible AND uncorrectable, in the
   * chats least able to correct it, since a missing ban right is usually a sign
   * the bot was added with the minimum.
   *
   * The correction channel is not a nicety here. Nearly every false positive
   * this system has learned from was caught by somebody pressing that button or
   * voting on that card.
   */
  const actedVisibly = result.applied || result.deleted === true

  /**
   * The verdict AS EXECUTED, which is not always the verdict as decided.
   *
   * Everything below either tells the chat what happened or stores it for a
   * later correction to undo, and both must describe the thing that actually
   * took place. When a ban fails and the delete succeeds, what happened is a
   * delete — so that is what the card announces and what the override cache
   * holds.
   *
   * Not cosmetic. `restitutionLiftsRestrictions` reads the stored action to
   * decide whether "not spam" should unrestrict and unban, and those two calls
   * lift whatever is in place regardless of who put it there — the comment on
   * them says so. Storing a `ban` we never managed to impose therefore armed
   * the override to undo somebody ELSE's: an admin who banned the spammer by
   * hand after our attempt failed would have had their ban lifted by the next
   * person pressing the button.
   */
  const executed: Verdict = result.applied
    ? verdict
    : { ...verdict, action: 'delete', banDurationSeconds: null }

  if (actedVisibly && enforced) {
    void sessionPort.reset(chat.id, sender.id).catch(() => { /* best-effort */ })
    rememberVerdict(chat.id, message.id, executed)
    rememberText(chat.id, message.id, normalized.text ?? '')
    rememberFacts(chat.id, message.id, factsFromSnapshot(user, {
      promoInBio: verdict.signals.some((s) => BIO_PROMO_SIGNALS.has(s.name)),
      personalChannel: input.enrichment.personalChannelId !== null
    }))
    // Kept in this branch: the cache exists so a later override can undo the
    // report above, and an override is only offered on a message something
    // actually happened to.
    if (normalized.forward) rememberForward(chat.id, message.id, normalized.forward)
    const locale = resolveLocale((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale)

    // Both arguments describe what happened, not what was decided. A run whose
    // bans keep failing still deserves ONE card rather than one per message, and
    // a delete that stuck is `card_only` — real enough to group the run under,
    // never enough to silence somebody the bot could not remove.
    const power = incidentPowerFor(executed, actedVisibly)
    const live = incidents.live(chat.id, sender.id)
    const askingChat = verdict.needsVote && policy.votingEnabled

    /**
     * One notice per run, not per message — with one exception, which is the
     * whole shape of this block: **a question is never suppressed, a statement
     * is.**
     *
     * A live incident means we told this chat about this sender within the last
     * ten minutes, so the second and eighth message of the run belong to that
     * notice rather than to notices of their own. But an unsure verdict is not a
     * notice, it is the chat's chance to correct us — the mechanism by which
     * nearly every false positive in this system has been caught. Silencing it
     * because a card is already up would quietly trade away the correction
     * channel to save a line. What IS suppressed is a SECOND ballot on a
     * question already open: that is how one settled text came to be voted on
     * seven times (2026-08-02), and every roll of it could enforce.
     *
     * Note what none of this skips. The message was judged in full — the standing
     * debit, the learning writes and its own decision record all happened above,
     * exactly as before. A run shares a notice, never a verdict.
     */
    if (live) {
      // No `appendIncidentMessage` here, deliberately: this message was judged in
      // full and has a decision record of its own a few lines above. That field
      // counts the messages with NO record — the ones the memo removed unread —
      // and inflating it with messages that are already rows would make every
      // count over the collection double what happened.
      // Everything this delivery cost, not one message: an album is several
      // deletions and the retro sweep may have taken more. The count exists so a
      // correction can say what the run destroyed, and deletions are the part no
      // correction can give back.
      const updated = incidents.addRemoved(chat.id, sender.id, 1 + retroPurged + albumRemoved) ?? live
      log.info('incident_joined', {
        chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext,
        trigger: live.triggerMessageId, removed: updated.removedCount,
        notice: askingChat ? 'vote' : 'card'
      })
      if (askingChat) {
        // The ballot's own text is left alone: it quotes the message that opened
        // the question and shows the tally, and the answer applies to the sender
        // either way (`enforceVoteSpam`).
        if (live.hasOpenVote) return
      } else if (await refreshIncidentCard(
        chat.id, sender.id, updated, sender.displayName, locale)) {
        return
      }
      // Falling through means one of two things: the chat has not been asked yet,
      // or the card expired (90 seconds) while the run continued (ten minutes).
      // An enforcement with no notice at all is invisible moderation, so a fresh
      // notice goes up and the incident adopts it.
    }

    // Grey-zone verdicts ask the community: the vote prompt (with the quoted
    // text) replaces the compact line. An admin's 👌 resolves it instantly,
    // which doubles as the override path for voted decisions.
    if (verdict.needsVote && policy.votingEnabled) {
      const opened = await store.openVote({
        chatId: chat.id, messageId: message.id, targetUserId: sender.id,
        targetLabel: sender.displayName, textPreview: normalized.text,
        media: mediaCategoryOf(normalized.attachments), openedBy: selfId
      }).catch(() => false)
      if (opened) {
        log.info('vote_opened', { chatId: chat.id, userId: sender.id, messageId: message.id, ...logContext, pSpam: Math.round(verdict.pSpam * 100) / 100, reason: verdict.reasonCode })
        // `rememberVerdict` ran above for this exact message, so the "why?"
        // anchor on the ballot resolves to the card that explains why the bot
        // was unsure — which is the question a voter is actually being asked.
        const view = votePrompt(locale, {
          chatId: chat.id, messageId: message.id,
          userId: sender.id, userLabel: sender.displayName, textPreview: normalized.text,
          media: mediaCategoryOf(normalized.attachments),
          // A name that is itself an advert must not be reprinted on a ballot
          // the whole chat reads, least of all as a link to its owner.
          promoName: nameIsPromo(verdict)
        }, { spam: 0, ham: 0, outcome: 'pending' }, { botUsername: selfUsername ?? undefined })
        const prompt = await tgSendText(chat.id, viewHtml(view.text), {
          replyMarkup: toKeyboard(view.buttons),
          disableWebPreview: true
        }).catch(() => null)
        if (prompt) await store.setVotePrompt(chat.id, message.id, prompt.id).catch(() => { /* ok */ })
        if (live) incidents.markVoteOpen(chat.id, sender.id)
        else if (power) {
          incidents.open(chat.id, sender.id, {
            power, action: executed.action, reasonCode: verdict.reasonCode,
            triggerMessageId: message.id, cardMessageId: null,
            hasOpenVote: true, removedCount: 1 + retroPurged + albumRemoved
          })
        }
        return
      }
    }

    const view = compactNotification(locale, executed, {
      chatId: chat.id, messageId: message.id, userId: sender.id, userLabel: sender.displayName
    }, { botUsername: selfUsername ?? undefined })
    const sent = await tgSendText(chat.id, viewHtml(view.text), {
      replyMarkup: toKeyboard(view.buttons),
      disableWebPreview: true
    }).catch(() => null)
    if (sent) scheduleDelete(chat.id, sent.id, NOTIFY_TTL_COMPACT_MS, `mod_event:${verdict.action}`)
    if (live) {
      // The run continues under its own count; only the notice is new.
      if (sent) incidents.attachCard(chat.id, sender.id, sent.id)
    } else if (power) {
      // `removedCount` starts at the trigger plus whatever the sweep took: the
      // number exists so a correction can say how much this verdict cost, and
      // the swept messages cost exactly as much as the one that triggered it.
      incidents.open(chat.id, sender.id, {
        power, action: executed.action, reasonCode: verdict.reasonCode,
        triggerMessageId: message.id, cardMessageId: sent?.id ?? null,
        removedCount: 1 + retroPurged + albumRemoved
      })
    }
  }
}

const wireCallbacks = (): void => {
  gateway.onCallbackQuery(async (query) => {
    const { kind, parts } = parseCallback(query.dataStr ?? '')
    const locale = await localeFor(query.user.id, query.user.language)

    if (kind === 'help') {
      await query.answer({})
      await tgSendText(query.user.id, viewHtml(helpView(locale).text))
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
      await tgSendText(query.user.id, viewHtml(view.text), { replyMarkup: toKeyboard(view.buttons) })
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
        await tgEditMessage({
          chatId: query.user.id, message: query.messageId,
          text: viewHtml(navView.text), replyMarkup: toKeyboard(navView.buttons)
        }).catch(() => { /* unchanged → MESSAGE_NOT_MODIFIED, fine */ })
        await query.answer({})
        return
      }

      const groupDoc = await store.getGroupDoc(chatId).catch(() => null)
      const policy = groupDocToChatPolicy(groupDoc as never)
      /**
       * Whether the tap moved anything. True by default because every toggle
       * does by definition; the pickers are the ones that can be tapped on the
       * value already in force, and re-picking the active preset was being
       * written to the log as a settings change.
       */
      let changed = true
      if (action === 'toggle_enabled') {
        await store.updateGroupSettings(chatId, { enabled: !policy.enabled })
      } else if (action === 'toggle_captcha') {
        await store.updateGroupSettings(chatId, { captchaEnabled: !policy.captchaEnabled })
      } else if (action === 'toggle_voting') {
        await store.updateGroupSettings(chatId, { votingEnabled: !policy.votingEnabled })
      } else if (action === 'preset' && (value === 'soft' || value === 'standard' || value === 'strict')) {
        changed = policy.preset !== value
        await store.updateGroupSettings(chatId, { confidenceThreshold: presetToThreshold(value) })
      } else if (action === 'toggle_bandb') {
        await store.updateGroupSettings(chatId, { banDatabase: !policy.externalBanEnabled })
      } else if (action === 'banan_default') {
        const sec = Number(value)
        if (!Number.isFinite(sec) || sec <= 0) { await query.answer({}); return }
        await store.updateGroupSettings(chatId, { bananDefault: sec })
      } else if (action === 'lang' && LOCALES[value]) {
        changed = ((groupDoc as { settings?: { locale?: string } } | null)?.settings?.locale) !== value
        await store.updateGroupSettings(chatId, { locale: value })
      } else {
        await query.answer({})
        return
      }
      // Logged only when something moved: re-picking the active preset used to
      // be written down as a change, which inflates any audit of who altered
      // what.
      if (changed) {
        log.info('settings_changed', { chatId, by: query.user.id, action, value: value || undefined })
      }
      // Every mutation re-renders the root panel — including a language pick,
      // which returns the admin from the sub-screen back to the main panel.
      const view = await renderSettingsPanel(locale, chatId)
      await tgEditMessage({
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
        await tgEditMessage({
          chatId: query.user.id, message: query.messageId,
          text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons)
        }).catch(() => { /* unchanged content / message gone */ })
      }
      const page = Number(arg) || 0

      if (kind === 'wel') {
        if (action === 'toggle') {
          const cur = await store.getWelcome(chatId).catch(() => ({ enable: false }))
          const ok = await store.setWelcomeEnabled(chatId, !cur.enable)
            .then(() => true).catch(() => false)
          if (!ok) { await query.answer({ text: locale.writeFailed, alert: true }); return }
        } else if (action === 'tdel') {
          // The returned boolean was thrown away, so a tap on a row that had
          // already been deleted from another screen still answered "🗑
          // Видалено" — and the admin believed stale content was gone.
          const gone = await store.removeWelcomeText(chatId, Number(arg)).catch(() => false)
          await edit(await renderWelcomeTexts(locale, chatId, 0))
          await query.answer({
            text: gone ? locale.welcome.editor.removed : locale.welcome.editor.removeMissing
          }); return
        } else if (action === 'gdel') {
          const gone = await store.removeWelcomeGif(chatId, Number(arg)).catch(() => false)
          await edit(await renderWelcomeGifs(locale, chatId, 0))
          await query.answer({
            text: gone ? locale.welcome.editor.removed : locale.welcome.editor.removeMissing
          }); return
        } else if (action === 'taddc') {
          pendingInput.set(query.user.id, { type: 'welcome.text', chatId })
          await tgSendText(query.user.id, viewHtml(locale.welcome.editor.promptText)).catch(() => { /* PM closed */ })
          await query.answer({}); return
        } else if (action === 'gaddc') {
          pendingInput.set(query.user.id, { type: 'welcome.gif', chatId })
          await tgSendText(query.user.id, viewHtml(locale.welcome.editor.promptGif)).catch(() => { /* PM closed */ })
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
        await tgSendText(query.user.id, viewHtml(locale.extra.editor.promptName)).catch(() => { /* PM closed */ })
        await query.answer({}); return
      }
      await edit(await renderExtrasEditor(locale, chatId, action === 'page' ? page : 0))
      await query.answer({})
      return
    }

    // Profile button on the "Why?" card: the card carries the facts captured at
    // decision time, which is what the verdict was based on — but an admin
    // reviewing it hours later wants to know what is true NOW (a ban database
    // may have caught up since), so this builds the profile live.
    if (kind === 'prof') {
      const [chatIdRaw = '', userIdRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const userId = Number(userIdRaw)
      if (!Number.isFinite(chatId) || !Number.isFinite(userId)) { await query.answer({}); return }
      if (!(await isChatAdmin(chatId, query.user.id))) {
        await query.answer({ text: locale.notification.adminOnly, alert: true })
        return
      }
      const [target] = await gateway.tg.getUsers([userId]).catch(() => [null])
      if (!target) {
        await query.answer({ text: locale.profile.notFound, alert: true })
        return
      }
      const facts = await buildLiveFacts(chatId, target).catch(() => null)
      if (!facts) {
        await query.answer({ text: locale.profile.notFound, alert: true })
        return
      }
      const policy = groupDocToChatPolicy(await store.getGroupDoc(chatId).catch(() => null) as never)
      const card = userProfileCard(locale, facts, {
        chatId,
        isTrusted: policy.trustedUserIds.includes(userId)
      })
      log.info('profile_opened', { chatId, userId, by: query.user.id, via: 'why_card' })
      await tgSendText(query.user.id, viewHtml(card.text), {
        ...(card.buttons.length > 0 ? { replyMarkup: toKeyboard(card.buttons) } : {})
      }).catch(() => { /* PM closed */ })
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
      // Edit where the card IS, not where the user is: this same card is now
      // opened from the PM "Why?" card, and editing by the group's chatId there
      // addressed a message id that does not exist in that chat — the button
      // stayed on its old label after a trust it had already applied.
      await tgEditMessage({ chatId: query.chat.id, message: query.messageId, replyMarkup: flipped })
        .catch(() => { /* card may be gone */ })
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
        // The message being edited sits in the group, so it speaks the group's
        // language — not the language of whichever admin tapped undo.
        await tgEditMessage({
          chatId, message: query.messageId,
          text: viewHtml((await groupLocale(chatId)).banan.lifted(userMention(userId, label)))
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
      /**
       * The payload names the chat, and a payload is forgeable — the captcha
       * path has said so since it was written. A user client can send any
       * `data` for any message it can see, so without this an established
       * account could answer a question in a chat it is not even in, given only
       * the two ids. The tap has to have come from the chat it claims.
       */
      if (query.chat.id !== chatId) { await query.answer({}); return }
      const existing = await store.getVote(chatId, messageId).catch(() => null)
      if (!existing || existing['status'] !== 'open') {
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }
      const standing = await voterStandingFor(
        chatId, query.user.id, Number(existing['targetUserId'] ?? 0))
      const refusal = ballotRefusal(locale, standing)
      if (refusal !== null) {
        log.info('vote_refused', {
          chatId, userId: query.user.id, messageId,
          reason: voteEligibility(standing)
        })
        await query.answer({ text: refusal, alert: true })
        return
      }
      const written = await store.castBallot({
        chatId, messageId, userId: query.user.id, isAdmin: standing.isAdmin, choice,
        label: query.user.displayName
      }).catch(() => false)
      if (!written) {
        // The window ran out, or the question closed, between the read above
        // and this write. Saying "counted" here would be a lie, and re-rendering
        // the prompt would put a live-looking question back on a dead one.
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }

      const vote = await store.getVote(chatId, messageId).catch(() => null)
      if (!vote) { await query.answer({}); return }
      // Re-read, because `castBallot` is filtered on the window as well as the
      // status and fails silently when either has moved. Without this the
      // handler would tally the ballots that were already there, find them
      // still short of the quorum, put the live prompt back up and answer
      // "counted" — for a ballot that was never written.
      if (vote['status'] !== 'open') {
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }
      const tally = tallyVotes((vote['ballots'] ?? []) as VoteBallot[])

      if (tally.outcome === 'pending') {
        const targetUserId = Number(vote['targetUserId'] ?? 0)
        // Re-derived from the remembered verdict rather than stored on the
        // ballot: without it the neutral label would hold until the first vote
        // and then the re-render would put the advertised name back.
        const openingVerdict = await recallVerdict(chatId, messageId)
        // The ballot is the group's message; the toast below is the voter's.
        const view = votePrompt(await groupLocale(chatId), {
          chatId, messageId,
          userId: targetUserId > 0 ? targetUserId : null,
          userLabel: String(vote['targetLabel'] ?? ''), textPreview: String(vote['textPreview'] ?? ''),
          media: (vote['media'] ?? null) as MediaCategory | null,
          promoName: openingVerdict ? nameIsPromo(openingVerdict) : false
        }, tally, { botUsername: selfUsername ?? undefined })
        await tgEditMessage({
          chatId, message: query.messageId,
          text: viewHtml(view.text), replyMarkup: toKeyboard(view.buttons),
          disableWebPreview: true
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
        outcome: tally.outcome, spam: tally.spam, ham: tally.ham,
        // `tally.decidedBy`, not a constant: this path serves both a quorum and
        // an admin's single decisive ballot, and the log used to call both
        // "community".
        by: tally.decidedBy ?? 'community'
      })
      let enforced: VoteEnforcement | undefined
      if (tally.outcome === 'spam') {
        enforced = await enforceVoteSpam({
          chatId, messageId,
          targetUserId: Number(vote['targetUserId'] ?? 0),
          learnText: String(vote['learnText'] ?? vote['textPreview'] ?? ''),
          tally: { spam: tally.spam, ham: tally.ham }
        }, 'community_vote')
      } else {
        // Ham: the same restitution an admin's override performs, because it is
        // the same finding. Admin ham ballot additionally carries override
        // authority → the user also becomes trusted in this chat.
        const targetUserId = Number(vote['targetUserId'] ?? 0)
        await restoreFalsePositive({
          chatId, messageId, userId: targetUserId,
          byUserId: query.user.id, source: 'community_vote'
        })
        const ballots = (vote['ballots'] ?? []) as VoteBallot[]
        if (ballots.some((b) => b.isAdmin && b.choice === 'ham')) {
          await store.addTrustedUser(chatId, targetUserId).catch(() => { /* best-effort */ })
        }
      }
      const subjectId = Number(vote['targetUserId'] ?? 0)
      const subjectLabel = String(vote['targetLabel'] ?? '')
      const closingVerdict = await recallVerdict(chatId, messageId)
      const receipt = voteResult(await groupLocale(chatId), {
        chatId, messageId,
        userId: subjectId > 0 ? subjectId : null,
        userLabel: subjectLabel.length > 0 ? subjectLabel : null,
        promoName: closingVerdict ? nameIsPromo(closingVerdict) : false
      }, tally.outcome, { botUsername: selfUsername ?? undefined, enforced })
      await tgEditMessage({
        chatId, message: query.messageId,
        text: viewHtml(receipt.text), replyMarkup: toKeyboard(receipt.buttons),
        disableWebPreview: true
      }).catch(() => { /* ok */ })
      // The resolved prompt lingers briefly as a receipt, then cleans up.
      scheduleDelete(chatId, query.messageId, NOTIFY_TTL_VOTE_RESULT_MS, 'vote_result')
      await query.answer({ text: locale.vote.counted })
      return
    }

    if (kind === 'vrs') {
      const [chatIdRaw = '', messageIdRaw = ''] = parts
      const chatId = Number(chatIdRaw)
      const messageId = Number(messageIdRaw)
      // Same forgeable-payload rule as the ballot path: a roster names people,
      // and it is only for the chat that watched them vote.
      if (query.chat.id !== chatId) { await query.answer({}); return }
      const vote = Number.isFinite(chatId) && Number.isFinite(messageId)
        ? await store.getVote(chatId, messageId).catch(() => null)
        : null
      if (!vote) {
        // The document outlives the receipt by days, so this is a genuinely
        // old question rather than the usual race.
        await query.answer({ text: locale.vote.alreadyEnded })
        return
      }
      /**
       * The one person who does not get the roster is the person it is about.
       * Everyone else in the chat may check whether a result was honest; the
       * subject of the question is the only reader with a motive to go after
       * the people who answered it, and giving them the list would turn a
       * transparency feature into a target list.
       */
      if (vote['status'] === 'open') {
        // Mid-vote the roster would be a live scoreboard of who has taken which
        // side, which is the one thing that makes people vote with the room
        // instead of about the message.
        await query.answer({})
        return
      }
      if (query.user.id === Number(vote['targetUserId'] ?? 0)) {
        await query.answer({ text: locale.vote.voters.notForTarget, alert: true })
        return
      }
      const roster = voterRoster((vote['ballots'] ?? []) as VoteBallot[])
      // Whispered where the API allows it, and otherwise as a callback alert:
      // both are private to the tapper, the whisper just fits more names.
      const whispered = config.ephemeralCaptcha
        ? await gateway.sendEphemeralPrompt(
            chatId, query.user.id, voterListView(locale, roster), []).catch(() => null)
        : null
      await query.answer(whispered !== null
        ? {}
        : { text: truncate(voterListView(locale, roster, 'text'), 200), alert: true })
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
        text: verdict ? truncate(whyView(locale, verdict), 200) : '…',
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
      const restitution = await restoreFalsePositive({
        chatId,
        messageId: Number(messageIdRaw),
        userId: Number(userIdRaw),
        byUserId: query.user.id,
        source: 'admin',
        learnText: recallText(chatId, Number(messageIdRaw))
      })
      // The admin vouched — auto-trust this user in this chat from now on.
      // No longer "best-effort" in the sense of unreported: the toast promises
      // trust in so many words, and a Mongo outage used to make that a lie.
      const trusted = await store.addTrustedUser(chatId, Number(userIdRaw))
        .then(() => true).catch(() => false)
      log.info('override', {
        chatId, userId: Number(userIdRaw), messageId: Number(messageIdRaw), by: query.user.id,
        wasDecidedBy: verdict?.decidedBy, wasReason: verdict?.reasonCode,
        lifted: restitution.lifted, trusted
      })
      const complete = restitution.lifted && trusted
      // An alert, not a toast, when it is partial: a moderator who is told
      // "розблокований і в довірених" walks away, and this is the one moment
      // they could still fix it by hand.
      await query.answer(complete
        ? { text: locale.notification.overrideDone }
        : { text: locale.notification.overridePartial, alert: true })
      // `query.chat.id`, not `chatId`. This button rides two different messages:
      // the compact notice in the group, where the two ids agree, and the "why"
      // card in the admin's PM, where they do not. Message ids are scoped per
      // chat, so deleting a PM message id FROM THE GROUP deleted whatever group
      // message happened to hold that number — an unrelated member's, most
      // likely — while the card that was tapped stayed up with a live button.
      //
      // The group notice tapped from PM is left standing: we do not keep its id.
      //
      // And nothing is removed at all when the correction was partial — the
      // button is the only retry there is, and taking it away would leave a
      // moderator who has just been told "not everything applied" with no way
      // to apply the rest.
      if (complete) {
        await gateway.tg.deleteMessagesById(query.chat.id, [query.messageId])
          .catch(() => { /* ok */ })
      }
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

  // Adopt what Telegram refused us before the restart. Before this the record
  // died with the process, so every chat where the bot is not an admin paid a
  // full evaluation again to rediscover it — three times over on 2026-08-07.
  // Awaited, not fired off: a message arriving in the first second must see the
  // same state as one arriving in the tenth.
  const restored = await store.loadRightsBlocks().catch(() => [])
  rights.restore(restored)
  if (restored.length > 0) log.info('rights_restored_at_boot', { chats: restored.length })

  gateway.onMessage(handleMessage)
  gateway.onError((err) => log.error('handler_error', { err: err instanceof Error ? err : String(err) }))
  // Debug, not warn: a redelivery is the transport working as specified, and
  // the pipeline now absorbs it. It becomes interesting only in bulk, which
  // `total` makes visible without a line per occurrence being worth reading.
  gateway.onDuplicate((info) => log.debug('duplicate_delivery', { ...info }))
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
  const sweepTimer = setInterval(() => {
    void processDueDeletions()
    void expireStaleVotes()
  }, 60 * 1000)
  sweepTimer.unref?.()

  /**
   * Housekeeping the database cannot do for itself.
   *
   * `pipeline_decisions` and the window collections expire by TTL index, but the
   * two v1 collections hold standing rather than observations, so no blanket
   * expiry is correct for them — and consequently nothing had ever removed a
   * row. They reached 483k and 126k documents against a 512 MB cluster, which
   * had already stopped accepting writes once (2026-07-06). A quota is not a
   * warning that arrives in time to act on: the failure mode is the bot
   * silently losing every record of what it decided.
   *
   * Daily, and one bounded batch per day. There is no hurry — the growth this
   * offsets is a few thousand rows a day — and a slow sweep is the one shape
   * that can never itself be the outage.
   */
  /**
   * How full the cluster is, said out loud.
   *
   * A quota is not a warning that arrives in time to act on: the free tier stops
   * accepting writes, and what stops with them is the bot's record of everything
   * it decides. It has happened once (2026-07-06) and the first sign of it was
   * missing data, not a log line. Atlas counts the 512 MB as data plus indexes,
   * so both are reported and the pair is what to read — deleting documents moves
   * the first at once and the second only when an index is rebuilt.
   */
  const reportStorage = async (): Promise<void> => {
    const { dataSize, indexSize } = await store.storageStats()
    const usedMb = Math.round((dataSize + indexSize) / 1048576)
    const fields = { usedMb, dataMb: Math.round(dataSize / 1048576), indexMb: Math.round(indexSize / 1048576) }
    if (usedMb >= FREE_TIER_WARN_MB) log.warn('storage_pressure', fields)
    else log.info('storage', fields)
  }

  const prune = async (): Promise<void> => {
    const { members, users } = await store.pruneDormantRecords()
    if (members + users > 0) log.info('prune_dormant', { members, users })
    await reportStorage()
  }
  await prune().catch((err) => log.warn('prune_dormant_failed', { err }))
  const pruneTimer = setInterval(() => {
    void prune().catch((err) => log.warn('prune_dormant_failed', { err }))
  }, 24 * 60 * 60 * 1000)
  pruneTimer.unref?.()

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
