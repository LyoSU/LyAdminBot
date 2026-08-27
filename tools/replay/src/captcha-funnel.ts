/**
 * The captcha funnel: what happens between asking somebody to prove they are
 * human and finding out whether they did.
 *
 * Written for one question that the records could not answer on 2026-08-27.
 * The whisper-first design posts a PUBLIC card 45 seconds after an unanswered
 * whisper, and the whole justification for asking at all is that a wrong guess
 * costs the member one private tap instead of a public accusation. So: how many
 * members answer before that 45 seconds, and how many are accused in front of
 * the chat and then answer anyway?
 *
 * That measurement was impossible. A tap only ever produced a log line, and
 * container logs begin at the last boot. Of 65 gates over the 47.6 hours to
 * 2026-08-27, exactly four were legible afterwards — the four nobody answered —
 * and all four fired their consequence at 165s, which is 45 + 120, i.e. every
 * one of them had gone public first. The other 61 were invisible.
 * `recordCaptchaEvent` now writes the row; this reads it back.
 *
 * Usage:
 *   MONGODB_URI=... node --experimental-strip-types src/captcha-funnel.ts [--days 14]
 *
 * Read it against `pipeline_decisions` for the same window: this says what
 * happened to the gates, that says which path opened them.
 */
import { MongoClient } from 'mongodb'

interface CaptchaEvent {
  chatId: number
  userId: number
  event: 'delivered' | 'undeliverable' | 'passed' | 'ignored' | 'dropped'
  via?: 'whisper' | 'visible'
  ageMs?: number
  wentPublic?: boolean
  createdAt: Date
}

/** Where the visible fallback goes up; everything here is measured against it. */
const FALLBACK_MS = 45_000

const pct = (n: number, of: number): string =>
  of === 0 ? '—' : `${((n / of) * 100).toFixed(1)}%`

const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const main = async (): Promise<void> => {
  const uri = process.env['MONGODB_URI']
  if (!uri) throw new Error('MONGODB_URI is required')
  const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 14
  const since = new Date(Date.now() - days * 86_400_000)

  const client = new MongoClient(uri)
  await client.connect()
  try {
    const rows = await client.db().collection('pipeline_captcha')
      .find({ createdAt: { $gte: since } }).sort({ createdAt: 1 }).toArray() as unknown as CaptchaEvent[]

    if (rows.length === 0) {
      console.log(`No captcha events in the last ${days}d. Either no gate has been`)
      console.log('issued since the instrumentation shipped, or the bot predates it.')
      return
    }

    const of = (e: CaptchaEvent['event']): CaptchaEvent[] => rows.filter((r) => r.event === e)
    const delivered = of('delivered')
    const undeliverable = of('undeliverable')
    const passed = of('passed')
    const ignored = of('ignored')
    /** Banned, kicked or settled by a vote before the gate resolved itself. */
    const dropped = of('dropped')
    const asked = delivered.length + undeliverable.length

    console.log(`window: ${rows[0]?.createdAt.toISOString()} → ${rows.at(-1)?.createdAt.toISOString()}`)
    console.log(`\ngates opened            ${asked}`)
    console.log(`  delivered             ${delivered.length}  (${pct(delivered.length, asked)})`)
    console.log(`    via whisper         ${delivered.filter((r) => r.via === 'whisper').length}`)
    console.log(`    via visible only    ${delivered.filter((r) => r.via === 'visible').length}`)
    console.log(`  never deliverable     ${undeliverable.length}  (${pct(undeliverable.length, asked)})`)
    console.log(`\nof the delivered:`)
    console.log(`  answered              ${passed.length}  (${pct(passed.length, delivered.length)})`)
    console.log(`  ignored               ${ignored.length}  (${pct(ignored.length, delivered.length)})`)
    console.log(`  dropped (removed)     ${dropped.length}  (${pct(dropped.length, delivered.length)})`)
    console.log(`  still open            ${delivered.length - passed.length - ignored.length - dropped.length}`)
    console.log(`  of those dropped, left a public card up: ` +
      `${dropped.filter((r) => r.wentPublic === true).length}`)

    /**
     * The question itself. A pass with `wentPublic` is a member who was shown
     * to the whole chat as a suspected bot and then proved otherwise — the cost
     * the 45-second window is buying, and the number to weigh against the
     * restriction it avoids leaving in place.
     */
    const beforeFallback = passed.filter((r) => (r.ageMs ?? 0) < FALLBACK_MS)
    const afterFallback = passed.filter((r) => (r.ageMs ?? 0) >= FALLBACK_MS)
    const publiclyAsked = passed.filter((r) => r.wentPublic === true)
    console.log(`\n── the 45-second window ──`)
    console.log(`answered before ${FALLBACK_MS / 1000}s   ${beforeFallback.length}  (${pct(beforeFallback.length, passed.length)})`)
    console.log(`answered after       ${afterFallback.length}  (${pct(afterFallback.length, passed.length)})`)
    console.log(`had gone public      ${publiclyAsked.length}  (${pct(publiclyAsked.length, passed.length)}) ← accused, then answered`)

    const ages = passed.map((r) => r.ageMs ?? 0).sort((a, b) => a - b)
    if (ages.length > 0) {
      console.log(`\nhow long a tap takes: p50 ${seconds(quantile(ages, 0.5))}` +
        `  p75 ${seconds(quantile(ages, 0.75))}` +
        `  p90 ${seconds(quantile(ages, 0.9))}` +
        `  max ${seconds(ages.at(-1) ?? 0)}`)
      /**
       * Where the window WOULD sit if it were set from the members rather than
       * from a guess: the point past which few honest taps still arrive.
       */
      console.log(`a window at p90 would be ${seconds(quantile(ages, 0.9))}; it is currently ${seconds(FALLBACK_MS)}`)
    }

    const byChat = new Map<number, { gates: number; public: number }>()
    for (const r of rows) {
      if (r.event !== 'passed' && r.event !== 'ignored' && r.event !== 'dropped') continue
      const seen = byChat.get(r.chatId) ?? { gates: 0, public: 0 }
      seen.gates += 1
      if (r.wentPublic === true) seen.public += 1
      byChat.set(r.chatId, seen)
    }
    console.log('\n── public cards by chat ──')
    for (const [chatId, seen] of [...byChat].sort((a, b) => b[1].public - a[1].public)) {
      console.log(`c${chatId}  resolved=${seen.gates}  went public=${seen.public} (${pct(seen.public, seen.gates)})`)
    }
  } finally {
    await client.close()
  }
}

await main()
