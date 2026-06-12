# LyAdminBot v2

Full rewrite on mtcute (MTProto, no Bot API). TypeScript, pnpm workspaces.

## Layout

| Package | Role |
|---|---|
| `packages/core` | Pure pipeline: signals → score (calibrated pSpam) → policy. Zero IO imports — replayable offline. |
| `packages/adapters` | mtcute gateway, TL→NormalizedMessage normalizer, enrichment (call budget), verdict executor with safety invariants. |
| `packages/data` | Mongo repos (byte-compatible with v1), signature/vector/moderation/LLM/velocity/session ports. |
| `packages/ui` | Typed locales (uk/en reference), compact notification views, PM-only settings. |
| `apps/bot` | Composition root. `pnpm start` (tsx). |
| `tools/replay` | Cutover gate: replays prod modevents through the v2 core offline. |
| `tools/spike` | Live MTProto bot-session capability verification. |

## Commands

```bash
pnpm install
pnpm test        # vitest, all packages
pnpm typecheck   # tsc --build, strict
cd apps/bot && pnpm start          # needs env (below)
cd tools/replay && pnpm replay -- --days 14   # needs MONGODB_URI
```

## Environment

Required: `API_ID`, `API_HASH`, `BOT_TOKEN`, `MONGODB_URI`.
Optional (stage degrades gracefully when absent): `QDRANT_URL`, `QDRANT_API_KEY`,
`OPENAI_API_KEY` (embeddings + moderation), `OPENROUTER_API_KEY`,
`LLM_CHEAP_MODEL`, `LLM_STRONG_MODEL`, `SESSION_PATH`.

## Cutover protocol (do not skip)

1. Run `tools/replay` over ≥2 weeks of production modevents — investigate
   every "v2 would act where v1 did not" line until zero unexplained FPs.
2. One week with the test bot in a live test group.
3. 48h on conservative thresholds (`soft` preset) after big-bang switch.
4. Keep v1 deployable for ≥1 month.

## Data compatibility

Same Mongo database and collections as v1 (additive-only). New collections:
`pipeline_decisions` (TTL 90d), `pipeline_feedback` (permanent), `llm_cache`
(TTL 7d). Signature hashing is a byte-compatible port of v1 — do NOT change
normalization without a migration.
