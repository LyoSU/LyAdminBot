/**
 * Bio (userFull.about) signal extraction. Pure function over the bio string.
 *
 * Spammers hide contact/promo in the bio because the bio is never moderated,
 * only messages are. So a brand-new account with a neutral message but a promo
 * link/contact in the bio is a classic pattern. This is the cheap, deterministic
 * counterpart to feeding the bio to the LLM.
 *
 * Calibration note: bio analysis has a confirmed v1 FP class (innocent bios with
 * a website link). So `promo_in_bio` is a LOW-weight scoring signal, never a
 * deterministic action — it only matters stacked with newness in the score.
 */
import type { Signal } from '../types.js'
import { classifyUrl } from './urls.js'
import { PHONE_REGEX, CASHTAG_REGEX } from './message.js'

// URL-ish tokens in free text: scheme URLs, t.me/telegram links, or bare
// host(/path) like "yuri.ly" / "telegra.ph/x". Case-insensitive, global.
const URL_TOKEN_REGEX =
  /(?:https?:\/\/\S+|(?:t|telegram)\.me\/\S+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/\S*)?)/gi

/** Promo-bearing URL classes (a plain telegram profile/internal link is not). */
const PROMO_URL_KINDS = new Set([
  'private_invite', 'bot_deeplink', 'shortener', 'messenger_contact', 'external'
])

export const extractBioSignals = (bio: string | null | undefined): Signal[] => {
  if (!bio || bio.trim().length === 0) return []

  const tokens = bio.match(URL_TOKEN_REGEX) ?? []
  const promoUrl = tokens.find((t) => PROMO_URL_KINDS.has(classifyUrl(t).kind))
  const hasPhone = PHONE_REGEX.test(bio)
  const hasCashtag = CASHTAG_REGEX.test(bio)

  if (promoUrl || hasPhone || hasCashtag) {
    const evidence = promoUrl ?? (hasPhone ? 'phone number' : 'cashtag')
    return [{ name: 'promo_in_bio', evidence: `bio: ${evidence}`.slice(0, 80) }]
  }
  return []
}
