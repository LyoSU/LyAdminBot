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
  llmModel: string
  /**
   * Deliver the captcha as an ephemeral group message — visible to the suspect
   * alone (Bot API 10.2). On by default; a kill switch rather than a feature
   * flag, because the visible prompt remains the fallback either way and the
   * ephemeral path talks to an API surface we cannot verify from the code.
   */
  ephemeralCaptcha: boolean
}

/** Env booleans: only an explicit "false"/"0" turns a defaulted-on flag off. */
const enabled = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  return !['false', '0', 'no', 'off'].includes(raw)
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
  // One classifier. `LLM_CHEAP_MODEL` / `LLM_STRONG_MODEL` are still read so a
  // deployment carrying either does not silently fall back to the default —
  // whichever is set wins, cheap first, and the pair no longer means anything.
  llmModel: process.env['LLM_MODEL'] ?? process.env['LLM_CHEAP_MODEL'] ??
    process.env['LLM_STRONG_MODEL'] ?? 'gpt-5.6-luna',
  ephemeralCaptcha: enabled('EPHEMERAL_CAPTCHA', true)
})
