export const JOIN_WINDOW_MS = 60_000
export const JOIN_SURGE_MIN = 8
export const JOIN_SURGE_QUIET_MS = 10 * 60_000
export const JOIN_TRACKED_CHATS_MAX = 500
export const JOIN_SCREEN_BUDGET = 10
export const JOIN_SURGE_ALERT_RISK_MIN = 2

export interface JoinRateResult {
  surging: boolean
  started: boolean
  total: number
}

interface JoinEvent {
  at: number
  count: number
  userIds: readonly number[]
}

interface JoinState {
  events: JoinEvent[]
  lastJoinAt: number
  surging: boolean
  welcomed: boolean
  screened: number
  surgeMemberIds: Set<number>
  riskMemberIds: Set<number>
  alertTaken: boolean
}

interface JoinRateOptions {
  windowMs?: number
  surgeMin?: number
  quietMs?: number
  maxChats?: number
  screenBudget?: number
  alertRiskMin?: number
}

/** Bounded per-chat memory for join bursts and their amplification budgets. */
export class JoinRateTracker {
  private readonly chats = new Map<number, JoinState>()
  private readonly windowMs: number
  private readonly surgeMin: number
  private readonly quietMs: number
  private readonly maxChats: number
  private readonly screenBudget: number
  private readonly alertRiskMin: number

  constructor(
    private readonly now: () => number = Date.now,
    options: JoinRateOptions = {}
  ) {
    this.windowMs = options.windowMs ?? JOIN_WINDOW_MS
    this.surgeMin = options.surgeMin ?? JOIN_SURGE_MIN
    this.quietMs = options.quietMs ?? JOIN_SURGE_QUIET_MS
    this.maxChats = options.maxChats ?? JOIN_TRACKED_CHATS_MAX
    this.screenBudget = options.screenBudget ?? JOIN_SCREEN_BUDGET
    this.alertRiskMin = options.alertRiskMin ?? JOIN_SURGE_ALERT_RISK_MIN
  }

  note(chatId: number, count: number, userIds: readonly number[] = []): JoinRateResult {
    const now = this.now()
    let state = this.chats.get(chatId)
    if (!state) {
      state = this.freshState(now)
    } else {
      const resetAfter = state.surging ? this.quietMs : this.windowMs
      if (now - state.lastJoinAt > resetAfter) state = this.freshState(now)
    }

    state.events = state.events.filter((event) => now - event.at <= this.windowMs)
    const safeCount = Math.max(0, Math.floor(count))
    if (safeCount > 0) {
      state.events.push({ at: now, count: safeCount, userIds })
      state.lastJoinAt = now
    }

    const total = state.events.reduce((sum, event) => sum + event.count, 0)
    const started = !state.surging && total >= this.surgeMin
    if (started) {
      state.surging = true
      for (const event of state.events) {
        for (const userId of event.userIds) state.surgeMemberIds.add(userId)
      }
    } else if (state.surging) {
      for (const userId of userIds) state.surgeMemberIds.add(userId)
    }

    this.touch(chatId, state)
    return { surging: state.surging, started, total }
  }

  /**
   * Claim the single greeting allowed in one *surge* episode.
   *
   * Outside a surge every batch is greeted exactly as before. The throttle
   * exists to stop the bot amplifying an influx, not to ration ordinary
   * greetings — and gating on the episode alone did the latter: an episode is
   * any run of joins spaced under `windowMs`, so a chat receiving one member
   * every fifty seconds greeted the first and then nobody, indefinitely,
   * without ever surging.
   *
   * Greetings sent before the threshold is reached are not recoverable — the
   * surge is only knowable in arrears, and nothing here delays a greeting to
   * find out. So a burst still costs up to `surgeMin` messages before it goes
   * quiet, which is the price of answering in real time.
   */
  claimWelcome(chatId: number): boolean {
    const state = this.chats.get(chatId)
    if (!state || !state.surging) return true
    if (state.welcomed) return false
    state.welcomed = true
    return true
  }

  /** Reserve screening slots shared by all packets in the current episode. */
  claimScreening(chatId: number, requested: number): number {
    const state = this.chats.get(chatId)
    if (!state) return 0
    const granted = Math.min(Math.max(0, Math.floor(requested)), this.screenBudget - state.screened)
    state.screened += granted
    return granted
  }

  joinedDuringSurge(chatId: number, userId: number): boolean {
    const state = this.chats.get(chatId)
    return state !== undefined &&
      state.surging &&
      this.now() - state.lastJoinAt <= this.quietMs &&
      state.surgeMemberIds.has(userId)
  }

  noteRisk(chatId: number, userId: number): void {
    this.chats.get(chatId)?.riskMemberIds.add(userId)
  }

  /** Consume the alert transition once; callers may safely check after each risk result. */
  takeSurgeAlert(chatId: number): { riskCount: number; total: number } | null {
    const state = this.chats.get(chatId)
    if (
      !state?.surging ||
      this.now() - state.lastJoinAt > this.quietMs ||
      state.alertTaken ||
      state.riskMemberIds.size < this.alertRiskMin
    ) return null
    state.alertTaken = true
    return {
      riskCount: state.riskMemberIds.size,
      total: state.events.reduce((sum, event) => sum + event.count, 0)
    }
  }

  trackedChatCount(): number {
    return this.chats.size
  }

  private freshState(now: number): JoinState {
    return {
      events: [],
      lastJoinAt: now,
      surging: false,
      welcomed: false,
      screened: 0,
      surgeMemberIds: new Set(),
      riskMemberIds: new Set(),
      alertTaken: false
    }
  }

  private touch(chatId: number, state: JoinState): void {
    this.chats.delete(chatId)
    this.chats.set(chatId, state)
    while (this.chats.size > this.maxChats) {
      const oldest = this.chats.keys().next().value
      if (oldest === undefined) break
      this.chats.delete(oldest)
    }
  }
}
