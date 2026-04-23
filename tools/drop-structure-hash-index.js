#!/usr/bin/env node
/**
 * One-shot migration: remove the `structureHash` field + its compound index
 * from the SpamSignature collection.
 *
 * Why this exists:
 *   commit ff0215d dropped all code that wrote or read structureHash — the
 *   field had been write-only for months, indexed but never queried. Mongoose
 *   auto-creates new indexes but does NOT drop indexes removed from the
 *   schema, so the `structureHash_1_status_1_confirmations_1` compound index
 *   and all per-doc `structureHash` values still live in production Mongo.
 *
 * What this does:
 *   1) Drop the `structureHash_1_status_1_confirmations_1` index if present
 *   2) `$unset` the `structureHash` field from every document
 *
 * Safety:
 *   - Idempotent. Safe to run multiple times.
 *   - Read-only until confirmed: run with `--dry` to see counts without
 *     making any changes.
 *   - Does NOT touch the other three hash indexes (exactHash, normalizedHash,
 *     fuzzyHash) or any other field.
 *
 * Usage:
 *   MONGODB_URI=... node tools/drop-structure-hash-index.js --dry   # preview
 *   MONGODB_URI=... node tools/drop-structure-hash-index.js         # apply
 */

const mongoose = require('mongoose')

const dryRun = process.argv.includes('--dry')
const INDEX_NAME = 'structureHash_1_status_1_confirmations_1'
const COLLECTION = 'spamsignatures'

async function main () {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required')
    process.exit(1)
  }

  const conn = await mongoose.createConnection(process.env.MONGODB_URI, { maxPoolSize: 2 }).asPromise()
  const coll = conn.collection(COLLECTION)

  // Step 1: report current state
  const indexes = await coll.indexes()
  const hasIndex = indexes.some(i => i.name === INDEX_NAME)
  const withField = await coll.countDocuments({ structureHash: { $exists: true } })
  console.log(`Collection:        ${COLLECTION}`)
  console.log(`Mode:              ${dryRun ? 'DRY RUN (no changes)' : 'APPLY'}`)
  console.log(`Index '${INDEX_NAME}' present: ${hasIndex}`)
  console.log(`Documents with structureHash:     ${withField}`)

  if (dryRun) {
    console.log('\n[dry] Skipping changes — rerun without --dry to apply.')
    await conn.close()
    return
  }

  // Step 2: drop the index (idempotent — ignore "ns not found" / "index not found")
  if (hasIndex) {
    try {
      await coll.dropIndex(INDEX_NAME)
      console.log(`Dropped index ${INDEX_NAME}`)
    } catch (err) {
      // 27 = IndexNotFound, already gone
      if (err.code === 27) console.log(`Index ${INDEX_NAME} already absent`)
      else throw err
    }
  }

  // Step 3: unset the field across all docs. `updateMany` is write-safe and
  // short — no batching needed even for millions of docs since $unset only
  // touches the metadata.
  if (withField > 0) {
    const res = await coll.updateMany(
      { structureHash: { $exists: true } },
      { $unset: { structureHash: '' } }
    )
    console.log(`Cleared structureHash on ${res.modifiedCount} / ${res.matchedCount} documents`)
  }

  await conn.close()
  console.log('\nDone.')
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
