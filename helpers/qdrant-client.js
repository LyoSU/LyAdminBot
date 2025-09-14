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
          m: 16,           // Number of connections per element (balanced)
          ef_construct: 200, // Size of candidate list during construction
          full_scan_threshold: 10000 // Use HNSW for collections > 10k vectors
        },
        // Use quantization to reduce memory usage for large datasets
        quantization_config: {
          scalar: {
            type: 'int8',
            quantile: 0.99,
            always_ram: true
          }
        },
        // Optimize storage
        optimizers_config: {
          default_segment_number: 2,
          max_segment_size: 20000,
          memmap_threshold: 50000
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

      console.log(`[QDRANT] Created payload indexes for ${SPAM_COLLECTION}`)
    } else {
      console.log(`[QDRANT] Collection ${SPAM_COLLECTION} already exists`)
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
