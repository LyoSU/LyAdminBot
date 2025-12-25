const crypto = require('crypto')

/**
 * Velocity-based spam detection system
 * Tracks message patterns across chats to detect spam campaigns
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Time windows
  WINDOWS: {
    MICRO: 60 * 1000, // 1 minute - burst detection
    SHORT: 10 * 60 * 1000, // 10 minutes
    MEDIUM: 60 * 60 * 1000, // 1 hour
    LONG: 24 * 60 * 60 * 1000 // 24 hours
  },

  // Thresholds
  THRESHOLDS: {
    EXACT_MATCH_CHATS: 3, // Same message in 3+ chats = spam
    FUZZY_MATCH_CHATS: 4, // Similar message in 4+ chats
    LINK_CHATS: 3, // Same link in 3+ chats
    BURST_PER_MINUTE: 5, // 5+ messages per minute
    STRUCTURE_MATCH_CHATS: 5 // Same structure in 5+ chats
  },

  // Decay half-life (older data = less weight)
  DECAY_HALF_LIFE: 60 * 60 * 1000, // 1 hour

  // Cleanup
  MAX_ENTRIES_PER_KEY: 1000,
  CLEANUP_INTERVAL: 60 * 60 * 1000, // 1 hour
  MAX_AGE: 7 * 24 * 60 * 60 * 1000 // 7 days
}

// ============================================================================
// IN-MEMORY STORE (with LRU-like cleanup)
// ============================================================================

class VelocityStore {
  constructor () {
    this.data = new Map()
    this.startCleanup()
  }

  // Get entries for a key (sorted set simulation)
  async zrangebyscore (key, minScore, maxScore) {
    const entries = this.data.get(key) || []
    return entries
      .filter(e => e.score >= minScore && e.score <= maxScore)
      .sort((a, b) => a.score - b.score)
  }

  // Add entry with score (timestamp)
  async zadd (key, score, member) {
    if (!this.data.has(key)) {
      this.data.set(key, [])
    }
    const entries = this.data.get(key)

    // Check if member exists
    const existing = entries.findIndex(e => e.member === member)
    if (existing >= 0) {
      entries[existing].score = score
    } else {
      entries.push({ score, member })
    }

    // Limit size
    if (entries.length > CONFIG.MAX_ENTRIES_PER_KEY) {
      entries.sort((a, b) => b.score - a.score)
      entries.length = CONFIG.MAX_ENTRIES_PER_KEY
    }
  }

  // Count entries in range
  async zcount (key, minScore, maxScore) {
    const entries = await this.zrangebyscore(key, minScore, maxScore)
    return entries.length
  }

  // Increment hash field
  async hincrby (key, field, increment) {
    if (!this.data.has(key)) {
      this.data.set(key, {})
    }
    const hash = this.data.get(key)
    hash[field] = (hash[field] || 0) + increment
    return hash[field]
  }

  // Get hash field
  async hget (key, field) {
    const hash = this.data.get(key)
    return hash ? hash[field] : null
  }

  // Get all hash fields
  async hgetall (key) {
    return this.data.get(key) || {}
  }

  // Set hash field
  async hset (key, field, value) {
    if (!this.data.has(key)) {
      this.data.set(key, {})
    }
    const hash = this.data.get(key)
    hash[field] = value
  }

  // Set add
  async sadd (key, ...members) {
    if (!this.data.has(key)) {
      this.data.set(key, new Set())
    }
    const set = this.data.get(key)
    members.forEach(m => set.add(m))
  }

  // Set members
  async smembers (key) {
    const set = this.data.get(key)
    return set ? Array.from(set) : []
  }

  // Cleanup old entries
  startCleanup () {
    setInterval(() => {
      const cutoff = Date.now() - CONFIG.MAX_AGE
      let cleanedKeys = 0

      for (const [key, value] of this.data.entries()) {
        // Clean sorted sets (arrays)
        if (Array.isArray(value)) {
          const filtered = value.filter(e => e.score > cutoff)
          if (filtered.length === 0) {
            this.data.delete(key)
            cleanedKeys++
          } else {
            this.data.set(key, filtered)
          }
        } else if (key.includes(':stats') && typeof value === 'object') {
          // Clean user stats older than MAX_AGE (hashes with timestamp)
          const lastActivity = value.lastActivity || 0
          if (lastActivity && Date.now() - lastActivity > CONFIG.MAX_AGE) {
            this.data.delete(key)
            cleanedKeys++
          }
        } else if (value instanceof Set && value.size > 100) {
          // Clean old sets (user links, chats) - keep max 100 items
          const arr = Array.from(value).slice(-100)
          this.data.set(key, new Set(arr))
        }
      }

      if (cleanedKeys > 0 || this.data.size > 0) {
        console.log(`[VELOCITY] Cleanup: ${this.data.size} keys, removed ${cleanedKeys}`)
      }
    }, CONFIG.CLEANUP_INTERVAL)
  }
}

const store = new VelocityStore()

// ============================================================================
// HASH FUNCTIONS
// ============================================================================

/**
 * Exact hash for identical messages
 */
const getExactHash = (text) => {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  return crypto.createHash('sha256')
    .update(normalized)
    .digest('hex')
    .substring(0, 16)
}

/**
 * SimHash for similar messages (fuzzy matching)
 * Messages with small text changes will have similar hashes
 */
const getSimHash = (text, hashBits = 64) => {
  const tokens = tokenize(text)
  if (tokens.length === 0) return '0'.repeat(16)

  const vector = new Array(hashBits).fill(0)

  for (const token of tokens) {
    const hash = fnv1a(token)
    for (let i = 0; i < hashBits; i++) {
      if ((hash >> i) & 1) {
        vector[i]++
      } else {
        vector[i]--
      }
    }
  }

  // Convert to hex
  let result = ''
  for (let i = 0; i < hashBits; i += 4) {
    let nibble = 0
    for (let j = 0; j < 4 && i + j < hashBits; j++) {
      if (vector[i + j] > 0) {
        nibble |= (1 << j)
      }
    }
    result += nibble.toString(16)
  }

  return result
}

/**
 * Structure fingerprint - captures message structure, not content
 * "Earn $500 daily!" and "Make $1000 today!" have same structure
 */
const getStructureHash = (text) => {
  const pattern = text
    .replace(/[A-Za-zА-Яа-яІіЇїЄєҐґ\u4e00-\u9fff]+/g, 'W') // Words (incl. Chinese)
    .replace(/\d+/g, 'N') // Numbers
    .replace(/https?:\/\/\S+/g, 'L') // Links
    .replace(/t\.me\/\S+/g, 'T') // Telegram links
    .replace(/@\w+/g, 'M') // Mentions
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, 'E') // Emoji
    .replace(/[^\w\s]/g, 'P') // Punctuation
    .replace(/\s+/g, '_')
    .substring(0, 100)

  return crypto.createHash('md5')
    .update(pattern)
    .digest('hex')
    .substring(0, 12)
}

// Simple tokenizer
const tokenize = (text) => {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
}

// FNV-1a hash (fast, good distribution)
const fnv1a = (str) => {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return hash
}

// Hamming distance between two hex hashes
const hammingDistance = (hash1, hash2) => {
  let distance = 0
  const len = Math.min(hash1.length, hash2.length)

  for (let i = 0; i < len; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16)
    distance += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1)
  }

  return distance
}

// ============================================================================
// LINK EXTRACTION
// ============================================================================

const extractLinks = (text) => {
  const patterns = [
    /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi,
    /t\.me\/[^\s<>"{}|\\^`[\]]+/gi,
    /[@][\w]+/g // Usernames as potential spam vectors
  ]

  const links = []
  for (const pattern of patterns) {
    const matches = text.match(pattern) || []
    links.push(...matches)
  }

  return [...new Set(links)].map(normalizeLink)
}

const normalizeLink = (link) => {
  return link
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/\?.*$/, '') // Remove query params
}

// ============================================================================
// ENTROPY CALCULATION
// ============================================================================

/**
 * Shannon entropy - spam often has low entropy (repetitive)
 */
const calculateEntropy = (text) => {
  if (!text || text.length === 0) return 0

  const freq = {}
  for (const char of text) {
    freq[char] = (freq[char] || 0) + 1
  }

  let entropy = 0
  const len = text.length
  for (const count of Object.values(freq)) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }

  return entropy
}

/**
 * Word entropy - variety of vocabulary
 */
const calculateWordEntropy = (text) => {
  const words = tokenize(text)
  if (words.length === 0) return 0

  const freq = {}
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1 })

  let entropy = 0
  const len = words.length
  for (const count of Object.values(freq)) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }

  return entropy
}

// ============================================================================
// VELOCITY TRACKING
// ============================================================================

/**
 * Record message occurrence across all tracking layers
 */
const recordOccurrence = async (text, userId, chatId, messageId) => {
  const now = Date.now()
  const member = `${userId}:${chatId}:${messageId}`
  const userChatMember = `${userId}:${chatId}`

  // Generate all hashes
  const exactHash = getExactHash(text)
  const simHash = getSimHash(text)
  const structHash = getStructureHash(text)
  const links = extractLinks(text)

  // Record exact message
  await store.zadd(`vel:exact:${exactHash}`, now, member)

  // Record fuzzy (simhash)
  await store.zadd(`vel:fuzzy:${simHash}`, now, member)

  // Record structure
  await store.zadd(`vel:struct:${structHash}`, now, member)

  // Record links
  for (const link of links) {
    const linkHash = getExactHash(link)
    await store.zadd(`vel:link:${linkHash}`, now, userChatMember)
    await store.sadd(`vel:user:${userId}:links`, linkHash)
  }

  // Record user activity
  await store.zadd(`vel:user:${userId}:activity`, now, `${chatId}:msg`)
  await store.hincrby(`vel:user:${userId}:stats`, 'totalMessages', 1)
  await store.hset(`vel:user:${userId}:stats`, 'lastActivity', now)
  await store.sadd(`vel:user:${userId}:chats`, chatId)

  // Record chat activity from this user
  await store.zadd(`vel:chat:${chatId}:user:${userId}`, now, messageId)

  return { exactHash, simHash, structHash, links }
}

/**
 * Get velocity score for a specific hash type
 */
const getHashVelocity = async (prefix, hash, window = CONFIG.WINDOWS.MEDIUM) => {
  const now = Date.now()
  const entries = await store.zrangebyscore(`vel:${prefix}:${hash}`, now - window, now)

  // Unique chats and users
  const chats = new Set()
  const users = new Set()

  for (const entry of entries) {
    const parts = entry.member.split(':')
    users.add(parts[0])
    chats.add(parts[1])
  }

  return {
    count: entries.length,
    uniqueChats: chats.size,
    uniqueUsers: users.size,
    entries
  }
}

// ============================================================================
// USER BEHAVIOR ANALYSIS
// ============================================================================

const analyzeUserBehavior = async (userId) => {
  const now = Date.now()

  // Get activity in different windows
  const microActivity = await store.zrangebyscore(
    `vel:user:${userId}:activity`,
    now - CONFIG.WINDOWS.MICRO,
    now
  )

  const shortActivity = await store.zrangebyscore(
    `vel:user:${userId}:activity`,
    now - CONFIG.WINDOWS.SHORT,
    now
  )

  const mediumActivity = await store.zrangebyscore(
    `vel:user:${userId}:activity`,
    now - CONFIG.WINDOWS.MEDIUM,
    now
  )

  // Calculate intervals between messages
  const timestamps = mediumActivity.map(e => e.score).sort((a, b) => a - b)
  const intervals = []
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1])
  }

  // Interval statistics
  let intervalStats = { mean: 0, variance: 0, cv: 1 }
  if (intervals.length > 1) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / intervals.length
    const stdDev = Math.sqrt(variance)
    intervalStats = {
      mean,
      variance,
      cv: mean > 0 ? stdDev / mean : 0 // Coefficient of variation
    }
  }

  // Unique chats
  const chats = await store.smembers(`vel:user:${userId}:chats`)

  return {
    microBurst: microActivity.length,
    shortActivity: shortActivity.length,
    hourlyActivity: mediumActivity.length,
    uniqueChats: chats.length,
    intervalStats,
    // Low CV = bot-like (very regular intervals)
    isBotLike: intervalStats.cv < 0.3 && intervals.length > 3,
    // High burst = flooding
    isFlooding: microActivity.length >= CONFIG.THRESHOLDS.BURST_PER_MINUTE
  }
}

// ============================================================================
// TEMPORAL ANALYSIS
// ============================================================================

const analyzeTemporalPattern = async (userId) => {
  const now = Date.now()
  const activity = await store.zrangebyscore(
    `vel:user:${userId}:activity`,
    now - CONFIG.WINDOWS.LONG,
    now
  )

  if (activity.length < 5) {
    return { entropy: 1, isNatural: true }
  }

  // Distribution by hour
  const hourDistribution = new Array(24).fill(0)
  activity.forEach(entry => {
    const hour = new Date(entry.score).getUTCHours()
    hourDistribution[hour]++
  })

  // Calculate entropy
  const total = activity.length
  let entropy = 0
  hourDistribution.forEach(count => {
    if (count > 0) {
      const p = count / total
      entropy -= p * Math.log2(p)
    }
  })

  // Normalize (max entropy = log2(24) ≈ 4.58)
  const normalizedEntropy = entropy / Math.log2(24)

  // Peak concentration
  const peakHour = hourDistribution.indexOf(Math.max(...hourDistribution))
  const peakConcentration = hourDistribution[peakHour] / total

  return {
    entropy: normalizedEntropy,
    peakHour,
    peakConcentration,
    // Unnatural: all activity in few hours
    isNatural: normalizedEntropy > 0.4 && peakConcentration < 0.5
  }
}

// ============================================================================
// NETWORK ANALYSIS
// ============================================================================

const analyzeNetwork = async (userId) => {
  // Get user's links
  const userLinks = await store.smembers(`vel:user:${userId}:links`)

  if (userLinks.length === 0) {
    return { isPartOfNetwork: false, isCoordinated: false, connectionCount: 0, connections: [] }
  }

  // Find other users who shared same links
  const connections = new Map()

  for (const linkHash of userLinks) {
    const entries = await store.zrangebyscore(
      `vel:link:${linkHash}`,
      Date.now() - CONFIG.WINDOWS.LONG,
      Date.now()
    )

    for (const entry of entries) {
      const [otherUserId] = entry.member.split(':')
      if (otherUserId !== String(userId)) {
        connections.set(otherUserId, (connections.get(otherUserId) || 0) + 1)
      }
    }
  }

  // Filter strong connections (shared 2+ links)
  const strongConnections = Array.from(connections.entries())
    .filter(([_, count]) => count >= 2)
    .map(([userId, sharedLinks]) => ({ userId, sharedLinks }))

  return {
    isPartOfNetwork: strongConnections.length > 0,
    connectionCount: strongConnections.length,
    connections: strongConnections.slice(0, 10),
    // Multiple users sharing multiple links = coordinated spam
    isCoordinated: strongConnections.length >= 3
  }
}

// ============================================================================
// DECAY FUNCTION
// ============================================================================

const calculateDecay = (timestamp) => {
  const age = Date.now() - timestamp
  return Math.pow(0.5, age / CONFIG.DECAY_HALF_LIFE)
}

const getDecayedCount = async (key, window) => {
  const now = Date.now()
  const entries = await store.zrangebyscore(key, now - window, now)

  let decayedCount = 0
  for (const entry of entries) {
    decayedCount += calculateDecay(entry.score)
  }

  return decayedCount
}

// ============================================================================
// MAIN SCORING ENGINE
// ============================================================================

const calculateVelocityScore = async (text, userId, chatId, messageId) => {
  // Skip very short messages
  if (!text || text.length < 5) {
    return { score: 0, confidence: 0, dominated: 'skip', signals: {} }
  }

  // Record this occurrence
  const hashes = await recordOccurrence(text, userId, chatId, messageId)

  // Collect all signals
  const signals = {}

  // 1. Exact message velocity
  const exactVelocity = await getHashVelocity('exact', hashes.exactHash)
  signals.exactMatch = {
    count: exactVelocity.count,
    uniqueChats: exactVelocity.uniqueChats,
    uniqueUsers: exactVelocity.uniqueUsers,
    score: Math.min(1, (exactVelocity.uniqueChats - 1) / CONFIG.THRESHOLDS.EXACT_MATCH_CHATS)
  }

  // 2. Fuzzy message velocity (simhash)
  const fuzzyVelocity = await getHashVelocity('fuzzy', hashes.simHash)
  signals.fuzzyMatch = {
    count: fuzzyVelocity.count,
    uniqueChats: fuzzyVelocity.uniqueChats,
    score: Math.min(1, (fuzzyVelocity.uniqueChats - 1) / CONFIG.THRESHOLDS.FUZZY_MATCH_CHATS)
  }

  // 3. Structure velocity
  const structVelocity = await getHashVelocity('struct', hashes.structHash)
  signals.structureMatch = {
    count: structVelocity.count,
    uniqueChats: structVelocity.uniqueChats,
    score: Math.min(1, (structVelocity.uniqueChats - 1) / CONFIG.THRESHOLDS.STRUCTURE_MATCH_CHATS)
  }

  // 4. Link velocity
  if (hashes.links.length > 0) {
    let maxLinkScore = 0
    for (const link of hashes.links) {
      const linkHash = getExactHash(link)
      const linkVelocity = await getHashVelocity('link', linkHash)
      const linkScore = Math.min(1, (linkVelocity.uniqueChats - 1) / CONFIG.THRESHOLDS.LINK_CHATS)
      maxLinkScore = Math.max(maxLinkScore, linkScore)
    }
    signals.linkVelocity = { score: maxLinkScore, linkCount: hashes.links.length }
  } else {
    signals.linkVelocity = { score: 0, linkCount: 0 }
  }

  // 5. User behavior
  const behavior = await analyzeUserBehavior(userId)
  signals.userBehavior = {
    ...behavior,
    burstScore: Math.min(1, behavior.microBurst / CONFIG.THRESHOLDS.BURST_PER_MINUTE),
    botScore: behavior.isBotLike ? 0.8 : 0
  }

  // 6. Temporal analysis
  const temporal = await analyzeTemporalPattern(userId)
  signals.temporal = {
    ...temporal,
    score: temporal.isNatural ? 0 : 0.5
  }

  // 7. Network analysis
  const network = await analyzeNetwork(userId)
  signals.network = {
    ...network,
    score: network.isCoordinated ? 0.9 : (network.isPartOfNetwork ? 0.5 : 0)
  }

  // 8. Content entropy
  const charEntropy = calculateEntropy(text)
  const wordEntropy = calculateWordEntropy(text)
  signals.entropy = {
    char: charEntropy,
    word: wordEntropy,
    // Low entropy = repetitive = suspicious
    score: charEntropy < 3 ? 0.3 : 0
  }

  // Calculate weighted final score
  const weights = {
    exactMatch: 0.30,
    fuzzyMatch: 0.15,
    structureMatch: 0.10,
    linkVelocity: 0.20,
    userBehavior: 0.10,
    temporal: 0.05,
    network: 0.08,
    entropy: 0.02
  }

  let totalScore = 0
  totalScore += signals.exactMatch.score * weights.exactMatch
  totalScore += signals.fuzzyMatch.score * weights.fuzzyMatch
  totalScore += signals.structureMatch.score * weights.structureMatch
  totalScore += signals.linkVelocity.score * weights.linkVelocity
  totalScore += (signals.userBehavior.burstScore + signals.userBehavior.botScore) / 2 * weights.userBehavior
  totalScore += signals.temporal.score * weights.temporal
  totalScore += signals.network.score * weights.network
  totalScore += signals.entropy.score * weights.entropy

  // Find dominant signal
  const dominantSignal = Object.entries(signals)
    .map(([name, data]) => ({ name, score: data.score || 0 }))
    .sort((a, b) => b.score - a.score)[0]

  // Calculate confidence based on signal agreement
  const activeSignals = Object.values(signals).filter(s => (s.score || 0) > 0.3).length
  const confidence = Math.min(0.95, 0.5 + activeSignals * 0.1)

  return {
    score: Math.min(1, totalScore),
    confidence,
    dominant: dominantSignal.name,
    signals,
    hashes,
    recommendation: getRecommendation(totalScore, signals)
  }
}

const getRecommendation = (score, signals) => {
  // Hard rules
  if (signals.exactMatch.uniqueChats >= 5) {
    return { action: 'MUTE_AND_DELETE', reason: 'Exact message in 5+ chats', confidence: 95 }
  }

  if (signals.network.isCoordinated) {
    return { action: 'MUTE_AND_DELETE', reason: 'Part of coordinated spam network', confidence: 90 }
  }

  if (signals.userBehavior.isFlooding) {
    return { action: 'MUTE', reason: 'Flooding detected', confidence: 85 }
  }

  // Score-based
  if (score >= 0.8) {
    return { action: 'MUTE_AND_DELETE', reason: 'High velocity spam score', confidence: Math.round(score * 100) }
  }

  if (score >= 0.6) {
    return { action: 'DELETE', reason: 'Likely spam', confidence: Math.round(score * 100) }
  }

  if (score >= 0.4) {
    return { action: 'FLAG', reason: 'Suspicious velocity', confidence: Math.round(score * 100) }
  }

  return { action: 'ALLOW', reason: 'Normal velocity', confidence: Math.round((1 - score) * 100) }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  calculateVelocityScore,
  recordOccurrence,
  analyzeUserBehavior,
  analyzeNetwork,
  getHashVelocity,

  // Hash functions (for testing/debugging)
  getExactHash,
  getSimHash,
  getStructureHash,
  extractLinks,
  calculateEntropy,
  hammingDistance,
  getDecayedCount,

  // Config
  CONFIG
}
