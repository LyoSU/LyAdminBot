const got = require('got')
const { nlp: log } = require('./logger')

/**
 * NLP Service Client
 *
 * HTTP client for communicating with the Python NLP service.
 * Provides POS tagging, n-gram extraction, and feature detection.
 */

// Configuration with validation
const CONFIG = {
  baseUrl: process.env.NLP_SERVICE_URL || 'http://localhost:8000',
  timeout: Math.max(1000, parseInt(process.env.NLP_SERVICE_TIMEOUT, 10) || 5000),
  enabled: process.env.NLP_SERVICE_ENABLED !== 'false'
}

// HTTP client (got v9 compatible)
const nlpApi = got.extend({
  timeout: CONFIG.timeout,
  retries: 1,
  throwHttpErrors: false
})

/**
 * Check if NLP service is healthy
 * @returns {Promise<{ok: boolean, models: string[], reason?: string}>}
 */
async function checkHealth () {
  if (!CONFIG.enabled) {
    return { ok: false, models: [], reason: 'disabled' }
  }

  try {
    const response = await nlpApi.get(`${CONFIG.baseUrl}/health`, {
      json: true
    })

    if (response.statusCode === 200 && response.body && response.body.status === 'ok') {
      return {
        ok: true,
        models: response.body.models_loaded || []
      }
    }

    return { ok: false, models: [], reason: `status ${response.statusCode}` }
  } catch (error) {
    log.debug({ err: error.message }, 'NLP service health check failed')
    return { ok: false, models: [], reason: error.message }
  }
}

/**
 * Validate response structure
 * @param {Object} body
 * @returns {boolean}
 */
function isValidResponse (body) {
  return body &&
    Array.isArray(body.tokens) &&
    Array.isArray(body.pos) &&
    typeof body.lang === 'string'
}

/**
 * Extract NLP features from text
 * @param {string} text - Text to analyze
 * @param {string} lang - Language code ('auto', 'uk', 'ru', 'en')
 * @returns {Promise<Object|null>}
 */
async function extract (text, lang = 'auto') {
  if (!CONFIG.enabled) {
    return null
  }

  if (!text || text.length < 3) {
    return null
  }

  try {
    const response = await nlpApi.post(`${CONFIG.baseUrl}/extract`, {
      json: true,
      body: { text, lang }
    })

    if (response.statusCode === 200 && isValidResponse(response.body)) {
      return response.body
    }

    // Log based on error type
    if (response.statusCode >= 500) {
      log.error({ status: response.statusCode }, 'NLP service error')
    } else if (response.statusCode >= 400) {
      log.debug({ status: response.statusCode }, 'NLP request rejected')
    }

    return null
  } catch (error) {
    log.debug({ err: error.message }, 'NLP extract error')
    return null
  }
}

/**
 * Extract NLP features from multiple texts
 * @param {string[]} texts - Array of texts to analyze
 * @param {string} lang - Language code
 * @returns {Promise<Object[]>}
 */
async function extractBatch (texts, lang = 'auto') {
  if (!CONFIG.enabled) {
    return []
  }

  if (!texts || texts.length === 0) {
    return []
  }

  // Filter valid texts and limit
  const validTexts = texts.filter(t => t && t.length >= 3).slice(0, 100)

  if (validTexts.length === 0) {
    return []
  }

  try {
    const response = await nlpApi.post(`${CONFIG.baseUrl}/batch`, {
      json: true,
      body: { texts: validTexts, lang },
      timeout: CONFIG.timeout * 2 // Double timeout for batch
    })

    if (response.statusCode === 200 && response.body && Array.isArray(response.body.results)) {
      return response.body.results
    }

    if (response.statusCode >= 500) {
      log.error({ status: response.statusCode }, 'NLP batch service error')
    } else {
      log.debug({ status: response.statusCode }, 'NLP batch request failed')
    }

    return []
  } catch (error) {
    log.debug({ err: error.message }, 'NLP batch extract error')
    return []
  }
}

/**
 * Get POS n-grams for pattern matching
 * @param {string} text - Text to analyze
 * @returns {Promise<{bigrams: string[], trigrams: string[]}|null>}
 */
async function getNgrams (text) {
  const result = await extract(text)
  if (!result) return null

  return {
    bigrams: result.bigrams || [],
    trigrams: result.trigrams || []
  }
}

/**
 * Get spam-relevant features
 * @param {string} text - Text to analyze
 * @returns {Promise<Object|null>}
 */
async function getSpamFeatures (text) {
  const result = await extract(text)
  if (!result) return null

  return {
    lang: result.lang,
    features: result.features,
    posSignature: result.pos.slice(0, 10).join('-'),
    bigramSignature: result.bigrams.slice(0, 5).join('|')
  }
}

module.exports = {
  checkHealth,
  extract,
  extractBatch,
  getNgrams,
  getSpamFeatures,
  CONFIG
}
