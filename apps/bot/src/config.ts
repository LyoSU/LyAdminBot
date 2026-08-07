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
  llmRequireSchema: boolean
  /** null = do not send the parameter at all. See `OpenRouterConfig.temperature`. */
  llmTemperature: number | null
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

/**
 * Optional numeric env. Garbage reads as absent rather than as `NaN`: a typo in
 * a tuning knob must not travel into a request body and become a 400 on every
 * call. Absent is always a working configuration.
 */
const numberOrNull = (name: string): number | null => {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
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
  // OpenRouter slugs are `vendor/model` — a bare name is not a model there, it
  // is a 404 with the same status as a rejected parameter.
  llmModel: process.env['LLM_MODEL'] ?? process.env['LLM_CHEAP_MODEL'] ??
    process.env['LLM_STRONG_MODEL'] ?? 'openai/gpt-5.6-luna',
  // Route only to endpoints that actually enforce the verdict schema. Default
  // ON because an unenforced schema is the silent-degradation shape this whole
  // area was just fixed for; `LLM_REQUIRE_SCHEMA=false` is the escape hatch if
  // the chosen model has no such endpoint, since the alternative is no
  // classifier at all.
  llmRequireSchema: enabled('LLM_REQUIRE_SCHEMA', true),
  // Unset unless asked for, because `require_parameters` turns every parameter
  // sent into an endpoint requirement and the default model is a reasoning model
  // that does not take this one — see `OpenRouterConfig.temperature`. Set it only
  // for a sampling model that lists `temperature` in OpenRouter's GET /models.
  llmTemperature: numberOrNull('LLM_TEMPERATURE'),
  ephemeralCaptcha: enabled('EPHEMERAL_CAPTCHA', true)
})
