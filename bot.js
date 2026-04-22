const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')

const { bot: botLog, db: dbLog } = require('./helpers/logger')
const { db } = require('./database')
const { processExpiredVotes } = require('./handlers')
const { processStartupCleanup, startCleanupInterval } = require('./helpers/message-cleanup')
const { startPeriodicSync: startBanDatabaseSync } = require('./helpers/ban-database-sync')
const {
  stats,
  errorHandler,
  contextLoader,
  globalBanCheck,
  banDatabase,
  spamCheck,
  dataPersistence,
  emojiInject,
  albumBuffer
} = require('./middlewares')
const { registerAllRoutes } = require('./routes')

// Track bot start time
global.startDate = new Date()

/**
 * Create and configure the bot instance
 */
const createBot = () => {
  const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: { webhookReply: false }
  })

  // Attach database to context
  bot.context.db = db

  return bot
}

/**
 * Configure i18n (internationalization)
 */
const createI18n = () => {
  return new I18n({
    directory: path.resolve(__dirname, 'locales'),
    defaultLanguage: 'en',
    defaultLanguageOnMissing: true
  })
}

/**
 * Configure session middleware
 */
const configureSession = (bot) => {
  // User session
  bot.use(session({ ttl: 60 * 5 }))

  // Group session
  bot.use(session({
    property: 'group',
    getSessionKey: (ctx) => {
      if (ctx.from && ctx.chat && ['supergroup', 'group'].includes(ctx.chat.type)) {
        return `${ctx.chat.id}`
      }
      return null
    },
    ttl: 60 * 5
  }))
}

/**
 * Skip channel posts (not processed by bot)
 */
const skipChannelPosts = () => {
  // Intentionally empty - channel posts are ignored
}

/**
 * Handle my_chat_member updates (bot added/removed from groups)
 */
const handleBotAddedToGroup = require('./handlers/bot-added')
const handleMyChatMemberUpdates = (ctx, next) => {
  if (ctx.update.my_chat_member) {
    botLog.debug({ update: ctx.update }, 'my_chat_member update')
    return handleBotAddedToGroup(ctx)
  } else {
    return next()
  }
}

/**
 * Spam check orchestrator middleware
 * Coordinates global ban database and AI spam checks
 */
const spamCheckOrchestrator = async (ctx, next) => {
  // Check both new messages and edited messages
  // Spammers send clean messages first, then edit them to spam
  if ((!ctx.message && !ctx.editedMessage) || !ctx.from) {
    return next(ctx)
  }

  // Normalize ctx.message for edited messages so all downstream code
  // (ban database, spam check, quickRiskAssessment, etc.) works uniformly.
  // Must set ctx.update.message (not ctx.message) because Telegraf v3
  // defines ctx.message as a read-only getter for ctx.update.message
  if (ctx.editedMessage && !ctx.message) {
    ctx.update.message = ctx.update.edited_message
  }

  // Skip if already flagged as spam (e.g., by global ban)
  if (ctx.state && ctx.state.isSpam) {
    return next(ctx)
  }

  // Global ban database check
  const globallyListed = await banDatabase(ctx)
  if (globallyListed) {
    if (!ctx.state) ctx.state = {}
    ctx.state.isSpam = true
    return next(ctx)
  }

  // AI spam check
  const aiSpam = await spamCheck(ctx)
  if (aiSpam) {
    if (!ctx.state) ctx.state = {}
    ctx.state.isSpam = true
  }

  return next(ctx)
}

/**
 * Register all middlewares in order
 */
const registerMiddlewares = (bot, i18n) => {
  // 1. Skip channel posts
  bot.on(['channel_post', 'edited_channel_post'], skipChannelPosts)

  // 2. Handle bot added/removed from groups
  bot.use(handleMyChatMemberUpdates)

  // 3. Global error handler
  bot.use(errorHandler)

  // 4. Statistics
  bot.use(stats)

  // 5. Rate limiting (5 requests per second per user).
  //    Skip album (media_group_id) siblings: a 10-photo album arrives as
  //    10 separate updates within ~100ms. Counting each one would drop
  //    half the album before album-buffer aggregates them, leaving
  //    undeleted photos if the album is spam. Returning a falsy key
  //    from keyGenerator bypasses the store check in telegraf-ratelimit.
  bot.use(rateLimit({
    window: 1000,
    limit: 5,
    keyGenerator: (ctx) => {
      const msg = ctx.message || ctx.editedMessage || ctx.channelPost || ctx.editedChannelPost
      if (msg && msg.media_group_id) return null
      return ctx.from && ctx.from.id
    }
  }))

  // 6. Sessions (user + group)
  configureSession(bot)

  // 7. Internationalization
  bot.use(i18n.middleware())

  // 7.5. Inject custom emoji map into i18n
  bot.use(emojiInject)

  // 8. Load context (user, group, member data)
  bot.use(contextLoader)

  // 8.5. Aggregate album (media_group_id) siblings into one ctx so that
  //      spam-check runs once per album and can delete ALL photos on
  //      spam verdict (otherwise the caption message is removed but the
  //      4 companion photos stay visible).
  bot.use(albumBuffer)

  // 9. Global ban check
  bot.use(globalBanCheck)

  // 10. Spam checks (global ban database + AI)
  bot.use(spamCheckOrchestrator)

  // 11. Data persistence (runs after handlers)
  bot.use(dataPersistence)
}

// Explicitly list update types we need — ensures edited_message is always included
// even if a previous setWebhook/getUpdates call restricted the list.
//
//   chat_member            — join/leave events (used for first-message-latency
//                            detection: joinedAt vs firstMessageAt delta).
//                            REQUIRES explicit subscription: default excludes.
//   message_reaction       — emoji reactions on other users' messages. Feeds
//                            the crowd-sourced spam-signal layer (3+ negative
//                            reactions from trusted users → auto-escalate).
//                            REQUIRES explicit subscription AND bot must be an
//                            ADMIN of the chat — Telegram does NOT deliver this
//                            update to regular bot members. No admin → the
//                            reaction-feedback layer silently degrades to no-op.
//   message_reaction_count — aggregated anonymous reaction counts for large
//                            chats (>50 members). Same admin rule applies.
//
// Per Bot API: "Specify an empty list to receive all update types EXCEPT
// chat_member, message_reaction, and message_reaction_count (default)."
// i.e. these three MUST be listed explicitly — they never arrive by default.
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'message_reaction',
  'message_reaction_count',
  'channel_post',
  'edited_channel_post'
]

/**
 * Launch bot in webhook or polling mode
 */
const launchBot = (bot) => {
  if (process.env.BOT_DOMAIN) {
    const hookPath = `/LyAdminBot:${process.env.BOT_TOKEN}`
    const port = process.env.WEBHOOK_PORT || 2200
    return bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath,
        port
      }
    }).then(() => {
      // Re-set webhook with explicit allowed_updates (launch() doesn't pass it)
      const domain = process.env.BOT_DOMAIN.replace(/^https?:\/\//, '')
      return bot.telegram.setWebhook(`https://${domain}${hookPath}`, {
        allowed_updates: ALLOWED_UPDATES
      })
    }).then(() => {
      botLog.info({
        mode: 'webhook',
        port,
        allowedUpdates: ALLOWED_UPDATES
      }, 'Bot started')
    })
  }

  return bot.launch({
    polling: { allowedUpdates: ALLOWED_UPDATES }
  }).then(() => {
    botLog.info({ mode: 'polling', allowedUpdates: ALLOWED_UPDATES }, 'Bot started')
  })
}

/**
 * Main initialization
 */
const init = () => {
  const bot = createBot()
  const i18n = createI18n()

  registerMiddlewares(bot, i18n)
  registerAllRoutes(bot)

  // Wait for database connection before launching
  db.connection.once('open', async () => {
    dbLog.info('Connected to MongoDB')
    await launchBot(bot)

    // Process any pending message deletions from before restart
    await processStartupCleanup(db, bot.telegram)

    // Start periodic message cleanup (every 30 seconds)
    startCleanupInterval(db, bot.telegram, 30 * 1000)
    botLog.debug('Started message cleanup service')

    // Start spam vote expiration handler (check every minute)
    setInterval(() => {
      processExpiredVotes(db, bot.telegram, i18n)
    }, 60 * 1000)
    botLog.debug('Started spam vote expiration handler')

    // Start global ban database signature sync if enabled
    startBanDatabaseSync(db)
  })
}

// Start the bot
init()
