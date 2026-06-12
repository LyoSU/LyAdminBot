/**
 * Environment configuration. Fail fast and loud: a misconfigured antispam
 * bot silently doing nothing is worse than one that refuses to start.
 */

export interface BotConfig {
  apiId: number
  apiHash: string
  botToken: string
  mongoUri: string
  session: string
  qdrantUrl: string | null
  qdrantApiKey: string | null
  openaiApiKey: string | null
  openrouterApiKey: string | null
  llmCheapModel: string
  llmStrongModel: string
}

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const loadConfig = (): BotConfig => ({
  apiId: Number(required('API_ID')),
  apiHash: required('API_HASH'),
  botToken: required('BOT_TOKEN'),
  mongoUri: required('MONGODB_URI'),
  session: process.env['SESSION_PATH'] ?? '.mtcute-session/bot',
  qdrantUrl: process.env['QDRANT_URL'] ?? null,
  qdrantApiKey: process.env['QDRANT_API_KEY'] ?? null,
  openaiApiKey: process.env['OPENAI_API_KEY'] ?? null,
  openrouterApiKey: process.env['OPENROUTER_API_KEY'] ?? null,
  llmCheapModel: process.env['LLM_CHEAP_MODEL'] ?? 'openai/gpt-5-mini',
  llmStrongModel: process.env['LLM_STRONG_MODEL'] ?? 'anthropic/claude-sonnet-4.6'
})
