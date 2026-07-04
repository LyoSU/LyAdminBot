/**
 * Rolling per-chat conversation window for LLM context. Memory-only by
 * design: losing it on restart costs a few minutes of context, nothing
 * more, and it never needs a database round-trip on the hot path.
 *
 * Lines carry a record timestamp (internal, never exposed): a "recent
 * conversation" that is hours old is not a conversation — snapshot()
 * drops stale lines so a dead chat does not feed the LLM week-old
 * context as if it were live.
 */
import type { ConversationLine } from '@lyadmin/core'

const DEFAULT_WINDOW = 12
const DEFAULT_MAX_CHATS = 500
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6h — older lines are stale context
const PREVIEW_LIMIT = 120

interface StoredLine {
  line: ConversationLine
  recordedAt: number
}

export class MemoryConversationWindow {
  private readonly chats = new Map<number, StoredLine[]>()

  constructor(
    private readonly windowSize = DEFAULT_WINDOW,
    private readonly maxChats = DEFAULT_MAX_CHATS,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS
  ) {}

  record(chatId: number, line: ConversationLine): void {
    const preview = (line.textPreview ?? '').trim().slice(0, PREVIEW_LIMIT)
    if (preview.length === 0) return

    let lines = this.chats.get(chatId)
    if (!lines) {
      // Map iteration order is insertion order — the first key is the
      // longest-untouched chat, evict it when over budget.
      if (this.chats.size >= this.maxChats) {
        const oldest = this.chats.keys().next().value
        if (oldest !== undefined) this.chats.delete(oldest)
      }
      lines = []
    } else {
      this.chats.delete(chatId) // re-insert to refresh recency
    }

    lines.push({
      line: { authorId: line.authorId, authorKind: line.authorKind, textPreview: preview },
      recordedAt: Date.now()
    })
    if (lines.length > this.windowSize) lines.shift()
    this.chats.set(chatId, lines)
  }

  snapshot(chatId: number): ConversationLine[] {
    const cutoff = Date.now() - this.maxAgeMs
    return (this.chats.get(chatId) ?? [])
      .filter((s) => s.recordedAt >= cutoff)
      .map((s) => ({ ...s.line }))
  }
}
