const pino = require('pino')

// Determine if we're in development mode
const isDev = process.env.NODE_ENV !== 'production'

// Configure transport based on environment
const getTransport = () => {
  if (!isDev) return undefined
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      messageFormat: '{module} {msg}',
      customColors: 'info:cyan,warn:yellow,error:red,debug:gray'
    }
  }
}

// Create base logger with pino-pretty for development
const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: getTransport(),
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    app: 'LyAdminBot'
  }
})

// Create child loggers for different modules
const createChildLogger = (module) => {
  return logger.child({ module: `[${module}]` })
}

// Pre-created module loggers for common use cases
const bot = createChildLogger('BOT')
const spam = createChildLogger('SPAM CHECK')
const spamAction = createChildLogger('SPAM ACTION')
const moderation = createChildLogger('MODERATION')
const qdrant = createChildLogger('QDRANT')
const velocity = createChildLogger('VELOCITY')
const cleanup = createChildLogger('CLEANUP')
const report = createChildLogger('REPORT')
const globalBan = createChildLogger('GLOBAL BAN')
const cas = createChildLogger('CAS BAN')
const casSync = createChildLogger('CAS SYNC')
const db = createChildLogger('DATABASE')
const stats = createChildLogger('STATS')
const reputation = createChildLogger('REPUTATION')
const notification = createChildLogger('NOTIFICATION')
const spamVote = createChildLogger('SPAM VOTE')

module.exports = {
  // Base logger for custom usage
  logger,
  createChildLogger,

  // Pre-created module loggers
  bot,
  spam,
  spamAction,
  moderation,
  qdrant,
  velocity,
  cleanup,
  report,
  globalBan,
  cas,
  casSync,
  db,
  stats,
  reputation,
  notification,
  spamVote
}
