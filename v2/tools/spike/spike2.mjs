import { TelegramClient } from '@mtcute/node'

const tg = new TelegramClient({
  apiId: Number(process.env.API_ID),
  apiHash: process.env.API_HASH,
  storage: '.spike-session',
  disableUpdates: true
})

const out = (n, d) => console.log(`${n}: ${d}`)

try {
  const self = await tg.start({ botToken: process.env.BOT_TOKEN })
  out('login', `@${self.username}`)

  // resolveUsername works for any public peer; channels prove it too
  const ch = await tg.resolvePeer('durov')
  out('resolveUsername(channel)', `OK kind=${ch._}`)

  // user-kind target: the old prod bot is a TL user
  const target = await tg.resolvePeer('LyAdminBot')
  out('resolveUsername(user)', `OK kind=${target._}`)

  const [u] = await tg.call({ _: 'users.getUsers', id: [{ _: 'inputUser', userId: target.userId, accessHash: target.accessHash }] })
  out('user flags', `scam=${!!u.scam} fake=${!!u.fake} restricted=${!!u.restricted} verified=${!!u.verified} bot=${!!u.bot}`)

  const full = await tg.call({ _: 'users.getFullUser', id: { _: 'inputUser', userId: target.userId, accessHash: target.accessHash } })
  out('getFullUser', `about len=${(full.fullUser.about || '').length}`)

  const photos = await tg.call({ _: 'photos.getUserPhotos', userId: { _: 'inputUser', userId: target.userId, accessHash: target.accessHash }, offset: 0, maxId: 0n, limit: 5 })
  const dates = photos.photos.map(p => p.date ? new Date(p.date * 1000).toISOString().slice(0, 10) : '?')
  out('getUserPhotos', `${photos.photos.length} photos, dates: ${dates.join(', ') || 'none'}`)

  try {
    await tg.call({ _: 'stories.getPeerStories', peer: { _: 'inputPeerUser', userId: target.userId, accessHash: target.accessHash } })
    out('stories (expect fail)', 'unexpectedly allowed')
  } catch (e) {
    out('stories (expect fail)', e.text || e.message)
  }
} finally {
  await tg.destroy().catch(() => {})
}
