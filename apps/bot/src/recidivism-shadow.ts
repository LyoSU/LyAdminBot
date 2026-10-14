/**
 * What the next act against an account that ignored a captcha in this chat
 * would be, if its silence counted.
 *
 * Measured over the 14 days to 2026-10-14: of 65 accounts that came back to the
 * chat where they had ignored a captcha (and served the hour's mute), 59 were
 * then punished there for spam, 52 of them on the very next message. About 27
 * of those got only a delete and were free to post again. 6 came back clean —
 * the reason this does not ban on the ignored captcha itself.
 *
 * Shadow only: the decision row gets `shadowEscalate` and a log line, nobody
 * is removed. The stages are the ones that read a message, as in
 * `isShadowCarryAct`; the mute that answered the silence is not among them.
 */
export const IGNORED_CAPTCHA_ESCALATION_MS = 7 * 86_400_000

const CONTENT_DECIDERS: ReadonlySet<string> = new Set([
  'signature', 'llm', 'llm_cached', 'session', 'score', 'burst'
])

export const wouldEscalateAfterIgnoredCaptcha = (
  act: { action: string; decidedBy: string; messageId: number },
  ignoredAt: Date | null,
  now = Date.now()
): boolean =>
  ignoredAt !== null
  && act.action === 'delete'
  && act.messageId > 0
  && CONTENT_DECIDERS.has(act.decidedBy)
  && now - ignoredAt.getTime() <= IGNORED_CAPTCHA_ESCALATION_MS
