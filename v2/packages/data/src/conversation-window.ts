/**
 * Rolling per-chat conversation window for LLM context. Memory-only by
 * design: losing it on restart costs a few minutes of context, nothing
 * more, and it never needs a database round-trip on the hot path.
 */
import type { ConversationLine } from '@lyadmin/core'

const DEFAULT_WINDOW = 12
const DEFAULT_MAX_CHATS = 500
const PREVIEW_LIMIT = 120

export class MemoryConversationWindow {
  private readonly chats = new Map<number, ConversationLine[]>()

  constructor(
    private readonly windowSize = DEFAULT_WINDOW,
    private readonly maxChats = DEFAULT_MAX_CHATS
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

    lines.push({ authorKind: line.authorKind, textPreview: preview })
    if (lines.length > this.windowSize) lines.shift()
    this.chats.set(chatId, lines)
  }

  snapshot(chatId: number): ConversationLine[] {
    return (this.chats.get(chatId) ?? []).map((l) => ({ ...l }))
  }
}
