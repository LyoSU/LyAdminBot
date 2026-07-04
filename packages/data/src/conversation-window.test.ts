import { describe, expect, it, vi, afterEach } from 'vitest'
import { MemoryConversationWindow } from './conversation-window.js'

afterEach(() => { vi.useRealTimers() })

describe('MemoryConversationWindow', () => {
  it('returns the preceding lines in order, capped at the window size', () => {
    const win = new MemoryConversationWindow(3)
    for (let i = 1; i <= 5; i++) {
      win.record(-100, { authorId: 1, authorKind: 'user', textPreview: `msg ${i}` })
    }
    expect(win.snapshot(-100).map((l) => l.textPreview)).toEqual(['msg 3', 'msg 4', 'msg 5'])
  })

  it('preserves authorId so the LLM prompt can distinguish authors', () => {
    const win = new MemoryConversationWindow()
    win.record(-1, { authorId: 111, authorKind: 'user', textPreview: 'a' })
    win.record(-1, { authorId: null, authorKind: 'channel_post', textPreview: 'b' })
    expect(win.snapshot(-1).map((l) => l.authorId)).toEqual([111, null])
  })

  it('keeps chats isolated and unknown chats empty', () => {
    const win = new MemoryConversationWindow()
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'a' })
    expect(win.snapshot(-2)).toEqual([])
    expect(win.snapshot(-1)).toHaveLength(1)
  })

  it('truncates previews to 120 chars and skips empty text', () => {
    const win = new MemoryConversationWindow()
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'x'.repeat(500) })
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: '   ' })
    const lines = win.snapshot(-1)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.textPreview).toHaveLength(120)
  })

  it('evicts the oldest chat when too many chats are tracked', () => {
    const win = new MemoryConversationWindow(12, 2)
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'one' })
    win.record(-2, { authorId: 1, authorKind: 'user', textPreview: 'two' })
    win.record(-3, { authorId: 1, authorKind: 'user', textPreview: 'three' })
    expect(win.snapshot(-1)).toEqual([])
    expect(win.snapshot(-3)).toHaveLength(1)
  })

  it('snapshot returns a copy — later records do not mutate it', () => {
    const win = new MemoryConversationWindow()
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'a' })
    const snap = win.snapshot(-1)
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'b' })
    expect(snap).toHaveLength(1)
  })

  it('drops lines older than the staleness window — a dead chat is not "recent"', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T10:00:00Z'))
    const win = new MemoryConversationWindow(12, 500, 60 * 60 * 1000) // 1h window
    win.record(-1, { authorId: 1, authorKind: 'user', textPreview: 'old' })
    vi.setSystemTime(new Date('2026-07-04T11:30:00Z')) // +90m
    win.record(-1, { authorId: 2, authorKind: 'user', textPreview: 'fresh' })
    const lines = win.snapshot(-1)
    expect(lines.map((l) => l.textPreview)).toEqual(['fresh'])
  })
})
