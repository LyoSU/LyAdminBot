/**
 * One-off: take back the change-of-mind flags `castBallot` wrote by mistake
 * (offline job — runs OUTSIDE the bot process, once, after the fixed bot is up).
 *
 * From the deduplicated ballot (2026-09-01) to the fix (2026-09-02) every
 * voter's first ballot was stored as `changedMind: true`, so the "who voted"
 * roster called every voter a turncoat. `MongoStore.forgetUnearnedChangeOfMind`
 * says what is put right and what is given up; this only aims it.
 *
 * `--before` is the moment the fixed bot started taking ballots. It is required
 * rather than defaulted to "now", because a default that is wrong by an hour
 * would silently erase flags the fixed write set for real.
 *
 * Usage:
 *   MONGODB_URI=... tsx src/repair.ts --before 2026-09-02T19:00:00Z
 *   MONGODB_URI=... tsx src/repair.ts --before 2026-09-02T19:00:00Z --dry-run
 */
import { MongoStore } from '@lyadmin/data'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const main = async (): Promise<void> => {
  const uri = process.env['MONGODB_URI']
  if (!uri) throw new Error('MONGODB_URI is required')
  const raw = argument('--before')
  const before = raw === undefined ? new Date(NaN) : new Date(raw)
  if (!Number.isFinite(before.getTime())) {
    throw new Error('--before <ISO timestamp of the fixed deploy> is required')
  }
  const dryRun = process.argv.includes('--dry-run')

  const store = new MongoStore()
  await store.connect(uri)
  try {
    const affected = await store.votes.countDocuments({
      createdAt: { $lt: before }, 'ballots.taps': { $exists: true }
    })
    console.log(`${affected} questions carry ballots written between deduplication and the fix`)
    if (dryRun) {
      console.log('--dry-run: nothing will be changed')
      return
    }
    const { questions } = await store.forgetUnearnedChangeOfMind(before)
    console.log(`repaired ${questions} questions`)
  } finally {
    await store.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
