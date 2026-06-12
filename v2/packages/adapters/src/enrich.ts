/**
 * Profile enrichment with a hard call budget. Only invoked when the
 * pipeline actually needs more context (newish user + suspicion) —
 * the gateway/app layer decides; this module just executes cheaply
 * and degrades to nulls on any failure.
 */
import { Long, type TelegramClient, type tl } from '@mtcute/node'

export interface UserProfileEnrichment {
  bio: string | null
  avatars: { count: number; latestSetDaysAgo: number | null } | null
  /** userFull.unofficial_security_risk — dangerous unofficial client. */
  unofficialClientRisk: boolean | null
}

export const fetchUserProfile = async (
  tg: TelegramClient,
  userId: number,
  nowUnix = Math.floor(Date.now() / 1000)
): Promise<UserProfileEnrichment> => {
  const result: UserProfileEnrichment = { bio: null, avatars: null, unofficialClientRisk: null }

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
