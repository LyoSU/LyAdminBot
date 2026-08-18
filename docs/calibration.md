# Calibration runbook — refitting the score weights

> Review finding #9. The pipeline records feedback continuously, but turning
> that feedback into new `SIGNAL_WEIGHTS` is a **human-reviewed** procedure,
> not a runtime auto-refit. This document is that procedure.

## Why this is deliberately manual

`packages/core/src/score.ts` states the principle: weights are **data, not
code** — "a weight change is reviewable in a one-line diff." An automated
runtime refit is intentionally *not* implemented because:

- **Adversarial drift.** Spammers can shape the feedback corpus (mass-report a
  legit phrase, vote-brigade). A human reviewing a weight diff is the guard.
- **Feedback loops.** Auto-lowering a weight reduces future detections of that
  signal, which reduces its feedback, which can spiral. A human breaks the loop.
- **The replay gate.** Every weight change must pass the same offline replay
  gate as the original cutover (zero unexplained false positives) before it
  ships. That gate is a deliberate checkpoint, not something to bypass.

## The data already collected

- **`pipeline_decisions`** (TTL **14d** — lowered from 90d when the cluster hit
  its size cap) — every verdict: `pSpam`, `action`, `decidedBy`, `ruleId`,
  `signals` (names), `reasonCode`, and since 2026-08-07 `meta.llmModel`.
  The window is short, so a permanent label in `pipeline_feedback` loses its
  evidence two weeks on: measure while the rows are still there.
- **`pipeline_feedback`** (permanent) — `override_not_spam` rows: each is an
  admin-confirmed **false positive** (someone hit the override). `/untrust`
  and ham votes feed the same signal. One row per message since 2026-08-07 —
  before that a double tap wrote the same correction twice, so any count taken
  over older data should be deduplicated by `(chatId, messageId)`.

### What the tools can and cannot answer

`tools/replay` evaluates stored events with **no ports at all**
(`evaluateMessage(toInput(event), {})`), which makes it the right instrument for
a weight diff and the wrong one for a question about the classifier: offline, the
LLM never speaks. To ask whether a *model* is better, replay the reversed calls
through the live port instead, and always alongside a control set of uncontested
removals — otherwise "fewer false positives" is indistinguishable from a model
that simply stopped calling anything spam.

## Procedure (run monthly, or when FPs accumulate)

1. **Measure the FP surface.** Group confirmed FPs by what decided them:

   ```js
   // via MongoStore — see falsePositivesByRule()
   await store.falsePositivesByRule(Date.now() - 30 * 86400 * 1000)
   // → [{ decidedBy: 'score', ruleId: 'custom:2', count: 11 }, ...]
   ```

   A signal/rule with a disproportionate FP count is the demotion candidate.

2. **Reproduce offline.** Run the replay tool against recent production data to
   see how the *current* weights act, and how a proposed change would:

   ```bash
   MONGODB_URI=... pnpm --filter @lyadmin/replay replay --days 30
   MONGODB_URI=... pnpm --filter @lyadmin/replay replay --signatures
   ```

   Replay is offline (no Telegram, no live HTTP) and understates signals, so a
   `spam` call there is a strong claim and a `none` needs eyeballing against the
   message preview.

3. **Adjust the weight.** Edit the offending entry in
   `SIGNAL_WEIGHTS` (`packages/core/src/score.ts`) — usually *down*, into the
   votable band rather than the auto-action band. Keep the diff to one line and
   note the provenance in the header comment block (as the 2026-06-11 entries do).

4. **Re-run replay and confirm zero unexplained FPs** over the window. If a new
   FP class appears, revert and reconsider.

5. **Ship** the weight diff like any code change.

## Open calibration questions (2026-08-07 audit)

Measured over 226,213 verdicts in 14 days, 4,458 of them enforcement, with 52
distinct confirmed false positives (1.2%). Two demotions shipped the same day
(`velocity` retired as a decider, `IMITABLE_REASON_CODES` capped); these are
what the data raised and did **not** settle:

- **The session window costs 52 LLM calls per action.** 4,260 calls produced 81
  enforcement actions (1.9%) — 52% of all fresh classifier calls for 1.8% of the
  enforcement. It is not wrong: it is the only stage that catches text-only
  solicitation, which by construction carries no `contentEvidence` (production
  16:01:16 scored 0.14 and the window banned it at 1.00). Whether that price is
  right is a budget decision, and `SESSION_SOLO_MAX_INCHAT` is the dial.
- **A session verdict outranks the trust signals.** It hands the model's `pSpam`
  straight to `policyFor`, so `established_user` (-1.5) and `is_reply` (-1) are
  telemetry, not input (production 16:42:50: an established member muted over
  five lines of conversation). The imitable ceiling caught that one; the general
  case — a session verdict on somebody the signals vouch for — is untouched.
- **Toxicity has nowhere to go.** The reason codes are all spam codes, so abuse
  arrives as `other_spam` at 0.99 and bans on 0 content evidence (production
  2026-08-07 15:11:42). The model is not wrong so much as unequipped: give it a
  code for "hostile, not spam" and the ladder can decide whether that is even
  our business.
- **`external_ban_new` is 9 of the 52.** Second-largest FP source after the
  demoted stages, and nothing in the message earns it — the listing is about the
  account. Candidate for the same treatment: believe the listing, cap what it
  may do alone. Unchanged as of 2026-08-08: still 52% of all bans (122 of 234 in
  a day), still nothing in the message behind them.

### Closed 2026-08-19: the session path now reads standing

The second question above is closed for the general case. `capVouchedSession`
holds ANY session verdict to `observe` plus a chat vote when `hasSenderStanding`
holds — not only the three imitable codes, because the thing being fixed is a
stage with no evidence bar rather than an act ordinary members also perform.

What raised it: 2026-08-17/18, 14 session `flood` verdicts. Four were acted on;
of the three then reviewed, two were overturned by the chat 0:3. Eight of the
remaining ten were stopped by the trusted/admin guard in the executor — after
the verdict, not by it, which is why they logged as `skipped` rather than as a
ceiling and did not show up as near-misses in any count.

Still open, and NOT addressed here: one of the two overturned verdicts carried no
standing signal at all (no `established_user`), so nothing in this change would
have caught it. A session verdict on a genuine stranger still rests on one call
over concatenated one-liners with no bar of any kind. The remaining lever is an
evidence band, and the objection in `judgeAccumulated` stands: text-only
solicitation carries no `contentEvidence`, so any band above 0 retires that
detection entirely. Unresolved on purpose.

### Followed up 2026-08-08: standing beats message evidence on imitable codes

The second question above is now half-closed. The imitable ceiling shipped on
2026-08-07 lifted whenever `mayRemoveSender` held — and message evidence answers
a question about the message, which on these codes was never the disputed part.
Production 08:58 the next morning: `private_invite_link` +
`promo_in_message_link` = 3.0 units banned an `established_user`, and an admin
undid it in 31 seconds. `hasSenderStanding` now overrides the evidence bar on
these three codes only; measured over every stored verdict it changes 4 of 141
imitable sender-removals, one of them that confirmed FP.

Worth knowing for the next pass, because it defines a population nothing else
sees: **`established_user` is earned by volume (50 messages) while the
established-regular exempt additionally wants 7 days of local tenure.** Both
reversals of 2026-08-07/08 sat in that gap — 172 messages first seen 3 days
earlier, 98 messages first seen the same day. Somebody who talks a lot and whom
we have known briefly is exempt from nothing and vouched for by one signal worth
-1.5, which the session path does not read at all.

## What is NOT in scope

No background job rewrites `score.ts`. The "calibration loop" is: feedback
accrues automatically → a human runs steps 1–5 → a reviewed diff ships. The
only code support is `MongoStore.falsePositivesByRule` (step 1) and the replay
tool (steps 2/4).
