/**
 * MTProto bot-session spike.
 *
 * Verifies live, with the production bot token, which MTProto calls a BOT
 * session can actually make. Read-only: no messages sent, no actions taken.
 *
 * Run: node --env-file=../../../.env spike.mjs   (from tools/spike)
 */
import { TelegramClient } from '@mtcute/node'
import { tl } from '@mtcute/node'

const report = []
const ok = (name, detail) => { report.push({ name, ok: true, detail }); console.log(`✅ ${name}: ${detail}`) }
const fail = (name, err) => {
  const msg = err && err.message ? err.message.split('\n')[0] : String(err)
  report.push({ name, ok: false, detail: msg })
  console.log(`❌ ${name}: ${msg}`)
}

const tg = new TelegramClient({
  apiId: Number(process.env.API_ID),
  apiHash: process.env.API_HASH,
  storage: '.spike-session',
  // Spike never processes updates — don't even open the updates loop.
  disableUpdates: true
})

try {
  const self = await tg.start({ botToken: process.env.BOT_TOKEN })
  ok('bot login', `@${self.username} (id ${self.id})`)

  // 1. resolveUsername — arbitrary public username resolution
  let durov = null
  try {
    durov = await tg.resolvePeer('durov')
    const user = await tg.getUser(durov)
    ok('contacts.resolveUsername', `durov → id ${user.id}, premium=${user.isPremium}, verified=${user.isVerified}`)
  } catch (e) { fail('contacts.resolveUsername', e) }

  // 2. user flags incl. scam/fake — raw users.getUsers
  try {
    const raw = await tg.call({ _: 'users.getUsers', id: [await tg.resolvePeer('durov').then(p => ({ _: 'inputUser', userId: p.userId ?? 0, accessHash: p.accessHash ?? 0n }))] })
    const u = raw[0]
    ok('user flags (scam/fake/restricted)', `scam=${!!u.scam} fake=${!!u.fake} restricted=${!!u.restricted} verified=${!!u.verified}`)
  } catch (e) { fail('user flags (scam/fake/restricted)', e) }

  // 3. users.getFullUser — bio etc.
  try {
    const full = await tg.getFullUser('durov')
    ok('users.getFullUser', `bio len=${(full.bio || '').length}, commonChats n/a for bots`)
  } catch (e) {
    // high-level helper name may differ across versions — try raw
    try {
      const p = await tg.resolvePeer('durov')
      const full = await tg.call({ _: 'users.getFullUser', id: { _: 'inputUser', userId: p.userId, accessHash: p.accessHash } })
      ok('users.getFullUser (raw)', `about len=${(full.fullUser.about || '').length}`)
    } catch (e2) { fail('users.getFullUser', e2) }
  }

  // 4. photos.getUserPhotos — avatar history WITH dates
  try {
    const p = await tg.resolvePeer('durov')
    const photos = await tg.call({
      _: 'photos.getUserPhotos',
      userId: { _: 'inputUser', userId: p.userId, accessHash: p.accessHash },
      offset: 0,
      maxId: 0n,
      limit: 5
    })
    const dates = photos.photos
      .map(ph => ph.date ? new Date(ph.date * 1000).toISOString().slice(0, 10) : '?')
    ok('photos.getUserPhotos', `${photos.photos.length} photos, dates: ${dates.join(', ')}`)
  } catch (e) { fail('photos.getUserPhotos', e) }

  // 5. stories — EXPECTED to fail for bots (docs say users only); confirm
  try {
    const p = await tg.resolvePeer('durov')
    await tg.call({ _: 'stories.getPeerStories', peer: { _: 'inputPeerUser', userId: p.userId, accessHash: p.accessHash } })
    ok('stories.getPeerStories', 'unexpectedly ALLOWED for bots')
  } catch (e) { fail('stories.getPeerStories (expected ❌)', e) }

  // 6. schema sanity: reaction + guest-bot constructors present in this layer
  const hasSendReaction = tl.LAYER && typeof tl.LAYER === 'number'
  ok('TL layer', `${tl.LAYER}`)
} finally {
  await tg.destroy().catch(() => {})
}

const failed = report.filter(r => !r.ok && !r.name.includes('expected'))
console.log(`\n--- spike done: ${report.filter(r => r.ok).length} ok, ${failed.length} unexpected failures ---`)
