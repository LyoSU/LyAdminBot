/**
 * One-off catch-up for `MongoStore.pruneDormantRecords` (offline batch job —
 * runs OUTSIDE the bot process).
 *
 * The bot prunes one bounded batch a day, which offsets ordinary growth but
 * would take weeks to work through a backlog that has been accumulating since
 * v1. This runs the SAME method in a loop until it finds nothing more, and then
 * rebuilds the secondary indexes.
 *
 * The rebuild is not decoration and it is where most of the space is. Atlas
 * measures a free-tier cluster's quota as `dataSize + indexSize`. Deleting
 * documents drops `dataSize` immediately, but an index keeps the pages of the
 * entries it no longer needs until it is rebuilt, and `compact` is not
 * permitted on M0 — dropping and recreating an index is.
 *
 * What it will NOT remove is described on `pruneDormantRecords`, and reading
 * that before running this is the point of it living in one place: standing
 * lives in these collections, and the last cleanup of them (2026-07-06) is the
 * reason several signals spent a month firing on people who had been here for
 * years.
 *
 * Usage:
 *   MONGODB_URI=... tsx src/prune.ts            # prune, then rebuild indexes
 *   MONGODB_URI=... tsx src/prune.ts --dry-run  # report the totals, change nothing
 *   MONGODB_URI=... tsx src/prune.ts --no-reindex
 */
import type { Collection, Document } from 'mongodb'
import { MongoStore, dormantFilters } from '@lyadmin/data'

const MAX_ROUNDS = 500

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * Rebuild every secondary index on a collection, preserving each one's options.
 *
 * Discovered rather than listed. A hand-written list rebuilt three of the four
 * indexes on `users` on the first run here, which is the failure mode of every
 * hand-written list: it was not wrong about the ones it named, it was silently
 * incomplete, and the leftover index kept its pages. `_id_` is skipped because
 * MongoDB will not drop it, and it never carries dead entries anyway.
 *
 * `unique`, `sparse` and `expireAfterSeconds` are carried across explicitly.
 * Recreating a unique index as a plain one would remove a constraint the data
 * depends on, and losing a TTL would turn a bounded collection unbounded.
 */
const rebuildIndexes = async (collection: Collection<Document>): Promise<void> => {
  for (const index of await collection.indexes()) {
    const name = index.name
    if (!name || name === '_id_') continue
    try {
      await collection.dropIndex(name)
      await collection.createIndex(index.key as Document, {
        name,
        ...(index.unique === true ? { unique: true } : {}),
        ...(index.sparse === true ? { sparse: true } : {}),
        ...(typeof index.expireAfterSeconds === 'number'
          ? { expireAfterSeconds: index.expireAfterSeconds }
          : {})
      })
      console.log(`  rebuilt ${collection.collectionName}.${name}`)
    } catch (err) {
      // One index failing must not cost the rest their rebuild — and a dropped
      // index that could not be recreated is the one outcome worth shouting
      // about, so the message says which.
      console.warn(`  FAILED ${collection.collectionName}.${name}: ${(err as Error).message}`)
    }
  }
}

const main = async (): Promise<void> => {
  const uri = process.env['MONGODB_URI']
  if (!uri) throw new Error('MONGODB_URI is required')
  const dryRun = process.argv.includes('--dry-run')
  const reindex = !process.argv.includes('--no-reindex')

  const store = new MongoStore()
  await store.connect(uri)

  /** Quota as Atlas counts it, so the before/after is the number that matters. */
  const quota = async (): Promise<string> => {
    const stats = await store.storageStats()
    return `${megabytes(stats.dataSize + stats.indexSize)} ` +
      `(data ${megabytes(stats.dataSize)}, indexes ${megabytes(stats.indexSize)})`
  }
  console.log(`before: ${await quota()}`)

  if (dryRun) {
    // The store's own filters, imported rather than restated. A dry run that
    // describes a different set from the one the deletion uses is worse than no
    // dry run at all, because its reassurance is believed.
    const filters = dormantFilters()
    const [members, users, allMembers, allUsers] = await Promise.all([
      store.groupMembers.countDocuments(filters.members),
      store.users.countDocuments(filters.users),
      store.groupMembers.countDocuments({}),
      store.users.countDocuments({})
    ])
    console.log('--dry-run: nothing will be changed')
    console.log(`  groupmembers: ${members} of ${allMembers} would go`)
    console.log(`  users:        ${users} of ${allUsers} would go`)
    await store.close()
    return
  }

  let members = 0
  let users = 0
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const batch = await store.pruneDormantRecords()
    members += batch.members
    users += batch.users
    if (batch.members === 0 && batch.users === 0) break
    if (round % 10 === 0) console.log(`  round ${round}: ${members} members, ${users} users so far`)
  }
  console.log(`pruned ${members} groupmembers, ${users} users`)

  if (reindex) {
    await rebuildIndexes(store.groupMembers)
    await rebuildIndexes(store.users)
  }

  console.log(`after:  ${await quota()}`)
  await store.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
