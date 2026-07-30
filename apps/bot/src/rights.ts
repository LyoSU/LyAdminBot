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
 */

/** Telegram's ways of saying "you may not do that here". */
export const RIGHTS_ERROR_REGEX = /ADMIN_REQUIRED|FORBIDDEN|not enough rights|RIGHT/i

export const RIGHTS_BLOCK_MS = 15 * 60 * 1000

interface RightsBlock {
  /** Expiry (ms epoch) of the refusal to delete messages; 0 = not blocked. */
  deleteUntil: number
  /** Expiry (ms epoch) of the refusal to kick/mute/ban; 0 = not blocked. */
  senderUntil: number
}

const MAX_TRACKED_CHATS = 2000

export class RightsMemory {
  private readonly blocks = new Map<number, RightsBlock>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly blockMs: number = RIGHTS_BLOCK_MS
  ) {}

  /**
   * Record what a failed execution proves. `errors` are the executor's
   * `${label}: ${message}` strings; only rights refusals count, and only the
   * capability that was actually refused.
   */
  noteFailures(chatId: number, errors: string[]): void {
    const refusals = errors.filter((e) => RIGHTS_ERROR_REGEX.test(e))
    if (refusals.length === 0) return
    const until = this.now() + this.blockMs
    const block = this.blocks.get(chatId) ?? { deleteUntil: 0, senderUntil: 0 }
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
