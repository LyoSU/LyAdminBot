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
import {
  BotKeyboard, TelegramClient, html, type InputText,
  type EphemeralCallbackQuery, type Message
} from '@mtcute/node'
import { Dispatcher, type CallbackQueryContext } from '@mtcute/dispatcher'
import type { ModerationActions } from './executor.js'
import { moderationActionsOver } from './moderation-actions.js'
import { createUpdateDedup, deliveryKey } from './update-dedup.js'
import { isContentEdit } from './edit-updates.js'
import {
  botApiMediaKind, resendStoredMedia, sendMediaByFileId, type ResendResult
} from './media-resend.js'

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

/** A delivery the gateway refused because it had already routed that message. */
export interface DuplicateDelivery {
  chatId: number
  messageId: number
  isEdit: boolean
  /** Running count since boot — a rising number is a transport symptom. */
  total: number
}

/**
 * An edit-class update that carried no edit — a reaction, a pin, a TTL change.
 * See edit-updates.ts for why Telegram calls those edits.
 */
export interface EditEcho {
  chatId: number
  messageId: number
  /** Running count since boot. Reactions are ordinary traffic; bulk is the story. */
  total: number
}

const ALBUM_BUFFER_MS = 600

export class TelegramGateway {
  readonly tg: TelegramClient
  private readonly dispatcher: Dispatcher
  private readonly chatQueues = new Map<number, Promise<void>>()
  private readonly albumBuffers = new Map<string, { messages: Message[]; timer: NodeJS.Timeout }>()
  private handler: MessageHandler | null = null
  private readonly dedup = createUpdateDedup()
  private duplicatesDropped = 0
  private editEchoesDropped = 0
  /** App-supplied error sink; defaults to console.error so adapters stay pure. */
  private errorSink: (err: unknown) => void = (err) => console.error('[gateway] handler error:', err)
  /**
   * Reported so a redelivery is visible rather than merely absent: without it,
   * "the pipeline ran once" and "the transport went quiet" look identical.
   */
  private duplicateSink: (info: DuplicateDelivery) => void = () => { /* silent by default */ }
  /** Same reasoning as `duplicateSink`: a drop nobody records is a drop nobody can find. */
  private editEchoSink: (info: EditEcho) => void = () => { /* silent by default */ }

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
      // Reactions reach us as edits of the message they sit on. Handing one to
      // the pipeline replays the message, and a replayed command is a command
      // run twice (production 2026-08-27).
      if (!isContentEdit(msg)) {
        this.editEchoesDropped += 1
        this.editEchoSink({
          chatId: msg.chat.id, messageId: msg.id, total: this.editEchoesDropped
        })
        return
      }
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

  /** Route dropped redeliveries somewhere structured (the app logger). */
  onDuplicate(sink: (info: DuplicateDelivery) => void): void {
    this.duplicateSink = sink
  }

  /** Route edit updates that carried no edit somewhere structured (the app logger). */
  onEditEcho(sink: (info: EditEcho) => void): void {
    this.editEchoSink = sink
  }

  /** Expose callback-query routing without leaking the dispatcher. */
  onCallbackQuery(handler: (query: CallbackQueryContext) => Promise<void>): void {
    this.dispatcher.onCallbackQuery(handler)
  }

  /**
   * Taps on buttons of an ephemeral message. A separate update type
   * (`updateEphemeralBotCallbackQuery`), so it needs its own subscription — a
   * handler registered with `onCallbackQuery` will never see these.
   */
  onEphemeralCallbackQuery(handler: (query: EphemeralCallbackQuery) => Promise<void>): void {
    this.dispatcher.onEphemeralCallbackQuery(handler)
  }

  /**
   * Post a message only `receiverId` can see, and get back the id needed to
   * remove it again. Ephemeral messages are not part of chat history: nobody
   * else sees the prompt and there is nothing to clean up afterwards, which is
   * what makes asking a suspect "are you human?" cheap enough to prefer over
   * punishing them.
   *
   * `text` arrives ALREADY RENDERED, as `InputText`, and that is deliberate.
   * This method used to take a plain string and do its own
   * `\n` → `<br>` pass, which is a second, dumber copy of the app's `viewHtml`:
   * that one knows a `<br>` inside a `<pre>` block is dropped by the parser
   * while real newlines survive, and this one did not. Two renderers for one
   * kind of text is how a quoted message eventually arrives welded into a
   * single run-on line. The caller renders; this only sends.
   */
  async sendEphemeralPrompt(
    chatId: number,
    receiverId: number,
    text: InputText,
    buttons: { text: string; data: string }[][],
    /**
     * Message this prompt answers. A whisper is invisible to everyone else, so
     * without the reply the recipient has nothing tying it to what they just
     * sent — and a bare "prove you are human" with no referent reads like a
     * phishing attempt. The reply also produces the notification that makes an
     * ephemeral message noticed at all.
     */
    replyTo?: number
  ): Promise<number> {
    const sent = await this.tg.sendEphemeralMessage(
      chatId,
      receiverId,
      text,
      {
        ...(buttons.length > 0
          ? {
              replyMarkup: BotKeyboard.inline(
                buttons.map((row) => row.map((b) => BotKeyboard.callback(b.text, b.data))))
            }
          : {}),
        ...(replyTo !== undefined ? { replyTo } : {})
      }
    )
    return sent.id
  }

  /** Remove an ephemeral message early; it expires on its own regardless. */
  async removeEphemeralPrompt(chatId: number, receiverId: number, messageId: number): Promise<void> {
    await this.tg.deleteEphemeralMessage({ chatId, receiverId, messageId })
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
    // Before anything else, including album buffering: a redelivered album part
    // would otherwise be appended to the buffer a second time and evaluated as
    // part of the same album. See update-dedup.ts for why the transport can
    // deliver one message twice.
    if (!this.dedup.claim(deliveryKey(msg.chat.id, msg.id, isEdit, msg.editDate))) {
      this.duplicatesDropped += 1
      this.duplicateSink({
        chatId: msg.chat.id, messageId: msg.id, isEdit, total: this.duplicatesDropped
      })
      return
    }
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

  /**
   * ModerationActions over MTProto for the executor.
   *
   * The implementation lives in moderation-actions.ts: which encoding of a
   * sentence Telegram honours for which kind of sender is a fact worth a test,
   * and nothing here can be tested without a live client.
   */
  get moderationActions(): ModerationActions {
    return moderationActionsOver(this.tg)
  }

  /**
   * Send media we only know by file id (extras, welcome gifs). Falls back to
   * the Bot API when the id predates MTProto file references — see
   * media-resend.ts. `caption` is Bot API HTML with real newlines; the MTProto
   * leg gets the `<br>` dialect its parser wants.
   */
  async sendStoredMedia(
    chatId: number,
    fileId: string,
    opts: { caption?: string; replyTo?: number } = {}
  ): Promise<ResendResult> {
    const media = opts.caption === undefined
      ? {}
      : { caption: html(opts.caption.replace(/\n/g, '<br>')) }
    return resendStoredMedia({
      viaMtproto: () => this.tg.sendMedia(chatId, fileId, {
        ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
        ...media
      }),
      viaBotApi: () => sendMediaByFileId({
        token: this.config.botToken,
        chatId,
        fileId,
        kind: botApiMediaKind(fileId),
        ...(opts.caption === undefined ? {} : { caption: opts.caption }),
        ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo })
      })
    })
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
