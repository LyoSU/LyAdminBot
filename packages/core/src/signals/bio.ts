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
 * a website link), and it is now measured rather than asserted — see the weights
 * in `registry.ts`. None of these is ever a deterministic action; all three are
 * shape, so they only matter stacked with newness in the score.
 */
import type { Signal } from '../types.js'
import { truncate } from '../text/normalize.js'
import { classifyUrl, URL_TOKEN_REGEX, PROMO_URL_KINDS } from './urls.js'
import { PHONE_REGEX, CASHTAG_REGEX } from './message.js'

/**
 * Every signal `extractBioSignals` can raise, as one exported set.
 *
 * Readers outside this file ask "does the profile advertise anything?", and
 * before the 2026-08-25 split there was exactly one name to compare against, so
 * two of them compared against a literal. Splitting a signal must not silently
 * narrow what those readers see — so the answer lives here, beside the raiser,
 * and a fourth branch added later reaches them without being remembered.
 */
export const BIO_PROMO_SIGNALS: ReadonlySet<Signal['name']> = new Set([
  'promo_in_bio', 'private_invite_in_bio', 'contact_in_bio'
])

/** What a self-description advertises, named by the signal it raises. */
interface BioPromo {
  name: Signal['name']
  /** The token to quote back, or a word for the class when there is no token. */
  what: string
}

/**
 * What in a self-description reads as advertising, or null if nothing does.
 *
 * The three answers are not interchangeable, which is the whole point of
 * returning a name rather than a boolean. `classifyUrl` has always known
 * whether a link is a private invite; until 2026-08-25 this function collapsed
 * that into "a URL is present" and the difference — 62.5% known-bad against
 * 22.1% for an ordinary website — was thrown away one line after being
 * computed.
 */
const promoIn = (text: string): BioPromo | null => {
  const urls = (text.match(URL_TOKEN_REGEX) ?? [])
    .map((token) => ({ token, kind: classifyUrl(token).kind }))

  // Strongest reading of the profile wins: a bio holding both an invite and a
  // website is advertising the invite, whichever was typed first.
  const invite = urls.find((u) => u.kind === 'private_invite')
  if (invite) return { name: 'private_invite_in_bio', what: invite.token }

  const promoUrl = urls.find((u) => PROMO_URL_KINDS.has(u.kind))
  if (promoUrl) return { name: 'promo_in_bio', what: promoUrl.token }

  if (PHONE_REGEX.test(text)) return { name: 'contact_in_bio', what: 'phone number' }
  if (CASHTAG_REGEX.test(text)) return { name: 'contact_in_bio', what: 'cashtag' }
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
    if (found) return [{ name: found.name, evidence: truncate(`${source}: ${found.what}`, 80) }]
  }
  return []
}
