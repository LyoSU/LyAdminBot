const crypto = require('crypto')
const {
  client,
  SPAM_COLLECTION,
  initializeCollection
} = require('./qdrant-client')
const { qdrant: qdrantLog } = require('./logger')

/**
 * Calculate SHA256 hash of message content
 */
const generateContentHash = (text) => {
  return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex')
}

/**
 * Convert hash to valid Qdrant UUID using crypto
 */
const hashToUuid = (hash) => {
  // Take first 32 characters of hash and format as UUID v4
  const hex = hash.substring(0, 32)
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-${(parseInt(hex.substring(16, 17), 16) & 0x3 | 0x8).toString(16)}${hex.substring(17, 20)}-${hex.substring(20, 32)}`
}

/**
 * Initialize Qdrant collection on first use
 */
let isInitialized = false
const ensureInitialized = async () => {
  if (!isInitialized) {
    await initializeCollection()
    isInitialized = true
  }
}

/**
 * Save spam vector to Qdrant
 */
const saveSpamVector = async ({
  text,
  embedding,
  classification,
  confidence,
  features = {}
}) => {
  await ensureInitialized()

  const contentHash = generateContentHash(text)
  const pointId = hashToUuid(contentHash) // Convert hash to valid UUID

  try {
    // Check if point already exists
    const existingPoints = await client.retrieve(SPAM_COLLECTION, {
      ids: [pointId],
      with_payload: true
    })

    if (existingPoints.length > 0) {
      // Update existing point - increment hit count and update confidence
      const existing = existingPoints[0]
      const updatedHitCount = (existing.payload.hitCount || 1) + 1
      const updatedConfidence = Math.max(existing.payload.confidence || 0, confidence)

      await client.setPayload(SPAM_COLLECTION, {
        payload: {
          hitCount: updatedHitCount,
          lastMatched: new Date().toISOString(),
          confidence: updatedConfidence
        },
        points: [pointId]
      })

      qdrantLog.debug({ pointId, hitCount: updatedHitCount }, 'Updated existing vector')
      return pointId
    }

    // Create new vector point
    const point = {
      id: pointId,
      vector: embedding,
      payload: {
        contentHash,
        classification,
        confidence,
        features,
        hitCount: 1,
        lastMatched: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    }

    await client.upsert(SPAM_COLLECTION, {
      points: [point]
    })

    qdrantLog.debug({ pointId, classification }, 'Saved new vector')
    return pointId
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error saving spam vector')
    throw error
  }
}

/**
 * Find similar vectors in Qdrant with proper filtering
 */
const findSimilarVectors = async (embedding, threshold = 0.85, limit = 10, features = {}) => {
  await ensureInitialized()

  try {
    // Build filter with correct Qdrant syntax
    let filter = null

    // Only add filter if we have meaningful conditions
    const filterConditions = []

    if (features.hasLinks === true) {
      filterConditions.push({
        key: 'features.hasLinks',
        match: { value: true }
      })
    }

    if (features.isNewUser !== undefined) {
      filterConditions.push({
        key: 'features.isNewUser',
        match: { value: features.isNewUser }
      })
    }

    // Add time-based filtering for recent patterns
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Simplified filter - only use indexed fields until all indexes are created
    if (filterConditions.length > 0) {
      filter = {
        must: filterConditions
      }
    }

    const searchResult = await client.search(SPAM_COLLECTION, {
      vector: embedding,
      limit: Math.max(limit * 2, 20),
      score_threshold: threshold,
      filter: filter,
      with_payload: true
    })

    // Sort by score (similarity) descending and return top results
    const similarities = searchResult
      .map(point => ({
        id: point.id,
        classification: point.payload.classification,
        confidence: point.payload.confidence,
        features: point.payload.features,
        hitCount: point.payload.hitCount || 1,
        similarity: point.score,
        lastMatched: point.payload.lastMatched
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)

    return similarities
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error finding similar vectors')
    // Fallback to simple search without filter
    try {
      const fallbackResult = await client.search(SPAM_COLLECTION, {
        vector: embedding,
        limit: limit,
        score_threshold: threshold,
        with_payload: true
      })

      return fallbackResult.map(point => ({
        id: point.id,
        classification: point.payload.classification,
        confidence: point.payload.confidence,
        features: point.payload.features,
        hitCount: point.payload.hitCount || 1,
        similarity: point.score,
        lastMatched: point.payload.lastMatched
      }))
    } catch (fallbackError) {
      qdrantLog.error({ err: fallbackError }, 'Fallback search also failed')
      return []
    }
  }
}

/**
 * Get classification based on similar vectors
 */
const classifyBySimilarity = async (embedding) => {
  await ensureInitialized()

  try {
    // Find similar patterns with different confidence levels (no features for now)
    const highConfidence = await findSimilarVectors(embedding, 0.88, 5)
    const mediumConfidence = await findSimilarVectors(embedding, 0.83, 10)

    // Check high confidence matches first
    if (highConfidence.length > 0) {
      const bestMatch = highConfidence[0]

      // Update hit count for matched vector
      await client.setPayload(SPAM_COLLECTION, {
        payload: {
          hitCount: (bestMatch.hitCount || 1) + 1,
          lastMatched: new Date().toISOString()
        },
        points: [bestMatch.id]
      })

      return {
        classification: bestMatch.classification,
        confidence: Math.max(bestMatch.similarity, bestMatch.confidence * 0.95),
        source: 'qdrant_db',
        matchedPattern: bestMatch.id
      }
    }

    // Check medium confidence - different logic for clean vs spam
    const cleanMatches = mediumConfidence.filter(m => m.classification === 'clean')
    const spamMatches = mediumConfidence.filter(m => m.classification === 'spam')

    // Prefer clean matches with good confidence
    if (cleanMatches.length > 0 && cleanMatches[0].similarity >= 0.85) {
      const bestMatch = cleanMatches[0]

      await client.setPayload(SPAM_COLLECTION, {
        payload: {
          hitCount: (bestMatch.hitCount || 1) + 1,
          lastMatched: new Date().toISOString()
        },
        points: [bestMatch.id]
      })

      return {
        classification: 'clean',
        confidence: Math.max(bestMatch.similarity * 0.95, bestMatch.confidence * 0.9),
        source: 'qdrant_db',
        matchedPattern: bestMatch.id
      }
    }

    // Check spam matches (be more cautious)
    if (spamMatches.length > 0 && spamMatches[0].confidence > 0.8) {
      const bestMatch = spamMatches[0]

      await client.setPayload(SPAM_COLLECTION, {
        payload: {
          hitCount: (bestMatch.hitCount || 1) + 1,
          lastMatched: new Date().toISOString()
        },
        points: [bestMatch.id]
      })

      return {
        classification: 'spam',
        confidence: Math.min(bestMatch.confidence, bestMatch.similarity) * 0.95,
        source: 'qdrant_db',
        matchedPattern: bestMatch.id
      }
    }

    // No confident match found
    return null
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error classifying by similarity')
    return null
  }
}

/**
 * Clean up old and unused vectors
 */
const cleanupOldVectors = async () => {
  await ensureInitialized()

  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    // Search for old vectors with low hit count
    const oldVectors = await client.scroll(SPAM_COLLECTION, {
      filter: {
        must: [
          {
            range: {
              hitCount: {
                lt: 2
              }
            }
          },
          {
            range: {
              createdAt: {
                lt: ninetyDaysAgo
              }
            }
          }
        ]
      },
      with_payload: true,
      limit: 1000
    })

    if (oldVectors.points && oldVectors.points.length > 0) {
      const idsToDelete = oldVectors.points.map(point => point.id)

      await client.delete(SPAM_COLLECTION, {
        points: idsToDelete
      })

      qdrantLog.info({ count: idsToDelete.length }, 'Cleaned up old vectors')
      return idsToDelete.length
    }

    return 0
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error cleaning up old vectors')
    return 0
  }
}

/**
 * Merge similar vectors to reduce database size
 * Note: In Qdrant, we don't merge vectors but can identify and remove duplicates
 */
const mergeSimilarVectors = async (threshold = 0.95) => {
  await ensureInitialized()

  try {
    // Get all vectors sorted by hit count
    const allVectors = await client.scroll(SPAM_COLLECTION, {
      with_payload: true,
      with_vector: true,
      limit: 1000
    })

    if (!allVectors.points || allVectors.points.length < 2) {
      return 0
    }

    const vectors = allVectors.points.sort((a, b) =>
      (b.payload.hitCount || 1) - (a.payload.hitCount || 1)
    )

    let mergedCount = 0
    const toDelete = []

    // Find very similar vectors
    for (let i = 0; i < vectors.length - 1; i++) {
      if (toDelete.includes(vectors[i].id)) continue

      for (let j = i + 1; j < vectors.length; j++) {
        if (toDelete.includes(vectors[j].id)) continue

        // Find similar vectors with same classification
        const similarVectors = await client.search(SPAM_COLLECTION, {
          vector: vectors[i].vector,
          limit: 5,
          score_threshold: threshold,
          filter: {
            must: [
              {
                match: {
                  classification: vectors[i].payload.classification
                }
              }
            ]
          },
          with_payload: true
        })

        const duplicate = similarVectors.find(v => v.id === vectors[j].id)
        if (duplicate && duplicate.score >= threshold) {
          // Merge into the vector with higher hit count
          const keepVector = vectors[i]
          const deleteVector = vectors[j]

          // Update the keeper with combined stats
          await client.setPayload(SPAM_COLLECTION, {
            payload: {
              hitCount: (keepVector.payload.hitCount || 1) + (deleteVector.payload.hitCount || 1),
              confidence: Math.max(
                keepVector.payload.confidence || 0,
                deleteVector.payload.confidence || 0
              ),
              lastMatched: new Date().toISOString()
            },
            points: [keepVector.id]
          })

          toDelete.push(deleteVector.id)
          mergedCount++
        }
      }
    }

    // Delete merged vectors
    if (toDelete.length > 0) {
      await client.delete(SPAM_COLLECTION, {
        points: toDelete
      })
      qdrantLog.info({ merged: mergedCount }, 'Merged similar vectors')
    }

    return mergedCount
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error merging similar vectors')
    return 0
  }
}

/**
 * Get knowledge base statistics
 */
const getKnowledgeStats = async () => {
  await ensureInitialized()

  try {
    // Get collection info
    const collectionInfo = await client.getCollection(SPAM_COLLECTION)
    const totalVectors = collectionInfo.vectors_count || 0

    // Get sample vectors for statistics calculation
    const sampleVectors = await client.scroll(SPAM_COLLECTION, {
      with_payload: ['hitCount', 'confidence', 'classification'],
      limit: Math.min(totalVectors, 1000) // Sample up to 1000 vectors for stats
    })

    let totalHits = 0
    let avgConfidenceSpam = 0
    let avgConfidenceClean = 0
    let spamCount = 0
    let cleanCount = 0

    if (sampleVectors.points) {
      sampleVectors.points.forEach(point => {
        totalHits += point.payload.hitCount || 1
        if (point.payload.classification === 'spam') {
          avgConfidenceSpam += point.payload.confidence || 0
          spamCount++
        } else {
          avgConfidenceClean += point.payload.confidence || 0
          cleanCount++
        }
      })
    }

    // Calculate approximate counts based on sample
    const sampleSize = sampleVectors.points ? sampleVectors.points.length : 0
    const spamRatio = sampleSize > 0 ? spamCount / sampleSize : 0
    const cleanRatio = sampleSize > 0 ? cleanCount / sampleSize : 0

    const estimatedSpamCount = Math.round(totalVectors * spamRatio)
    const estimatedCleanCount = Math.round(totalVectors * cleanRatio)

    return {
      totalPatterns: totalVectors,
      byClassification: [
        {
          _id: 'spam',
          count: estimatedSpamCount,
          avgConfidence: spamCount > 0 ? avgConfidenceSpam / spamCount : 0,
          totalHits: Math.round(totalHits * spamRatio)
        },
        {
          _id: 'clean',
          count: estimatedCleanCount,
          avgConfidence: cleanCount > 0 ? avgConfidenceClean / cleanCount : 0,
          totalHits: Math.round(totalHits * cleanRatio)
        }
      ],
      estimatedSizeMB: (totalVectors * 1536 * 4 / (1024 * 1024)).toFixed(2), // 4 bytes per float32
      performanceWarning: totalVectors > 50000
        ? 'Consider using quantization for better performance'
        : null
    }
  } catch (error) {
    qdrantLog.error({ err: error }, 'Error getting knowledge stats')
    return {
      totalPatterns: 0,
      byClassification: []
    }
  }
}

module.exports = {
  saveSpamVector,
  classifyBySimilarity,
  cleanupOldVectors,
  mergeSimilarVectors,
  getKnowledgeStats
}
