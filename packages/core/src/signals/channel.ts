/**
 * Signals from whatever a link leads to.
 *
 * Two different claims come out of the same lookup, and keeping them apart is
 * the whole point of this module.
 *
 * A channel the sender's PROFILE points at — the personal-channel field, or a
 * `t.me/…` in the bio — is shape, never message evidence. It says the account
 * is a promo vehicle; it does not say this sentence is an advert, and the
 * difference is the one this pipeline has been burned on repeatedly. Its job is
 * to make sure somebody READS the message, not to convict it.
 *
 * A channel THIS MESSAGE links to is a different statement. The sender chose to
 * put it here, so where it goes is part of what the message is doing, and an
 * advert on the other end is evidence about the message in the ordinary way.
 * It cuts both ways, which is the reason to look at all: until 2026-08-01 a
 * private invite could only be judged by its shape, and an ordinary community
 * behind the link looked exactly like a storefront.
 */
import type { ChannelPreview, Signal } from '../types.js'
import { extractBioSignals } from './bio.js'

/** Where the channel came from, for the evidence line. */
const label = (source: ChannelPreview['source']): string =>
  source === 'personal_channel' ? 'linked channel'
    : source === 'bio_link' ? 'channel from bio'
      : 'link in message'

/** A channel's own blurb is self-description, and reads like a bio. */
const promoEvidence = (channel: ChannelPreview): string | null => {
  const promo = extractBioSignals(channel.title, [channel.description ?? ''])
  if (promo.length === 0) return null
  return `${label(channel.source)} «${channel.title}»: ${promo[0]?.evidence ?? ''}`.slice(0, 120)
}

export const extractLinkedChannelSignals = (
  channels: readonly ChannelPreview[]
): Signal[] => {
  const signals: Signal[] = []
  // At most one of each: a profile advertised in two channels is still one
  // profile, and a message carrying two adverts is still one message.
  let profileDone = false
  let messageDone = false
  for (const channel of channels) {
    const fromMessage = channel.source === 'message_link'
    if (fromMessage ? messageDone : profileDone) continue
    const evidence = promoEvidence(channel)
    if (evidence === null) continue
    if (fromMessage) {
      messageDone = true
      signals.push({ name: 'promo_in_message_link', evidence })
    } else {
      profileDone = true
      signals.push({ name: 'promo_in_linked_channel', evidence })
    }
  }
  return signals
}
