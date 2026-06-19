/**
 * Replay: the cutover gate. Feeds historical moderation events through the
 * v2 core pipeline OFFLINE (no Telegram, no LLM by default) and reports
 * how v2 would have acted vs what v1 actually did.
 *
 * Big-bang switch is allowed ONLY after replay shows zero unexplained
 * false positives over 2–4 weeks of production data.
 *
 * Usage:
 *   MONGODB_URI=... node --experimental-strip-types src/replay.ts [--days 14] [--limit 5000]
 *   MONGODB_URI=... node --experimental-strip-types src/replay.ts --signatures [--limit 5000]
 *
 * --signatures mode: modevents expire after 7 days, but spamsignatures keep
 * sampleText forever. Replaying that corpus measures how much CONFIRMED spam
 * the signal+score layer alone would catch (the signature port is excluded
 * on purpose — matching a signature against itself proves nothing).
 *
 * Reads v1 `modevents` (messagePreview + action + confidence + reason) and
 * reconstructs a best-effort EvaluationInput. Fields v1 never logged stay
 * at defaults — replay UNDERSTATES signals, so a v2 "spam" call here is a
 * strong claim while a v2 "none" needs human review against the preview.
 */
import { MongoClient } from 'mongodb'
import {
  evaluateMessage,
  type ChatPolicy, type EvaluationInput, type UserSnapshot, type VerdictAction
} from '@lyadmin/core'

/** v1 modevents schema (database/models/modEvent.js). TTL is 7 days. */
interface ModEvent {
  chatId?: number
  targetId?: number
  messagePreview?: string
  actionType?: string
  confidence?: number
  reason?: string
  createdAt?: Date
}

const argValue = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const DAYS = argValue('--days', 14)
const LIMIT = argValue('--limit', 5000)

const defaultPolicy: ChatPolicy = {
  enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true,
  reactionModeration: false, externalBanEnabled: true, customRules: [], trustedUserIds: []
}

const unknownUser = (userId: number): UserSnapshot => ({
  id: userId, username: null, displayName: 'replayed', languageCode: null,
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: null, localAgeDays: null,
  // v1 acted mostly on newcomers; replay assumes the conservative case.
  messagesInChat: 1, messagesGlobal: 1, groupsActive: 1,
  spamDetections: 0, reputationScore: 50, reputationStatus: 'neutral',
  externalBan: null, unofficialClientRisk: null, avatars: null,
  nameChurn24h: 0, usernameChurn24h: 0
})

const extractUrls = (text: string): EvaluationInput['message']['urls'] => {
  const matches = text.match(/https?:\/\/\S+|t\.me\/\S+/gi) ?? []
  return matches.map((m) => ({ visible: m, target: m, hidden: false }))
}

const toInput = (event: ModEvent): EvaluationInput => {
  const text = event.messagePreview ?? ''
  return {
    message: {
      chatId: event.chatId ?? 0, messageId: 0, threadId: null,
      date: Math.floor((event.createdAt?.getTime() ?? Date.now()) / 1000),
      isEdit: false, text, urls: extractUrls(text), mentions: [],
      attachments: [], inlineButtons: [], forward: null, replyTo: null,
      channelComment: null, editDelta: null, customEmoji: [], guestBot: null
    },
    chat: { id: event.chatId ?? 0, kind: 'group', title: '', topLanguage: null },
    user: unknownUser(event.targetId ?? 0),
    policy: defaultPolicy,
    enrichment: { bio: null, resolvedMentions: [], conversationWindow: [], photoBase64: null }
  }
}

const V1_SPAM_ACTIONS = new Set(['auto_ban', 'auto_mute', 'auto_delete', 'global_ban'])
const V2_SPAM_ACTIONS = new Set<VerdictAction>(['delete', 'mute', 'ban'])

/** Confirmed-spam corpus replay: every sampleText here IS spam by definition. */
const replaySignatures = async (db: ReturnType<MongoClient['db']>): Promise<void> => {
  const docs = await db.collection('spamsignatures')
    .find(
      { sampleText: { $exists: true, $ne: '' }, status: { $ne: 'disabled' } },
      { projection: { sampleText: 1, status: 1, confirmations: 1 } }
    )
    .sort({ lastSeenAt: -1 })
    .limit(LIMIT)
    .toArray()

  if (docs.length === 0) {
    // Explain the emptiness: show what this database actually contains.
    const names = await db.listCollections().toArray()
    console.log(`No replayable spam samples. db="${db.databaseName}", collections:`)
    for (const n of names) {
      const count = await db.collection(n.name).estimatedDocumentCount()
      console.log(`  ${n.name}: ${count}`)
    }
    return
  }

  console.log(`Replaying ${docs.length} confirmed spam samples (signature port intentionally off)…\n`)

  let caught = 0
  let grey = 0
  const byDecider = new Map<string, number>()
  const missed: { preview: string; pSpam: number }[] = []

  for (const doc of docs) {
    const text = String(doc['sampleText'] ?? '')
    const input = toInput({ chatId: -1, targetId: 1, messagePreview: text, createdAt: new Date() })
    const verdict = await evaluateMessage(input, {})
    byDecider.set(verdict.decidedBy, (byDecider.get(verdict.decidedBy) ?? 0) + 1)

    if (V2_SPAM_ACTIONS.has(verdict.action)) caught += 1
    else if (verdict.action === 'observe' && verdict.pSpam >= 0.35) grey += 1
    else missed.push({ preview: text.slice(0, 80), pSpam: verdict.pSpam })
  }

  const pct = (n: number): string => ((n / Math.max(1, docs.length)) * 100).toFixed(1)
  console.log(`acted (delete/mute/ban): ${caught}/${docs.length} (${pct(caught)}%)`)
  console.log(`grey zone (would go to LLM): ${grey} (${pct(grey)}%)`)
  console.log(`missed by signals alone: ${missed.length} (${pct(missed.length)}%) — live these hit signature/vector/LLM layers`)
  console.log(`v2 decided by: ${[...byDecider.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}\n`)

  console.log('── lowest-scoring confirmed spam (hardest for the signal layer):')
  for (const m of missed.sort((a, b) => a.pSpam - b.pSpam).slice(0, 20)) {
    console.log(`  [p=${m.pSpam.toFixed(2)}] ${m.preview}`)
  }
}

const main = async (): Promise<void> => {
  const uri = process.env['MONGODB_URI']
  if (!uri) throw new Error('MONGODB_URI is required')
  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db()

  if (process.argv.includes('--signatures')) {
    await replaySignatures(db)
    await client.close()
    return
  }

  const since = new Date(Date.now() - DAYS * 86400 * 1000)
  const collection = db.collection('modevents')

  // Diagnostics first: the TTL on modevents is 7 days, and not every event
  // carries a preview — an empty replay must explain itself.
  const totalInWindow = await collection.countDocuments({ createdAt: { $gte: since } })
  const withPreview = await collection.countDocuments({
    createdAt: { $gte: since }, messagePreview: { $exists: true, $ne: '' }
  })
  console.log(`modevents in window: ${totalInWindow} total, ${withPreview} with a text preview`)
  if (totalInWindow === 0) {
    console.log('Nothing to replay: the collection has no events in this window (TTL is 7 days — is v1 running?)')
    await client.close()
    return
  }

  const events = await collection
    .find({ createdAt: { $gte: since }, messagePreview: { $exists: true, $ne: '' } })
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .toArray() as ModEvent[]

  console.log(`Replaying ${events.length} modevents from the last ${DAYS} days…\n`)

  let agree = 0
  let missesInGrey = 0 // misses that live would escalate to the LLM tier
  const v2Misses: { preview: string; v1: string }[] = []
  const v2Extra: { preview: string; v2: string }[] = []
  const byDecider = new Map<string, number>()

  for (const event of events) {
    const verdict = await evaluateMessage(toInput(event), {}) // offline: no ports
    byDecider.set(verdict.decidedBy, (byDecider.get(verdict.decidedBy) ?? 0) + 1)

    const v1Spam = V1_SPAM_ACTIONS.has(event.actionType ?? '')
    const v2Spam = V2_SPAM_ACTIONS.has(verdict.action)

    if (v1Spam === v2Spam) {
      agree += 1
    } else if (v1Spam && !v2Spam) {
      if (verdict.pSpam >= 0.35) missesInGrey += 1
      v2Misses.push({ preview: (event.messagePreview ?? '').slice(0, 80), v1: event.actionType ?? '' })
    } else {
      v2Extra.push({ preview: (event.messagePreview ?? '').slice(0, 80), v2: verdict.action })
    }
  }

  console.log(`agreement: ${agree}/${events.length} (${((agree / Math.max(1, events.length)) * 100).toFixed(1)}%)`)
  console.log(`v2 decided by: ${[...byDecider.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}\n`)

  console.log(`── v2 would NOT act where v1 did (${v2Misses.length}; ${missesInGrey} of them in the grey zone → live they go to the LLM) — expected without ports/LLM; sample:`)
  for (const miss of v2Misses.slice(0, 15)) console.log(`  [${miss.v1}] ${miss.preview}`)

  console.log(`\n── v2 would act where v1 did NOT (${v2Extra.length}) — REVIEW EACH (potential FP):`)
  for (const extra of v2Extra.slice(0, 30)) console.log(`  [${extra.v2}] ${extra.preview}`)

  await client.close()
}

main().catch((err) => {
  console.error('replay failed:', err)
  process.exit(1)
})
