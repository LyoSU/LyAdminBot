/**
 * Signals from what an account says about ITSELF — the bio (userFull.about) and
 * the Telegram Business texts beside it. Pure functions over strings.
 *
 * Spammers hide contact/promo there because none of it is ever moderated, only
 * messages are. So a brand-new account with a neutral message but a promo
 * link/contact in the profile is a classic pattern. This is the cheap,
 * deterministic counterpart to feeding the profile to the LLM.
 *
 * Calibration note: bio analysis has a confirmed v1 FP class (innocent bios with
 * a website link). So `promo_in_bio` is a LOW-weight scoring signal, never a
 * deterministic action — it only matters stacked with newness in the score.
 */
import type { Signal } from '../types.js'
import { truncate } from '../text/normalize.js'
import { classifyUrl, URL_TOKEN_REGEX, PROMO_URL_KINDS } from './urls.js'
import { PHONE_REGEX, CASHTAG_REGEX } from './message.js'

/** What in a self-description reads as advertising, or null if nothing does. */
const promoIn = (text: string): string | null => {
  const promoUrl = (text.match(URL_TOKEN_REGEX) ?? [])
    .find((t) => PROMO_URL_KINDS.has(classifyUrl(t).kind))
  if (promoUrl) return promoUrl
  if (PHONE_REGEX.test(text)) return 'phone number'
  if (CASHTAG_REGEX.test(text)) return 'cashtag'
  return null
}

/**
 * @param bio userFull.about
 * @param businessTexts Business intro / greeting / away messages. Premium-only,
 *   so usually empty — but the same kind of text, read the same way. A greeting
 *   is auto-sent to everyone who writes in, which makes it an advert with
 *   delivery.
 */
export const extractBioSignals = (
  bio: string | null | undefined,
  businessTexts: readonly string[] = []
): Signal[] => {
  const fields: { source: string; text: string }[] = [
    ...(bio && bio.trim().length > 0 ? [{ source: 'bio', text: bio }] : []),
    ...businessTexts
      .filter((text) => text.trim().length > 0)
      .map((text) => ({ source: 'business', text }))
  ]

  for (const { source, text } of fields) {
    const found = promoIn(text)
    // One profile advertised in three fields is still one profile: the first
    // hit names the signal and the rest would only double-count it.
    if (found) return [{ name: 'promo_in_bio', evidence: truncate(`${source}: ${found}`, 80) }]
  }
  return []
}
