/**
 * Profile enrichment with a hard call budget. Only invoked when the
 * pipeline actually needs more context (newish user + suspicion) —
 * the gateway/app layer decides; this module just executes cheaply
 * and degrades to nulls on any failure.
 */
import { Long, Photo, type TelegramClient, type tl } from '@mtcute/node'

/**
 * The channel a profile points at, as far as we can see it without joining.
 *
 * `photo` rather than base64 for the same reason as `latestAvatar`: the caller
 * decides whether the download is worth it, and nothing here issues a second
 * request for something this call already returned.
 */
export interface LinkedChannelInfo {
  id: number
  title: string
  username: string | null
  description: string | null
  subscribers: number | null
  photo: tl.RawPhoto | null
}

export interface UserProfileEnrichment {
  bio: string | null
  /**
   * Free text the account wrote about itself besides the bio.
   *
   * Only the Business INTRO qualifies. The greeting and away messages look
   * promising and are not readable: `businessGreetingMessage` carries a
   * `shortcut_id` pointing at a saved reply in the owner's own account, not the
   * text. Premium-only either way, so this is usually empty — high precision,
   * low recall.
   */
  businessTexts: string[]
  avatars: { count: number; latestSetDaysAgo: number | null } | null
  /** userFull.unofficial_security_risk — dangerous unofficial client. */
  unofficialClientRisk: boolean | null
  /** userFull.personal_channel_id — a channel linked on the profile (promo vector). */
  personalChannelId: number | null
  /**
   * What that channel turned out to be.
   *
   * Costs no username resolution: `users.getFullUser` already returns the
   * channel in its `chats` array, access hash included. That matters — a bot
   * may call `contacts.resolveUsername`, but its daily quota is small and a
   * FLOOD_WAIT there stalls the shared connection, i.e. moderation everywhere
   * (the same failure the `latestAvatar` note above records for
   * photos.getUserPhotos). The description costs one extra call.
   */
  linkedChannel: LinkedChannelInfo | null
  /**
   * Telegram's own count of chats shared with the bot (`userFull.common_chats_count`).
   * Telemetry for now — see `AccountTelemetry` in core.
   */
  commonChatsCount: number | null
  /**
   * What layer 228 puts in `userFull.settings` about the account itself:
   * registration month, phone country, the dates of the last name and photo
   * change. Clients show the first two on a stranger's profile; whether a bot
   * is handed them is what recording them will tell. Null when absent.
   */
  peerFacts: {
    registrationMonth: string | null
    phoneCountry: string | null
    nameChangeUnix: number | null
    photoChangeUnix: number | null
  } | null
  /**
   * The newest avatar, already fetched by the photos.getUserPhotos call below.
   *
   * Handing it back matters: the caller used to follow this function with
   * `downloadAvatarBase64`, which issued a SECOND photos.getUserPhotos for the
   * same user while evaluating one message. Production logs showed the
   * predictable result — recurring `photos.getUserPhotos resulted in a flood
   * wait`, which then stalled moderation for everyone.
   */
  latestAvatar: tl.RawPhoto | null
}

export const fetchUserProfile = async (
  tg: TelegramClient,
  userId: number,
  nowUnix = Math.floor(Date.now() / 1000)
): Promise<UserProfileEnrichment> => {
  const result: UserProfileEnrichment = {
    bio: null, businessTexts: [], avatars: null, unofficialClientRisk: null,
    personalChannelId: null, linkedChannel: null, latestAvatar: null,
    commonChatsCount: null, peerFacts: null
  }

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

  // Call 1: users.getFullUser — bio, unofficial-client risk, and whatever the
  // profile points at. The response carries the linked channel in `chats`, so
  // reading it costs nothing beyond a call we already make.
  try {
    const full = await tg.call({ _: 'users.getFullUser', id: inputUser })
    result.bio = full.fullUser.about ?? null
    result.unofficialClientRisk = full.fullUser.unofficialSecurityRisk ?? false
    result.personalChannelId = full.fullUser.personalChannelId ?? null
    result.commonChatsCount = full.fullUser.commonChatsCount ?? null
    const settings = full.fullUser.settings
    result.peerFacts = {
      registrationMonth: settings.registrationMonth ?? null,
      phoneCountry: settings.phoneCountry ?? null,
      nameChangeUnix: settings.nameChangeDate ?? null,
      photoChangeUnix: settings.photoChangeDate ?? null
    }

    const intro = full.fullUser.businessIntro
    if (intro) {
      result.businessTexts = [intro.title, intro.description].filter((t): t is string => !!t)
    }

    if (result.personalChannelId !== null) {
      const channel = full.chats.find(
        (c): c is tl.RawChannel => c._ === 'channel' && c.id === result.personalChannelId)
      if (channel) {
        result.linkedChannel = {
          id: channel.id,
          title: channel.title,
          username: channel.username ?? null,
          // Filled by the call below; the title alone is already worth having.
          description: null,
          subscribers: null,
          photo: null
        }
        // Call 1b: the channel's own description and size. One extra request,
        // and only for the minority of senders that link a channel at all.
        try {
          const chFull = await tg.call({
            _: 'channels.getFullChannel',
            channel: { _: 'inputChannel', channelId: channel.id, accessHash: channel.accessHash ?? Long.ZERO }
          })
          if (chFull.fullChat._ === 'channelFull') {
            result.linkedChannel.description = chFull.fullChat.about || null
            result.linkedChannel.subscribers = chFull.fullChat.participantsCount ?? null
            const photo = chFull.fullChat.chatPhoto
            result.linkedChannel.photo = photo?._ === 'photo' ? photo : null
          }
        } catch { /* description is a bonus — the title alone still reads */ }
      }
    }
  } catch { /* budget item failed — keep going */ }

  // Call 2: avatar history with dates (photos.getUserPhotos)
  try {
    const photos = await tg.call({
      _: 'photos.getUserPhotos', userId: inputUser, offset: 0, maxId: Long.ZERO, limit: 10
    })
    const real = photos.photos.filter((p): p is tl.RawPhoto => p._ === 'photo')
    const dates = real.map((p) => p.date)
    const latest = dates.length > 0 ? Math.max(...dates) : null
    result.avatars = {
      count: photos._ === 'photos.photosSlice' ? photos.count : photos.photos.length,
      latestSetDaysAgo: latest !== null ? Math.max(0, (nowUnix - latest) / 86400) : null
    }
    // photos.getUserPhotos returns newest-first; keep it so NSFW screening does
    // not have to ask Telegram for the same list again.
    result.latestAvatar = real[0] ?? null
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

/**
 * The slice of an mtcute media object that decides which picture to fetch.
 * Structural on purpose: the choice is pure and testable without a client.
 */
export interface ImageSourceMedia {
  type: string
  mimeType?: string
  sourceType?: string
  fileSize?: number | null
  thumbnails?: ReadonlyArray<{ type: string; isVideo: boolean; width: number; height: number }>
}

/** Thumbnail kinds that are not a picture a vision model can read: a ~100 px
 * blurred strip and a vector outline. */
const UNUSABLE_THUMB_TYPES = new Set(['i', 'j'])

/**
 * Which file to download for "what does this message show", or null when the
 * kind carries no still image.
 *
 * Production 2026-10-31: an account posted an explicit advert sticker every few
 * minutes and was never looked at, because only `photo` reached vision and
 * moderation. A static sticker is itself a webp, so it is fetched whole; an
 * animated (tgs) or video (webm) sticker, a GIF/animation and a video are not
 * images at all, so the largest still thumbnail stands in for the first frame.
 * Video-type thumbnails (mp4 previews) are skipped for the same reason.
 */
export const pickMessageImage = (
  media: ImageSourceMedia | null | undefined,
  maxBytes: number
): { kind: 'file' } | { kind: 'thumbnail'; index: number } | null => {
  if (!media) return null
  if (media.type === 'photo') return { kind: 'file' }
  if (media.type !== 'sticker' && media.type !== 'video') return null

  const isStaticImage = media.type === 'sticker' &&
    (media.sourceType === undefined || media.sourceType === 'static') &&
    media.mimeType === 'image/webp'
  // An unknown size is allowed through; the post-download check still caps it.
  if (isStaticImage && !(typeof media.fileSize === 'number' && media.fileSize > maxBytes)) {
    return { kind: 'file' }
  }

  const thumbs = media.thumbnails ?? []
  let best = -1
  let bestArea = -1
  thumbs.forEach((t, index) => {
    if (t.isVideo || UNUSABLE_THUMB_TYPES.has(t.type)) return
    const area = Number.isFinite(t.width) && Number.isFinite(t.height) ? t.width * t.height : 0
    if (area > bestArea) {
      best = index
      bestArea = area
    }
  })
  return best >= 0 ? { kind: 'thumbnail', index: best } : null
}

/**
 * Base64 of the first still image a message shows — photo, static sticker, or
 * the thumbnail of an animated sticker / GIF / video — or null.
 *
 * Null on every failure (no usable image, too large, download error) and never
 * a throw: this feeds the moderation path, where a missing picture must mean
 * "no answer" and not a failed message. Bytes may be jpeg or webp; the ports
 * sniff the real format when they label the data URL.
 */
export const downloadMessageImageBase64 = async (
  tg: Pick<TelegramClient, 'downloadAsBuffer'>,
  /** Any message media; kinds that are not downloadable files are rejected by
   * `pickMessageImage` before anything is fetched. */
  media: unknown,
  maxBytes = 2 * 1024 * 1024
): Promise<string | null> => (await downloadMessageImage(tg, media, maxBytes))?.base64 ?? null

/**
 * The same download, saying which picture it was: `photo:file`,
 * `sticker:file`, `sticker:thumb:128x128`, `video:thumb:320x180`.
 *
 * Recorded with the verdict because a stand-in is not the thing itself
 * (2026-10-31): a vision model handed a 128 px thumbnail of an animated
 * sticker cannot read the words on it, and without this the row could not say
 * whether a weak answer came from the model or from the picture it was given.
 */
export const downloadMessageImage = async (
  tg: Pick<TelegramClient, 'downloadAsBuffer'>,
  media: unknown,
  maxBytes = 2 * 1024 * 1024
): Promise<{ base64: string; source: string } | null> => {
  try {
    if (!media) return null
    const shape = media as ImageSourceMedia
    const pick = pickMessageImage(shape, maxBytes)
    if (pick === null) return null
    const thumb = pick.kind === 'thumbnail' ? shape.thumbnails?.[pick.index] : undefined
    const location = pick.kind === 'file'
      ? (media as Parameters<TelegramClient['downloadAsBuffer']>[0])
      : (thumb as unknown as Parameters<TelegramClient['downloadAsBuffer']>[0])
    const buffer = await tg.downloadAsBuffer(location)
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null
    const source = thumb ? `${shape.type}:thumb:${thumb.width}x${thumb.height}` : `${shape.type}:file`
    return { base64: Buffer.from(buffer).toString('base64'), source }
  } catch {
    return null
  }
}

/** Wrap a raw TL photo into a downloadable Photo and return it as base64. */
export const rawPhotoToBase64 = async (
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
/**
 * Whether the account wears a picture right now — and nothing more.
 *
 * One `users.getUsers`, which carries the picture as a flag on the user object.
 * Deliberately not `photos.getUserPhotos`: that is the call whose flood waits
 * have stalled moderation here before, and a look that mostly answers "still
 * none" has no business spending it. Null is "no answer", kept apart from
 * `false` because the caller counts both.
 */
export const userHasProfilePhoto = async (
  tg: TelegramClient,
  userId: number
): Promise<boolean | null> => {
  try {
    const peer = await tg.resolvePeer(userId)
    if (peer._ !== 'inputPeerUser') return null
    const users = await tg.call({
      _: 'users.getUsers',
      id: [{ _: 'inputUser', userId: peer.userId, accessHash: peer.accessHash }]
    })
    const user = users[0]
    if (user?._ !== 'user') return null
    return user.photo?._ === 'userProfilePhoto'
  } catch {
    return null
  }
}

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
