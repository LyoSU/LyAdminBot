/**
 * Signals from whatever a sender's profile points AT.
 *
 * An account links somewhere — the profile's personal-channel field, or a
 * `t.me/…` in the bio — and the adapter resolves what is on the other end. A
 * channel whose title or description is a price list is the clearest statement
 * of purpose an account can make, and it costs the sender nothing to keep out
 * of their messages.
 *
 * Still shape, never message evidence. It says the account is a promo vehicle;
 * it does not say this sentence is an advert, and the difference is the one
 * this pipeline has been burned on repeatedly. Its job is to make sure somebody
 * READS the message, not to convict it.
 */
import type { ChannelPreview, Signal } from '../types.js'
import { extractBioSignals } from './bio.js'

/** Where the sender's channel came from, for the evidence line. */
const label = (source: ChannelPreview['source']): string =>
  source === 'personal_channel' ? 'linked channel' : 'channel from bio'

export const extractLinkedChannelSignals = (
  channels: readonly ChannelPreview[]
): Signal[] => {
  for (const channel of channels) {
    // The same reading as a bio: a channel's own blurb is self-description, and
    // what makes it promotional is what makes a bio promotional.
    const promo = extractBioSignals(channel.title, [channel.description ?? ''])
    if (promo.length > 0) {
      return [{
        name: 'promo_in_linked_channel',
        evidence: `${label(channel.source)} «${channel.title}»: ${promo[0]?.evidence ?? ''}`.slice(0, 120)
      }]
    }
  }
  return []
}
