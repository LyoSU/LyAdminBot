/**
 * Profile enrichment with a hard call budget. Only invoked when the
 * pipeline actually needs more context (newish user + suspicion) —
 * the gateway/app layer decides; this module just executes cheaply
 * and degrades to nulls on any failure.
 */
import { Long, Photo, type TelegramClient, type tl } from '@mtcute/node'

export interface UserProfileEnrichment {
  bio: string | null
  avatars: { count: number; latestSetDaysAgo: number | null } | null
  /** userFull.unofficial_security_risk — dangerous unofficial client. */
  unofficialClientRisk: boolean | null
  /** userFull.personal_channel_id — a channel linked on the profile (promo vector). */
  personalChannelId: number | null
}

export const fetchUserProfile = async (
  tg: TelegramClient,
  userId: number,
  nowUnix = Math.floor(Date.now() / 1000)
): Promise<UserProfileEnrichment> => {
  const result: UserProfileEnrichment = { bio: null, avatars: null, unofficialClientRisk: null, personalChannelId: null }

  let inputUser: tl.RawInputUser | null = null
  try {
    const peer = await tg.resolvePeer(userId)
    if (peer._ === 'inputPeerUser') {
      inputUser = { _: 'inputUser', userId: peer.userId, accessHash: peer.accessHash }
    }
  } catch {
    return result
  }
  if (!inputUser) return result

  // Call 1: users.getFullUser — bio + unofficial-client risk flag
  try {
    const full = await tg.call({ _: 'users.getFullUser', id: inputUser })
    result.bio = full.fullUser.about ?? null
    result.unofficialClientRisk = full.fullUser.unofficialSecurityRisk ?? false
    result.personalChannelId = full.fullUser.personalChannelId ?? null
  } catch { /* budget item failed — keep going */ }

  // Call 2: avatar history with dates (photos.getUserPhotos)
  try {
    const photos = await tg.call({
      _: 'photos.getUserPhotos', userId: inputUser, offset: 0, maxId: Long.ZERO, limit: 10
    })
    const dates = photos.photos
      .map((p) => (p._ === 'photo' ? p.date : null))
      .filter((d): d is number => d !== null)
    const latest = dates.length > 0 ? Math.max(...dates) : null
    result.avatars = {
      count: photos._ === 'photos.photosSlice' ? photos.count : photos.photos.length,
      latestSetDaysAgo: latest !== null ? Math.max(0, (nowUnix - latest) / 86400) : null
    }
  } catch { /* degrade silently */ }

  return result
}

/** Download the message photo as base64 for LLM vision (never a file URL —
 * v1 leaked the bot token through getFileLink URLs sent to LLM providers). */
export const downloadPhotoBase64 = async (
  tg: TelegramClient,
  media: Parameters<TelegramClient['downloadAsBuffer']>[0],
  maxBytes = 2 * 1024 * 1024
): Promise<string | null> => {
  try {
    const buffer = await tg.downloadAsBuffer(media)
    if (buffer.byteLength > maxBytes) return null
    return Buffer.from(buffer).toString('base64')
  } catch {
    return null
  }
}

/** Wrap a raw TL photo into a downloadable Photo and return it as base64. */
const rawPhotoToBase64 = async (
  tg: TelegramClient,
  raw: tl.RawPhoto,
  maxBytes: number
): Promise<string | null> => {
  try {
    const buffer = await tg.downloadAsBuffer(new Photo(raw))
    if (buffer.byteLength > maxBytes) return null
    return Buffer.from(buffer).toString('base64')
  } catch {
    return null
  }
}

/**
 * Download the sender's current (newest) avatar as base64 for NSFW
 * moderation. Bot-accessible: photos.getUserPhotos + file download both work
 * for bots. Degrades to null on any failure or oversized image.
 */
export const downloadAvatarBase64 = async (
  tg: TelegramClient,
  userId: number,
  maxBytes = 2 * 1024 * 1024
): Promise<string | null> => {
  let inputUser: tl.RawInputUser | null = null
  try {
    const peer = await tg.resolvePeer(userId)
    if (peer._ === 'inputPeerUser') {
      inputUser = { _: 'inputUser', userId: peer.userId, accessHash: peer.accessHash }
    }
  } catch {
    return null
  }
  if (!inputUser) return null

  try {
    const photos = await tg.call({
      _: 'photos.getUserPhotos', userId: inputUser, offset: 0, maxId: Long.ZERO, limit: 1
    })
    const latest = photos.photos.find((p): p is tl.RawPhoto => p._ === 'photo')
    if (!latest) return null
    return await rawPhotoToBase64(tg, latest, maxBytes)
  } catch {
    return null
  }
}

/**
 * Download up to `max` of the sender's active stories as base64 for NSFW
 * moderation. Best-effort: stories are a user-only MTProto surface, so on a
 * bot account stories.getPeerStories typically errors and this returns []
 * (nsfw_stories then simply never fires). Only photo stories are moderated.
 */
export const downloadStoriesBase64 = async (
  tg: TelegramClient,
  userId: number,
  max = 3,
  maxBytes = 2 * 1024 * 1024
): Promise<string[]> => {
  let inputPeer: tl.TypeInputPeer
  try {
    inputPeer = await tg.resolvePeer(userId)
  } catch {
    return []
  }

  let items: tl.TypeStoryItem[]
  try {
    const peerStories = await tg.call({ _: 'stories.getPeerStories', peer: inputPeer })
    items = peerStories.stories.stories
  } catch {
    return [] // user-only surface — expected to fail on a bot account
  }

  const out: string[] = []
  for (const item of items) {
    if (out.length >= max) break
    if (item._ !== 'storyItem') continue
    if (item.media._ !== 'messageMediaPhoto') continue
    const photo = item.media.photo
    if (!photo || photo._ !== 'photo') continue
    const base64 = await rawPhotoToBase64(tg, photo, maxBytes)
    if (base64) out.push(base64)
  }
  return out
}
