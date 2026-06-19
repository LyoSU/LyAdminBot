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

- **`pipeline_decisions`** (TTL 90d) — every verdict: `pSpam`, `action`,
  `decidedBy`, `ruleId`, `signals` (names), `reasonCode`.
- **`pipeline_feedback`** (permanent) — `override_not_spam` rows: each is an
  admin-confirmed **false positive** (someone hit the override). `/untrust`
  and ham votes feed the same signal.

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

## What is NOT in scope

No background job rewrites `score.ts`. The "calibration loop" is: feedback
accrues automatically → a human runs steps 1–5 → a reviewed diff ships. The
only code support is `MongoStore.falsePositivesByRule` (step 1) and the replay
tool (steps 2/4).
