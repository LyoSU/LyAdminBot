/**
 * SHADOW, 2026-10-15: accounts that posted the same text as an account we then
 * confirmed as a spammer, in the same chat, within a day.
 *
 * Measured over the 14 days to 2026-10-14: farms post one harmless line (a
 * copied headline, a greeting) from several new accounts in one chat. Each copy
 * is deleted on its own — a content match capped to a delete because the text
 * is imitable — and nothing ever links the accounts, so every one of them stays
 * in the chat. The rule below kept later clean writers at 0 over that fortnight:
 *
 *   - the text, folded (NFKC, lower case, letters and digits only), is at least
 *     30 characters, so a stock phrase cannot form a cluster;
 *   - at least 3 distinct authors posted it in the same chat within 24 hours;
 *   - none of them is an established regular;
 *   - one of them has just been STRONGLY confirmed (ban, kick, mute, a spam
 *     ballot or an admin's spam report, an external listing). A delete of the
 *     copy is not a confirmation: it is the very act that the copy alone earns.
 *
 * It would have newly reached 48 accounts, 0 of which later wrote clean and 0
 * of whose removals were reversed. The 6-hour velocity window saw 15 of them —
 * the reason this keeps its own 24-hour membership.
 *
 * Nobody is removed: the siblings get a `pipeline_decisions` row with
 * `action: 'none'` and the reason `copied_with_spammer_shadow`, and a log line.
 */
import { createHash } from 'node:crypto'

/** Folded length below which a text never forms a cluster. */
export const COPY_CLUSTER_MIN_CHARS = 30
/** Distinct authors, the confirmed one included, that make a cluster. */
export const COPY_CLUSTER_MIN_AUTHORS = 3
/** How long a copy keeps its author in the cluster. Also the store's TTL. */
export const COPY_CLUSTER_WINDOW_MS = 24 * 3600_000

/**
 * The text as the rule compares it: compatibility-folded, lower case, and with
 * everything but letters and digits removed — so spacing, punctuation, emoji
 * and full-width tricks do not split one copy into several.
 */
export const foldCopyText = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The cluster key of a text, or null when it is too short to cluster.
 *
 * 16 hex characters of SHA-256: a collision inside one chat and one day is
 * out of reach, and the key is a quarter of the full digest in a collection
 * kept small on purpose.
 */
export const copyClusterKey = (text: string): string | null => {
  const folded = foldCopyText(text)
  if ([...folded].length < COPY_CLUSTER_MIN_CHARS) return null
  return createHash('sha256').update(folded).digest('hex').slice(0, 16)
}

/** One author's copy of one text in one chat, as the store keeps it. */
export interface CopyMember {
  hash: string
  userId: number
  at: Date
  /**
   * An established regular posted this text while the row was alive. Taints
   * the whole cluster: a line a regular also wrote is the chat's, not a farm's.
   */
  regular?: boolean
}

export interface CopySiblings {
  hash: string
  /** Distinct authors in the cluster, the confirmed one included. */
  size: number
  /** The accounts a confirmation would reach — never the confirmed one. */
  siblings: number[]
}

/**
 * The clusters `confirmedUserId` belongs to and whom each would carry.
 *
 * `members` are the rows of every hash the confirmed account posted (the
 * store's two reads). Rows older than the window are dropped here as well as by
 * the TTL, since Mongo sweeps on its own schedule. A cluster qualifies only with
 * the confirmed account in it, at least `COPY_CLUSTER_MIN_AUTHORS` distinct
 * authors, and no regular among them. One account in several clusters is
 * listed under each; the caller deduplicates by account.
 */
export const copySiblings = (
  members: readonly CopyMember[],
  confirmedUserId: number,
  now = Date.now()
): CopySiblings[] => {
  const floor = now - COPY_CLUSTER_WINDOW_MS
  const byHash = new Map<string, { authors: Set<number>; tainted: boolean }>()
  for (const m of members) {
    const group = byHash.get(m.hash) ?? { authors: new Set<number>(), tainted: false }
    byHash.set(m.hash, group)
    if (m.regular === true) {
      group.tainted = true
      continue
    }
    if (m.at.getTime() < floor || m.at.getTime() > now + 60_000) continue
    group.authors.add(m.userId)
  }
  const out: CopySiblings[] = []
  for (const [hash, { authors, tainted }] of byHash) {
    if (tainted || !authors.has(confirmedUserId)) continue
    if (authors.size < COPY_CLUSTER_MIN_AUTHORS) continue
    const siblings = [...authors].filter((u) => u !== confirmedUserId).sort((a, b) => a - b)
    out.push({ hash, size: authors.size, siblings })
  }
  return out.sort((a, b) => b.size - a.size || (a.hash < b.hash ? -1 : 1))
}

/**
 * What counts as a strong confirmation on the message path: an applied ban,
 * kick or mute that is not waiting on a ballot. The ballot, if it closes as
 * spam, confirms through `enforceVoteSpam` instead.
 */
export const isCopyClusterTrigger = (act: {
  action: string; applied: boolean; needsVote: boolean
}): boolean =>
  act.applied && !act.needsVote && (act.action === 'ban' || act.action === 'kick' || act.action === 'mute')
