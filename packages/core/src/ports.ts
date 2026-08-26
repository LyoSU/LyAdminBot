/**
 * Pipeline ports — the only doors through which IO enters the core.
 * Adapters/data implement these; tests and the replay tool fake them.
 *
 * Contract for every port: returning null means "stage unavailable /
 * no answer" and the pipeline continues gracefully. Ports should not
 * throw; if they do, the pipeline treats it as null and counts the error.
 */
import type { EvaluationInput } from './types.js'

export interface SignatureMatch {
  /** confirmed = human/override-verified; candidate = self-learned. */
  status: 'confirmed' | 'candidate'
  pSpam: number
  signatureId: string
}

export interface SignaturePort {
  match(text: string): Promise<SignatureMatch | null>
}

export interface VelocityResult {
  exceeded: boolean
  /**
   * Every copy came from ONE account. That is a blast, and nothing legitimate
   * looks like it. Several accounts carrying the same text may equally be a
   * multi-account campaign or a line that went viral, so the pipeline treats
   * that case as strong evidence in need of a human, not as a certainty.
   * Absent means "unknown" and is read conservatively (as a wave).
   */
  singleAuthor?: boolean
  evidence?: string
}

export interface VelocityCheckOptions {
  /**
   * Count EXACT repeats of the raw text when the heavy-normalised template is
   * too short to key on.
   *
   * The window normally keys on `normalizeHeavy(text)` and refuses anything
   * under five characters, which is right: a two-character template describes
   * half the chat, and 2026-02 shipped that defect three times — a normaliser
   * that collapses unrelated inputs to one value produces an entry matching
   * everybody.
   *
   * But refusing to KEY on it became refusing to COUNT it, and a whole class
   * walked through the hole. Measured 2026-08-25: an account with a private
   * invite in its bio posted one heart emoji into one chat six times over
   * twelve hours. `normalizeHeavy('❤')` is the empty string, so the window
   * never saw a single one of them; the burst window is ten minutes and the
   * session window thirty, so a message every ninety minutes is below every
   * clock this pipeline owns.
   *
   * Exact text has none of the collapse problem — it cannot map two different
   * messages onto one key, because it is not a mapping. What it can do is
   * count an ordinary member's third "👍", so callers must only ask for it
   * where that is not the population being looked at.
   */
  countExactWhenTemplateUnusable?: boolean
}

export interface VelocityPort {
  /** Sliding-window duplicate / flood detection across chats. */
  check(input: EvaluationInput, options?: VelocityCheckOptions): Promise<VelocityResult | null>
}

export interface VectorMatch {
  similarity: number
  status: 'confirmed' | 'candidate'
  vectorId: string
}

export interface VectorPort {
  /** Semantic nearest-spam search (embeddings). */
  search(text: string): Promise<VectorMatch | null>
}

export interface ModerationResult {
  /** Provider's own aggregate flag — recall-tuned, so a weak indicator. */
  flagged: boolean
  categories: string[]
  /**
   * Per-category confidence, 0..1. The aggregate `flagged` boolean fires on
   * ANY category above the provider's own (deliberately low) threshold, which
   * made profile-media screening fire on stylised art holding a weapon. Callers
   * that need precision must read the score of the categories they care about
   * instead of trusting `flagged`. Empty when the provider exposes no scores.
   */
  scores: Record<string, number>
}

export interface ModerationPort {
  check(text: string, photoBase64: string | null): Promise<ModerationResult | null>
}

export interface LlmVerdict {
  pSpam: number
  /** Stable reason code (NOT free-form model text). */
  reasonCode: string
  evidence: string | null
  cached: boolean
  /**
   * Short prefix of the cache key this answer was filed under, for the log.
   *
   * A miss is otherwise undiagnosable: the key is a hash of the model, the
   * prompt fingerprint, a structural context digest and the folded text, and
   * not one of those inputs is recorded anywhere. Production 2026-08-03 — one
   * account sent an identical text five times in fourteen seconds and paid for
   * three separate calls plus two session calls; the key is computed from things
   * that may legitimately differ between the copies, and nothing in the log says
   * which one did. Two adjacent lines with two prefixes answer it at a glance.
   */
  cacheKey?: string
  /**
   * Which model answered — the slug, as routed.
   *
   * Recorded because the model is the one input to a verdict that changes
   * WITHOUT a deploy: it comes from `LLM_MODEL` in the environment, so a switch
   * left no trace anywhere in the data. 2026-08-07, asked whether a newly
   * pointed-to model was better, the honest answer was that the question could
   * not be asked of 226k stored verdicts at all — every one of them is silent
   * about who judged it. Answering it took replaying reversed calls through the
   * live API, which is both slower and confounded by prompt changes shipped in
   * between. One field turns that into a `$group`.
   */
  model?: string
}

/**
 * One classifier, one call per message.
 *
 * There used to be two tiers, `cheap` and `strong`, with every cheap verdict
 * that would remove somebody re-asked of the stronger model. Production
 * 2026-08-05/07 retired the idea: across ~25 escalations the strong tier
 * returned a usable answer zero times, and `llmTier` stayed `cheap` in every
 * log line — a safeguard that had been off for as long as anyone had looked,
 * while reading as present in the code. A single model made the second call a
 * cache hit on the answer it was meant to check, which would have been worse:
 * the escalation would have reported itself as having concurred.
 *
 * What the tier split was reaching for — a removal should not rest on one
 * model's unsupported word — is a question about EVIDENCE, not about which
 * model answered. `mayRemoveSender` / `capUnearnedRemoval` are where that
 * belongs, and they apply to every other stage already.
 */
/**
 * Firsthand observations about THIS message that cannot be read out of its text.
 *
 * The classifier decides — its verdict replaces the score outright — and it was
 * being asked to decide without the one class of evidence the rest of the
 * pipeline had actually WATCHED happen. The velocity stage's own comment says
 * repetition "is a reason to look harder" and that "the stages that can READ
 * the message decide what it means"; the stage that can read the message was
 * never told.
 *
 * Production 2026-08-26 20:20–20:24: an account with three confirmed spam
 * detections and a 30-day ban a week old posted one text into three chats in
 * four minutes. The score reached 0.94. The classifier, shown the text alone,
 * called it `legit_share` all three times, and `legit_share` is what the chats
 * got — because the classifier's number is the verdict.
 *
 * Deliberately NOT the sender's history. That belongs to the account and this
 * codebase's recurring failure is profile evidence leaking into a verdict about
 * a sentence; repetition is different in kind — it is the message, arriving
 * again, observed by us.
 */
export interface MessageObservations {
  /**
   * What the cross-chat window watched arrive, verbatim from the velocity
   * stage: copies, chats, distinct accounts, inside its window.
   */
  repetition?: string
}

export interface LlmPort {
  classify(input: EvaluationInput, observed?: MessageObservations): Promise<LlmVerdict | null>
}

export interface SessionWindow {
  /** All buffered texts of this user in this chat, newline-joined. */
  combinedText: string
  count: number
}

export interface SessionPort {
  /**
   * Record an abstained message and return the accumulated window.
   *
   * `messageId` is what makes this a buffer rather than a counter. Without it
   * the window was a bare append, and an edit — which re-enters the pipeline,
   * abstains again, and arrives here a second time — added a SECOND copy of the
   * same text. The model was then shown `A A B B C`, and answered the question
   * it was asked: repeated identical phrases, mass posting.
   *
   * Measured 2026-08-26 across every session verdict ever recorded: 867 of 2172
   * windows held a repeated line, the bot acted on 49 of those, and 42 of the 49
   * had an edit from the same sender inside the same window. One was five lines
   * of a single message, called flood at 0.995. Against 74 acted-on session
   * verdicts in total, and `flood` was 58 of them — the verdict repetition makes.
   *
   * So an id that is already in the window REPLACES its entry and moves to the
   * end. Replaces rather than ignores: a message edited from "hi" into an advert
   * must be judged as the advert — that attack is why `edit_injected_link`
   * exists — so the newest text is the one that counts.
   */
  append(chatId: number, userId: number, messageId: number, text: string): Promise<SessionWindow>
  /**
   * Discard the window. Required, not optional: a port without it silently
   * turns the session path into repeated re-judgements of the same accumulated
   * text, which is the failure this interface change exists to prevent.
   */
  reset(chatId: number, userId: number): Promise<void>
}

/**
 * One message this sender already had judged in this chat, recently.
 *
 * Distinct from `SessionWindow`, and deliberately a second window rather than a
 * generalisation of it: the session window holds only the messages NOBODY could
 * classify and is emptied the moment the pile is judged, because "read five of
 * them together" means five unclassifiable ones. This window holds every
 * message that went through the pipeline, with what the pipeline made of it, and
 * answers a different question — is this sender in the middle of a burst.
 */
export interface BurstEntry {
  /** Message text as sent, truncated by the port. Empty for media-only. */
  text: string
  /**
   * The heavy-normalised template of `text` — the same reduction `velocity`
   * counts repeats by, computed by the port because that normaliser is the
   * signature vocabulary and must have exactly one owner.
   *
   * Why it travels with the entry instead of being derived here: distinctness
   * is the whole guard against double-counting. `velocity_repeats` (1.5) already
   * pays for the same text arriving twice, so a burst signal that counted those
   * copies as separate messages would charge one fact twice — the mistake the
   * newness group cap exists to undo. A weaker normaliser in this package would
   * silently reintroduce it.
   */
  template: string
  /** What the pipeline concluded about it, 0..1. */
  pSpam: number
  at: number
}

export interface BurstPort {
  /**
   * The sender's PRECEDING messages in this chat, oldest first — never
   * including the one being judged, which has no `pSpam` yet.
   */
  read(chatId: number, userId: number): Promise<BurstEntry[]>
  /** Record a judged message. Called after the verdict, by the app layer. */
  append(chatId: number, userId: number, entry: Omit<BurstEntry, 'template'>): Promise<void>
  /** Discard the window — same discipline as `SessionPort.reset`: a judged
   *  window is spent, or the next message re-rolls the same blob. */
  reset(chatId: number, userId: number): Promise<void>
}

/** Long-term reputation of a forward origin (v1 forwardblacklists). */
export type ForwardReputation = 'clean' | 'suspicious' | 'blacklisted'

export type ForwardOrigin = NonNullable<EvaluationInput['message']['forward']>

export interface ForwardPort {
  check(forward: ForwardOrigin): Promise<ForwardReputation | null>
}

/**
 * Remembers which accounts wear which profile picture.
 *
 * The only port that answers a question about a DIFFERENT account than the one
 * being judged, which is why it is here rather than folded into moderation: it
 * is the pipeline's sole means of noticing that two senders are one operator.
 */
export interface ProfileMediaPort {
  /**
   * Record this account against this picture hash and report who else wears it.
   * Null means nobody else does — or that the hash was unusable, which callers
   * must treat the same way. A picture seen once is not evidence of anything.
   */
  seen(userId: number, hash: string): Promise<{
    otherAccounts: number
    sampleUserIds: number[]
  } | null>
}

export interface PipelinePorts {
  signatures?: SignaturePort
  velocity?: VelocityPort
  vectors?: VectorPort
  moderation?: ModerationPort
  llm?: LlmPort
  session?: SessionPort
  burst?: BurstPort
  forwards?: ForwardPort
  profileMedia?: ProfileMediaPort
}
