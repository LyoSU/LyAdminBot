const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')

const { bot: botLog, db: dbLog } = require('./helpers/logger')
const { db } = require('./database')
const { processExpiredVotes } = require('./handlers')
const {
  stats,
  errorHandler,
  contextLoader,
  globalBanCheck,
  casBan,
  spamCheck,
  dataPersistence
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
 * Coordinates CAS ban and AI spam check
 */
const spamCheckOrchestrator = async (ctx, next) => {
  // Only check messages
  if (!ctx.message || !ctx.from) {
    return next(ctx)
  }

  // Skip if already flagged as spam (e.g., by global ban)
  if (ctx.state && ctx.state.isSpam) {
    return next(ctx)
  }

  // CAS ban check
  const casBanned = await casBan(ctx)
  if (casBanned) {
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

  // 5. Rate limiting (5 requests per second)
  bot.use(rateLimit({ window: 1000, limit: 5 }))

  // 6. Sessions (user + group)
  configureSession(bot)

  // 7. Internationalization
  bot.use(i18n.middleware())

  // 8. Load context (user, group, member data)
  bot.use(contextLoader)

  // 9. Global ban check
  bot.use(globalBanCheck)

  // 10. Spam checks (CAS + AI)
  bot.use(spamCheckOrchestrator)

  // 11. Data persistence (runs after handlers)
  bot.use(dataPersistence)
}

/**
 * Launch bot in webhook or polling mode
 */
const launchBot = (bot) => {
  if (process.env.BOT_DOMAIN) {
    return bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath: `/LyAdminBot:${process.env.BOT_TOKEN}`,
        port: process.env.WEBHOOK_PORT || 2200
      }
    }).then(() => {
      botLog.info({
        mode: 'webhook',
        port: process.env.WEBHOOK_PORT || 2200
      }, 'Bot started')
    })
  }

  return bot.launch().then(() => {
    botLog.info({ mode: 'polling' }, 'Bot started')
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

    // Start spam vote expiration handler (check every minute)
    setInterval(() => {
      processExpiredVotes(db, bot.telegram)
    }, 60 * 1000)
    botLog.debug('Started spam vote expiration handler')
  })
}

// Start the bot
init()
