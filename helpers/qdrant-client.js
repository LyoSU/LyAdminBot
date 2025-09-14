const { QdrantClient } = require('@qdrant/js-client-rest')

// Qdrant client configuration
const client = new QdrantClient({
  url: process.env.QDRANT_URL || 'http://localhost:6333',
  apiKey: process.env.QDRANT_API_KEY
})

// Collection name for spam vectors
const SPAM_COLLECTION = 'spam_vectors'

// Vector configuration
const VECTOR_SIZE = 1536 // text-embedding-3-small dimensions
const DISTANCE_METRIC = 'Cosine'

/**
 * Initialize Qdrant collection for spam vectors
 */
const initializeCollection = async () => {
  try {
    // Check if collection exists
    const collections = await client.getCollections()
    const collectionExists = collections.collections.some(
      collection => collection.name === SPAM_COLLECTION
    )

    if (!collectionExists) {
      // Create collection with optimized configuration for spam detection
      await client.createCollection(SPAM_COLLECTION, {
        vectors: {
          size: VECTOR_SIZE,
          distance: DISTANCE_METRIC
        },
        // Optimize for high-speed searches with good recall
        hnsw_config: {
          m: 32,           // Increased for better accuracy (spam detection needs precision)
          ef_construct: 400, // Higher for better graph quality
          full_scan_threshold: 5000 // Lower threshold for better performance
        },
        // Use quantization to reduce memory usage by 75%
        quantization_config: {
          scalar: {
            type: 'int8',
            quantile: 0.99,
            always_ram: true
          }
        },
        // Optimize storage for spam patterns
        optimizers_config: {
          default_segment_number: 4, // More segments for better parallelization
          max_segment_size: 50000,   // Larger segments for spam datasets
          memmap_threshold: 100000,  // Use memmap for large collections
          indexing_threshold: 10000, // Start indexing earlier
          flush_interval_sec: 30     // More frequent flushes for real-time updates
        }
      })

      console.log(`[QDRANT] Created collection: ${SPAM_COLLECTION}`)

      // Create payload index for classification field
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'classification',
        field_schema: 'keyword'
      })

      // Create payload index for confidence field
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'confidence',
        field_schema: 'float'
      })

      // Create payload index for lastMatched field for cleanup
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'lastMatched',
        field_schema: 'datetime'
      })

      // Create payload index for hitCount for popular pattern detection
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'hitCount',
        field_schema: 'integer'
      })

      // Create payload index for createdAt for time-based filtering
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'createdAt',
        field_schema: 'datetime'
      })

      // Create compound index for spam pattern analysis
      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'features.hasLinks',
        field_schema: 'bool'
      })

      await client.createPayloadIndex(SPAM_COLLECTION, {
        field_name: 'features.isNewUser',
        field_schema: 'bool'
      })

      console.log(`[QDRANT] Created payload indexes for ${SPAM_COLLECTION}`)
    } else {
      console.log(`[QDRANT] Collection ${SPAM_COLLECTION} already exists`)

      // Try to create missing indexes if they don't exist
      try {
        await client.createPayloadIndex(SPAM_COLLECTION, {
          field_name: 'hitCount',
          field_schema: 'integer'
        })
        console.log(`[QDRANT] Added missing hitCount index`)
      } catch (indexError) {
        // Index might already exist, that's ok
      }

      try {
        await client.createPayloadIndex(SPAM_COLLECTION, {
          field_name: 'features.hasLinks',
          field_schema: 'bool'
        })
        console.log(`[QDRANT] Added missing features.hasLinks index`)
      } catch (indexError) {
        // Index might already exist, that's ok
      }
    }

    return true
  } catch (error) {
    console.error('[QDRANT] Error initializing collection:', error)
    return false
  }
}

/**
 * Get collection info and stats
 */
const getCollectionInfo = async () => {
  try {
    const info = await client.getCollection(SPAM_COLLECTION)
    return info
  } catch (error) {
    console.error('[QDRANT] Error getting collection info:', error)
    return null
  }
}

/**
 * Health check for Qdrant connection
 */
const healthCheck = async () => {
  try {
    const health = await client.api('cluster')
    return health.status === 'ok'
  } catch (error) {
    console.error('[QDRANT] Health check failed:', error)
    return false
  }
}

module.exports = {
  client,
  SPAM_COLLECTION,
  VECTOR_SIZE,
  DISTANCE_METRIC,
  initializeCollection,
  getCollectionInfo,
  healthCheck
}
