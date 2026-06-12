/**
 * Signature-corpus hygiene. The prod spamsignatures collection is partly
 * poisoned: emoji-collision hashes (sha of the empty string) and velocity
 * waves of innocent short texts got confirmed as signatures, which turns
 * into automatic false positives for anyone who says "доброго ранку".
 *
 * DRY-RUN by default: prints what would change and why. Nothing is ever
 * deleted even with --apply — poisoned records are disabled (disabledAt),
 * which both v1 queries with null-guards and the v2 port respect.
 *
 * Usage:
 *   MONGODB_URI=... tsx src/clean-signatures.ts          # report only
 *   MONGODB_URI=... tsx src/clean-signatures.ts --apply  # disable them
 */
import { MongoClient, type Document } from 'mongodb'
import { normalizeHeavy, sha256 } from '@lyadmin/data'

const APPLY = process.argv.includes('--apply')

/** sha256('') truncated — the known emoji-collision poison hash. */
const EMPTY_HASH = sha256('')

const SHORT_LIMIT = 25

interface Finding {
  id: unknown
  reason: string
  sample: string
}

const main = async (): Promise<void> => {
  const uri = process.env['MONGODB_URI']
  if (!uri) throw new Error('MONGODB_URI is required')
  const client = new MongoClient(uri)
  await client.connect()
  const collection = client.db().collection('spamsignatures')

  const docs = await collection
    .find({ disabledAt: { $exists: false } })
    .project({ sampleText: 1, normalizedHash: 1, fuzzyHash: 1, status: 1, confirmations: 1, uniqueGroups: 1 })
    .toArray()

  const findings: Finding[] = []
  for (const doc of docs as Document[]) {
    const sample = String(doc['sampleText'] ?? '')
    const reason = classify(doc, sample)
    if (reason) findings.push({ id: doc['_id'], reason, sample: sample.slice(0, 60) })
  }

  const byReason = new Map<string, number>()
  for (const f of findings) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1)

  console.log(`scanned: ${docs.length} active signatures`)
  console.log(`poisoned: ${findings.length}`)
  for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`)
  console.log('\nsample of findings:')
  for (const f of findings.slice(0, 25)) console.log(`  [${f.reason}] "${f.sample}"`)

  if (!APPLY) {
    console.log('\ndry-run: nothing changed. Re-run with --apply to disable these records.')
  } else {
    const ids = findings.map((f) => f.id)
    const result = await collection.updateMany(
      { _id: { $in: ids as never[] } },
      { $set: { disabledAt: new Date(), disabledBy: 'corpus_cleanup_v2' } }
    )
    console.log(`\napplied: disabled ${result.modifiedCount} records (nothing deleted).`)
  }

  await client.close()
}

const classify = (doc: Document, sample: string): string | null => {
  // Emoji-collision poison: hash of the empty normalization.
  if (doc['normalizedHash'] === EMPTY_HASH) return 'empty_hash_collision'
  // Same bug expressed differently: nothing left after heavy normalization.
  if (sample.length > 0 && normalizeHeavy(sample).length < 5) return 'no_textual_content'
  // Greeting-length chatter that got swept up by a velocity wave.
  if (sample.trim().length > 0 && sample.trim().length < SHORT_LIMIT && !/https?:\/\/|t\.me|@\w|\+\d/.test(sample)) {
    return 'short_innocuous'
  }
  // A signature without any sample text cannot be reviewed — distrust it.
  if (sample.trim().length === 0) return 'no_sample_text'
  return null
}

main().catch((err) => {
  console.error('clean-signatures failed:', err)
  process.exit(1)
})
