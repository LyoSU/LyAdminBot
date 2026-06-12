/**
 * Telegram gateway: the only file that owns a live mtcute client.
 *
 * Responsibilities:
 *  - client + dispatcher lifecycle
 *  - per-chat serialization (verdicts for one chat apply in order)
 *  - album buffering (a 10-photo album is ONE message to the pipeline)
 *  - ModerationActions implementation over MTProto
 *
 * Kept deliberately thin: no business logic — that lives in core and is
 * tested offline. Integration breakage here is caught by the test group.
 */
import { TelegramClient, type Message } from '@mtcute/node'
import { Dispatcher, type CallbackQueryContext } from '@mtcute/dispatcher'
import type { ModerationActions } from './executor.js'

export interface GatewayConfig {
  apiId: number
  apiHash: string
  botToken: string
  /** SQLite session path. */
  session: string
}

export interface IncomingMessage {
  message: Message
  isEdit: boolean
  /** Other messages of the same album, when buffered. */
  albumSiblings: Message[]
}

export type MessageHandler = (incoming: IncomingMessage) => Promise<void>

const ALBUM_BUFFER_MS = 600

export class TelegramGateway {
  readonly tg: TelegramClient
  private readonly dispatcher: Dispatcher
  private readonly chatQueues = new Map<number, Promise<void>>()
  private readonly albumBuffers = new Map<string, { messages: Message[]; timer: NodeJS.Timeout }>()
  private handler: MessageHandler | null = null
  /** App-supplied error sink; defaults to console.error so adapters stay pure. */
  private errorSink: (err: unknown) => void = (err) => console.error('[gateway] handler error:', err)

  constructor(private readonly config: GatewayConfig) {
    this.tg = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: config.session
    })
    this.dispatcher = Dispatcher.for(this.tg)

    this.dispatcher.onNewMessage(async (msg: Message) => {
      this.routeMessage(msg, false)
    })
    this.dispatcher.onEditMessage(async (msg: Message) => {
      this.routeMessage(msg, true)
    })
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  /** Route handler errors somewhere structured (the app logger). */
  onError(sink: (err: unknown) => void): void {
    this.errorSink = sink
  }

  /** Expose callback-query routing without leaking the dispatcher. */
  onCallbackQuery(handler: (query: CallbackQueryContext) => Promise<void>): void {
    this.dispatcher.onCallbackQuery(handler)
  }

  /** Serialize handling per chat so actions never race within one chat. */
  private enqueue(chatId: number, task: () => Promise<void>): void {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve()
    const next = previous.then(task).catch((err) => {
      // A failed message must never wedge the whole chat queue.
      this.errorSink(err)
    })
    this.chatQueues.set(chatId, next)
    // Prevent unbounded map growth in long-running processes.
    void next.finally(() => {
      if (this.chatQueues.get(chatId) === next) this.chatQueues.delete(chatId)
    })
  }

  private routeMessage(msg: Message, isEdit: boolean): void {
    if (!this.handler) return
    const groupedId = msg.groupedId
    if (groupedId !== null && !isEdit) {
      // Buffer album parts; evaluate the album once, as a unit.
      const key = `${msg.chat.id}:${groupedId}`
      const existing = this.albumBuffers.get(key)
      if (existing) {
        existing.messages.push(msg)
        return
      }
      const timer = setTimeout(() => {
        const buffered = this.albumBuffers.get(key)
        this.albumBuffers.delete(key)
        if (!buffered) return
        const [first, ...rest] = buffered.messages
        if (!first) return
        this.enqueue(first.chat.id, () =>
          this.handler!({ message: first, isEdit: false, albumSiblings: rest }))
      }, ALBUM_BUFFER_MS)
      this.albumBuffers.set(key, { messages: [msg], timer })
      return
    }
    this.enqueue(msg.chat.id, () => this.handler!({ message: msg, isEdit, albumSiblings: [] }))
  }

  /** ModerationActions over MTProto for the executor. */
  get moderationActions(): ModerationActions {
    return {
      deleteMessage: async (chatId, messageId) => {
        await this.tg.deleteMessagesById(chatId, [messageId])
      },
      mute: async (chatId, userId, untilSeconds) => {
        await this.tg.restrictChatMember({
          chatId,
          userId,
          restrictions: { sendMessages: true, sendMedia: true, sendStickers: true, sendGifs: true, sendGames: true, sendInline: true, embedLinks: true, sendPolls: true, sendPhotos: true, sendVideos: true, sendRoundvideos: true, sendAudios: true, sendVoices: true, sendDocs: true, sendPlain: true },
          until: new Date(Date.now() + untilSeconds * 1000)
        })
      },
      ban: async (chatId, userId) => {
        await this.tg.banChatMember({ chatId, participantId: userId })
      }
    }
  }

  /** Fetch the replied-to message (1 call, used by the enrichment budget). */
  async fetchRepliedMessage(msg: Message): Promise<Message | null> {
    const raw = msg.raw
    if (raw._ !== 'message' || raw.replyTo?._ !== 'messageReplyHeader') return null
    const replyId = raw.replyTo.replyToMsgId
    if (!replyId) return null
    try {
      const messages = await this.tg.getMessages(msg.chat.id, [replyId])
      return messages[0] ?? null
    } catch {
      return null
    }
  }

  async start(): Promise<{ id: number; username: string | null }> {
    const self = await this.tg.start({ botToken: this.config.botToken })
    return { id: self.id, username: self.username }
  }

  async stop(): Promise<void> {
    for (const { timer } of this.albumBuffers.values()) clearTimeout(timer)
    await this.tg.destroy()
  }
}
