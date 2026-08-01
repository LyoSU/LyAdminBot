/**
 * What Telegram has recently refused us, per chat.
 *
 * Production, 2026-07-30: five of six verdicts inside one hour could not be
 * applied — four chats where the bot is not an admin, or is one without the
 * relevant right. Detection kept running at full price (LLM calls of 2-5s per
 * message) and achieved nothing in those chats.
 *
 * Design notes, because getting this wrong is worse than the waste it saves:
 *
 *  - A *failed attempt* is the only trustworthy evidence of what we may do.
 *    Asking Telegram for our own rights up front means parsing an admin-rights
 *    shape and risking the opposite mistake — silently standing down in a
 *    healthy chat, the invisible no-op this codebase has been burned by before.
 *  - Blocks are per capability. A chat where `delete` works and `ban` does not
 *    is still very much worth moderating.
 *  - Blocks expire, so rights granted later resume moderation without a restart
 *    and without anybody having to notice.
 *
 * A flat block turned out to be the wrong shape (production 2026-08-01). One
 * chat refused every action for a hundred minutes while an advert was reposted
 * on a roughly quarter-hourly cadence — just slower than the block, so each
 * repost landed a minute or two after the block lapsed and paid the full price
 * again: six enrichments, six vector searches, six moderation calls, six
 * verdicts, nothing enforced. The block has to grow while the refusal persists,
 * and collapse the moment anything succeeds.
 */

/** Telegram's ways of saying "you may not do that here". */
export const RIGHTS_ERROR_REGEX = /ADMIN_REQUIRED|FORBIDDEN|not enough rights|RIGHT/i

/** First block after a refusal. Each consecutive refusal doubles it. */
export const RIGHTS_BLOCK_MS = 15 * 60 * 1000

/**
 * Ceiling on the doubling, and therefore the longest an admin can wait after
 * granting rights before moderation resumes by itself. Two hours is the trade:
 * long enough that a chat refusing us all day costs a handful of evaluations
 * instead of a hundred, short enough that nobody files a bug about the bot
 * being asleep.
 */
export const RIGHTS_BLOCK_MAX_MS = 2 * 60 * 60 * 1000

interface RightsBlock {
  /** Expiry (ms epoch) of the refusal to delete messages; 0 = not blocked. */
  deleteUntil: number
  /** Expiry (ms epoch) of the refusal to kick/mute/ban; 0 = not blocked. */
  senderUntil: number
  /** Consecutive executions refused here. Drives the backoff and the nagging. */
  strikes: number
}

const MAX_TRACKED_CHATS = 2000

export class RightsMemory {
  private readonly blocks = new Map<number, RightsBlock>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly blockMs: number = RIGHTS_BLOCK_MS,
    private readonly maxBlockMs: number = RIGHTS_BLOCK_MAX_MS
  ) {}

  /**
   * Record what an execution proves. `errors` are the executor's
   * `${label}: ${message}` strings; only rights refusals count, and only the
   * capability that was actually refused.
   *
   * The success branch is why this is one method and not two. An execution that
   * raised no rights refusal is the only positive evidence we ever get, and a
   * backoff that can grow but never shrink would eventually stand the bot down
   * in a chat that had long since promoted it. Forgetting to call a separate
   * `noteSuccess` would fail silently and only in production, which is the
   * failure mode this file exists to avoid.
   */
  noteOutcome(chatId: number, errors: string[]): void {
    const refusals = errors.filter((e) => RIGHTS_ERROR_REGEX.test(e))
    if (refusals.length === 0) {
      // Whatever we attempted went through. Clear everything, including blocks
      // on capabilities this particular verdict never exercised: over-clearing
      // costs an evaluation we might not have needed, under-clearing costs
      // moderation nobody notices is missing.
      this.blocks.delete(chatId)
      return
    }
    const block = this.blocks.get(chatId) ?? { deleteUntil: 0, senderUntil: 0, strikes: 0 }
    // A refusal long after the last block lapsed is a new episode, not the
    // continuation of an old one. Without this, a chat that briefly demoted the
    // bot a year ago would jump straight to the ceiling on its next hiccup.
    const lapsedFor = this.now() - Math.max(block.deleteUntil, block.senderUntil)
    if (lapsedFor > this.maxBlockMs) block.strikes = 0
    block.strikes += 1
    const until = this.now() + this.backoffMs(block.strikes)
    for (const error of refusals) {
      // Everything that is not message removal acts on the sender: kick, mute,
      // ban, and the captcha's restriction.
      if (error.startsWith('delete:')) block.deleteUntil = until
      else block.senderUntil = until
    }
    this.blocks.set(chatId, block)
    this.prune()
  }

  /**
   * How many consecutive executions this chat has refused. Zero once anything
   * succeeds. Callers use it to slow down anything else that repeats per
   * refusal — notably the public "grant me rights" notice, which was posting
   * hourly and forever into chats where the bot could do nothing about it.
   */
  strikes(chatId: number): number {
    return this.blocks.get(chatId)?.strikes ?? 0
  }

  private backoffMs(strikes: number): number {
    return Math.min(this.blockMs * 2 ** Math.max(0, strikes - 1), this.maxBlockMs)
  }

  /**
   * True when BOTH removing messages and acting on senders are currently
   * refused here. Nothing a verdict could conclude is actionable in that state,
   * so the paid stages are not worth running — warning the admins is the only
   * useful output left, and it costs nothing.
   */
  cannotEnforce(chatId: number): boolean {
    const block = this.blocks.get(chatId)
    if (!block) return false
    const now = this.now()
    return block.deleteUntil > now && block.senderUntil > now
  }

  /** Chats currently refusing us something — for operational reporting. */
  blockedChats(): { chatId: number; deleteBlocked: boolean; senderBlocked: boolean }[] {
    const now = this.now()
    const out: { chatId: number; deleteBlocked: boolean; senderBlocked: boolean }[] = []
    for (const [chatId, block] of this.blocks) {
      const deleteBlocked = block.deleteUntil > now
      const senderBlocked = block.senderUntil > now
      if (deleteBlocked || senderBlocked) out.push({ chatId, deleteBlocked, senderBlocked })
    }
    return out
  }

  private prune(): void {
    if (this.blocks.size <= MAX_TRACKED_CHATS) return
    const now = this.now()
    for (const [chatId, block] of this.blocks) {
      if (block.deleteUntil <= now && block.senderUntil <= now) this.blocks.delete(chatId)
    }
  }
}
