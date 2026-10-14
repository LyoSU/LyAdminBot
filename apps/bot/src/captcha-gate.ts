/**
 * Who is currently being asked to prove they are human, and what may still be
 * done to them.
 *
 * Lifted out of `main.ts` on 2026-08-27, because the bookkeeping had grown a
 * class of defect a composition root cannot be tested for. Every act in the
 * flow — whisper, visible prompt, tap, consequence — is separated from the act
 * before it by an `await` on Telegram, and the map was mutated BY KEY across
 * those gaps. Three bugs of one shape came out of that:
 *
 *   - a gate whose delivery failed called `forget(key)` and dropped the NEWER
 *     gate that had been issued, and delivered, while its own send was in
 *     flight — lifting that gate's restriction and stopping its timers;
 *   - a tap landing a fraction before the deadline told the member "passed"
 *     while the consequence, already past its own guard, went on to mute them
 *     and delete their message: `clearTimeout` cannot recall a callback that
 *     has already started;
 *   - the consequence checked map identity but never expiry, so a gate that had
 *     outlived its TTL could still impose an hour-long restriction whose escape
 *     button `peek` would by then refuse.
 *
 * Hence the one rule this module exists to enforce: **a caller may act only on
 * the gate it is holding, and only while that gate is still the one in force**.
 * Everything that mutates takes the gate itself; nothing takes the key.
 */

export interface CaptchaGate {
  readonly chatId: number
  readonly userId: number
  /** When the gate was opened; the origin `ageMs` measures a tap against. */
  readonly issuedMs: number
  /** When the button stops working; see CAPTCHA_TTL_MS at the call site. */
  readonly expiresMs: number
  /** Set once the whisper lands; addressed via `deleteEphemeralMessage`. */
  ephemeralMessageId: number | null
  /** Set once a visible prompt is posted; an ordinary message id. */
  publicMessageId: number | null
  /**
   * The message that triggered the gate. A standalone captcha deliberately
   * leaves it up — the sender has not been judged, only asked — which is
   * exactly why it comes down if the asking is ignored.
   */
  triggerMessageId: number | null
  /**
   * Liveness was proven, whatever we then managed to do about it.
   *
   * Set the moment a valid tap is recognised and BEFORE the unrestrict is
   * attempted, because the tap is the evidence and our RPC is not. A tap whose
   * unrestrict fails leaves the gate open — another tap is the only thing the
   * member can do, and it is worth something — but silence is no longer an
   * available reading of them.
   */
  answered: boolean
  /** Set when the consequence is claimed, so it can be claimed only once. */
  consequenceApplied: boolean
  /**
   * When the first prompt id was recorded on this gate — the moment the
   * question left the building and the consequence clock started. Null while
   * nothing has been delivered. Kept by the registry, never set by a caller:
   * see `build`.
   */
  readonly deliveredMs: number | null
  /** Timers to stop the moment this gate stops being the one in force. */
  readonly cancels: Array<() => void>
}

/**
 * Where a gate outlives the process (2026-09-21).
 *
 * The registry is memory, and a restart used to empty it while the prompts it
 * had posted stayed up: the member tapped a button the chat still showed, `peek`
 * found nothing, and the tap was answered with silence while the restriction ran
 * its full term. That is the one failure a captcha may not have — the button is
 * the promised exit.
 *
 * So the registry reports every gate it opens and every gate it closes, and the
 * tap path asks the persisted copy when memory has none.
 *
 * Since 2026-10-15 it also reports what the CONSEQUENCE needs: when the prompt
 * was delivered, which message triggered it, the prompt ids, and whether the
 * gate was answered or already punished. Until then the 120-second timer lived
 * only in memory, so a gate counting down across a deploy was never punished
 * and its trigger message stayed up — 5 such gates in the 14 days to
 * 2026-10-14, with 5 deploys on 2026-10-14 alone and no persistent volume. The
 * boot path reads these rows back and re-arms or applies the consequence; see
 * `planRestoredGate`.
 *
 * Fire-and-forget by contract: the registry is synchronous and a Mongo hiccup
 * must not reach it. `issuedMs` rides on the drop and on every mark so a late
 * write cannot touch a newer gate for the same person that was saved after it.
 */
export interface GatePersistence {
  save(gate: { chatId: number; userId: number; issuedMs: number; expiresMs: number }): void
  drop(chatId: number, userId: number, issuedMs: number): void
  /**
   * Update the row of exactly this gate, if it still exists. Must NOT upsert:
   * a mark landing after the drop of a passed gate would bring the row back,
   * and the next boot would punish somebody who answered.
   */
  mark?(chatId: number, userId: number, issuedMs: number, patch: GateMark): void
}

/** What a gate learns after it was opened, as persisted. */
export interface GateMark {
  deliveredMs?: number
  triggerMessageId?: number | null
  ephemeralMessageId?: number | null
  publicMessageId?: number | null
  answered?: true
  consequenceApplied?: true
}

/** A persisted gate as the boot path reads it back. */
export interface PersistedGate {
  chatId: number
  userId: number
  issuedMs: number
  expiresMs: number
  /** Null for a gate never delivered — and for every row written before 2026-10-15. */
  deliveredMs: number | null
  triggerMessageId: number | null
  ephemeralMessageId: number | null
  publicMessageId: number | null
  answered: boolean
  consequenceApplied: boolean
}

/** What the boot path does with one restored gate. */
export type RestoredGatePlan =
  | { kind: 'rearm'; delayMs: number }
  | { kind: 'apply' }
  | { kind: 'skip'; reason: 'answered' | 'punished' | 'expired' | 'undelivered' | 'button_would_lapse' }

/**
 * What to do with a gate that outlived its process.
 *
 * The consequence is due `graceMs` after delivery, exactly as the live timer
 * counts it. Still in the future → re-arm for what remains. Already past — the
 * bot was down at that moment — → apply once, through the same claim the live
 * timer takes.
 *
 * Never applied when the button would lapse before the mute it is meant to
 * undo (`muteMs`): the restriction may not outlast the member's own exit,
 * which is what bounds the ignored-gate mute to an hour in the first place. A
 * live consequence fires with mute + 10 min of button left, so this refuses
 * only a backlog more than ten minutes overdue.
 *
 * A gate never delivered was never a question, and a row from before
 * 2026-10-15 does not say whether it was: both stay passable, never punished.
 */
export const planRestoredGate = (
  gate: PersistedGate, nowMs: number, graceMs: number, muteMs: number
): RestoredGatePlan => {
  if (gate.expiresMs <= nowMs) return { kind: 'skip', reason: 'expired' }
  if (gate.answered) return { kind: 'skip', reason: 'answered' }
  if (gate.consequenceApplied) return { kind: 'skip', reason: 'punished' }
  if (gate.deliveredMs === null) return { kind: 'skip', reason: 'undelivered' }
  const delayMs = gate.deliveredMs + graceMs - nowMs
  if (delayMs > 0) return { kind: 'rearm', delayMs }
  if (gate.expiresMs - nowMs < muteMs) return { kind: 'skip', reason: 'button_would_lapse' }
  return { kind: 'apply' }
}

/**
 * Whether `getChatMember` says this person is no longer in the chat at all.
 *
 * A restored gate crossed a window in which we saw no updates, so a removal or
 * ban made by hand during the downtime never reached `dropGate`. Read from the
 * raw answer rather than `MemberFacts`, which counts a `banned` or `left`
 * status as a participant. `undefined` — the lookup failed — is not an answer
 * and is not read as gone: the live timer does not ask at all.
 */
export const memberGone = (
  answer: { status?: unknown; isMember?: unknown } | null | undefined
): boolean => {
  if (answer === undefined) return false
  if (answer === null) return true
  if (answer.status === 'banned' || answer.status === 'left') return true
  return answer.status === 'restricted' && answer.isMember === false
}

/** The mutable half of a gate's delivery, behind its prompt-id accessors. */
interface DeliveryState {
  ephemeral: number | null
  visible: number | null
  deliveredMs: number | null
}

/** Gates held before room is made; a raid is what makes this a real number. */
const MAX_GATES = 2000

const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`

export class CaptchaGates {
  /** Insertion-ordered, which is what makes "the oldest" below meaningful. */
  private readonly gates = new Map<string, CaptchaGate>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxGates: number = MAX_GATES,
    private readonly persistence: GatePersistence | null = null
  ) {}

  private persist(op: (p: GatePersistence) => void): void {
    if (this.persistence === null) return
    try { op(this.persistence) } catch { /* see GatePersistence: never reaches the registry */ }
  }

  /** How many gates are open — for the sweep, and for tests. */
  get size(): number { return this.gates.size }

  /**
   * Open a gate, replacing whatever stood for the same person in the same chat
   * — and stopping its timers, which the previous code left running against a
   * gate no tap could reach any more.
   */
  issue(chatId: number, userId: number, ttlMs: number): CaptchaGate {
    const key = keyOf(chatId, userId)
    const previous = this.gates.get(key)
    if (previous !== undefined) {
      this.stop(previous)
      this.gates.delete(key)
    }
    this.makeRoom()
    const issuedMs = this.now()
    const gate = this.build(chatId, userId, issuedMs, issuedMs + ttlMs, null, null, null)
    this.gates.set(key, gate)
    this.persist((p) => p.save({ chatId, userId, issuedMs: gate.issuedMs, expiresMs: gate.expiresMs }))
    return gate
  }

  /**
   * Put a gate that outlived its process back in force, so a tap finds it in
   * memory and `claimConsequence` can refuse a second punishment. Nothing is
   * persisted — the row is where it came from. Refused (null) when it lapsed,
   * or when a gate for the same person was issued since boot: the newer one
   * owns them.
   */
  restore(row: PersistedGate): CaptchaGate | null {
    if (row.expiresMs <= this.now()) return null
    const key = keyOf(row.chatId, row.userId)
    if (this.gates.has(key)) return null
    this.makeRoom()
    const gate = this.build(
      row.chatId, row.userId, row.issuedMs, row.expiresMs,
      row.deliveredMs, row.ephemeralMessageId, row.publicMessageId
    )
    gate.triggerMessageId = row.triggerMessageId
    gate.answered = row.answered
    gate.consequenceApplied = row.consequenceApplied
    this.gates.set(key, gate)
    return gate
  }

  /**
   * The prompt ids are accessors so the registry learns the moment of delivery
   * without the delivery code having to report it: assigning the first id IS
   * delivery, and the consequence timer is armed in the same tick after it.
   */
  private build(
    chatId: number, userId: number, issuedMs: number, expiresMs: number,
    deliveredMs: number | null, ephemeral: number | null, visible: number | null
  ): CaptchaGate {
    const state: DeliveryState = { ephemeral, visible, deliveredMs }
    const note = (gate: CaptchaGate): void => { this.noteDelivery(gate, state) }
    const gate: CaptchaGate = {
      chatId,
      userId,
      issuedMs,
      expiresMs,
      get ephemeralMessageId() { return state.ephemeral },
      set ephemeralMessageId(id: number | null) { state.ephemeral = id; note(gate) },
      get publicMessageId() { return state.visible },
      set publicMessageId(id: number | null) { state.visible = id; note(gate) },
      get deliveredMs() { return state.deliveredMs },
      triggerMessageId: null,
      answered: false,
      consequenceApplied: false,
      cancels: []
    }
    return gate
  }

  private noteDelivery(gate: CaptchaGate, state: DeliveryState): void {
    if (state.ephemeral === null && state.visible === null) return
    if (state.deliveredMs === null) state.deliveredMs = this.now()
    this.mark(gate, {
      deliveredMs: state.deliveredMs,
      triggerMessageId: gate.triggerMessageId,
      ephemeralMessageId: state.ephemeral,
      publicMessageId: state.visible
    })
  }

  private mark(gate: CaptchaGate, patch: GateMark): void {
    this.persist((p) => p.mark?.(gate.chatId, gate.userId, gate.issuedMs, patch))
  }

  /**
   * How long this gate has been open.
   *
   * The number the whole 45-second question turns on: a tap at 20s means the
   * whisper did its work and the chat saw nothing, a tap at 90s means the same
   * member was publicly accused first and answered anyway. Until this was
   * recorded the two were the same event in every record we keep.
   */
  ageMs(gate: CaptchaGate): number {
    return this.now() - gate.issuedMs
  }

  /** The gate in force for this person, or null if there is none or it lapsed. */
  peek(chatId: number, userId: number): CaptchaGate | null {
    const gate = this.gates.get(keyOf(chatId, userId))
    if (gate === undefined) return null
    return gate.expiresMs > this.now() ? gate : null
  }

  /**
   * Is the gate I am holding still the one in force?
   *
   * The question every caller asks again after each `await`. Expiry is part of
   * the answer on purpose: a gate `peek` would refuse is a gate nothing else
   * may act upon either.
   */
  isCurrent(gate: CaptchaGate): boolean {
    return this.gates.get(keyOf(gate.chatId, gate.userId)) === gate &&
      gate.expiresMs > this.now()
  }

  /**
   * Drop the gate I am holding, if it is still mine. Returns whether anything
   * was dropped, so a caller can tell "I closed this" from "somebody else had
   * already replaced it" — and not report the second as the first.
   */
  forget(gate: CaptchaGate): boolean {
    const key = keyOf(gate.chatId, gate.userId)
    if (this.gates.get(key) !== gate) return false
    this.stop(gate)
    this.gates.delete(key)
    this.persist((p) => p.drop(gate.chatId, gate.userId, gate.issuedMs))
    return true
  }

  /** A tap arrived. From here on this gate has been answered. */
  markAnswered(gate: CaptchaGate): void {
    gate.answered = true
    // Persisted because a tap whose unrestrict failed keeps its gate open, and
    // a restart must not then read that gate as ignored.
    this.mark(gate, { answered: true })
  }

  /**
   * Claim the right to punish an unanswered gate — once.
   *
   * A claim rather than a question, because the caller then awaits Telegram and
   * the answer must not be able to change underneath it. Refused when the gate
   * was answered, already claimed, replaced, or expired.
   */
  claimConsequence(gate: CaptchaGate): boolean {
    if (gate.answered) return false
    if (gate.consequenceApplied) return false
    if (!this.isCurrent(gate)) return false
    gate.consequenceApplied = true
    // Persisted so "claimed once" survives a restart: the gate is kept after
    // its consequence, and the next boot must not punish it a second time.
    this.mark(gate, { consequenceApplied: true })
    return true
  }

  private stop(gate: CaptchaGate): void {
    for (const cancel of gate.cancels) cancel()
    gate.cancels.length = 0
  }

  /**
   * Make room for one more. The dead go first; if every gate is still live —
   * which is precisely what a join raid looks like — the oldest goes anyway. A
   * cap that only collects the dead is not a cap.
   */
  private makeRoom(): void {
    if (this.gates.size < this.maxGates) return
    const now = this.now()
    for (const [key, gate] of this.gates) {
      if (gate.expiresMs <= now) {
        this.stop(gate)
        this.gates.delete(key)
        // No drop: the persisted copy carries the same expiry and its TTL
        // removes it; a drop here would be a write per dead gate in a raid.
      }
    }
    while (this.gates.size >= this.maxGates) {
      const oldest = this.gates.keys().next()
      if (oldest.done === true) return
      const gate = this.gates.get(oldest.value)
      if (gate !== undefined) {
        this.stop(gate)
        // The persisted copy is KEPT. Eviction is about memory, not about the
        // member: their gate was legitimate, its consequence is stopped with its
        // timers, and the button they are looking at should still let them out.
      }
      this.gates.delete(oldest.value)
    }
  }
}
