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
 * tap path asks the persisted copy when memory has none. Only what the exit
 * needs is kept: who, and until when. The consequence is not rebuilt after a
 * restart — a gate that outlived its process can still be passed, never punished.
 *
 * Fire-and-forget by contract: the registry is synchronous and a Mongo hiccup
 * must not reach it. `issuedMs` rides on the drop so a late delete cannot remove
 * a newer gate for the same person that was saved after it.
 */
export interface GatePersistence {
  save(gate: { chatId: number; userId: number; issuedMs: number; expiresMs: number }): void
  drop(chatId: number, userId: number, issuedMs: number): void
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
    const gate: CaptchaGate = {
      chatId,
      userId,
      issuedMs: this.now(),
      expiresMs: this.now() + ttlMs,
      ephemeralMessageId: null,
      publicMessageId: null,
      triggerMessageId: null,
      answered: false,
      consequenceApplied: false,
      cancels: []
    }
    this.gates.set(key, gate)
    this.persist((p) => p.save({ chatId, userId, issuedMs: gate.issuedMs, expiresMs: gate.expiresMs }))
    return gate
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
