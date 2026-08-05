# account-age-calibrate

Regenerates the calibration tables for `packages/adapters/src/account-age.ts`.

```sh
node tools/account-age-calibrate/calibrate.mjs
# stderr — diagnostics (PAVA, constraints, blocks, Theil–Sen, bands)
# stdout — ready-to-paste TS block: ANCHORS + UNCERTAINTY_BANDS
#          + RANDOMIZED_BLOCKS + LAST_EVIDENCE_UNIX
```

The generated block goes into `account-age.ts` between the doc header and
`TRANSITION_GAP_START`. After pasting, run the adapters tests — the
`account-age.fixtures.ts` fixture checks the model against the production
first-seen envelope.

## Data model (sources.json)

- **observations** — `(id, unix)` pairs approximating the registration
  moment. Noisy in both directions → isotonic regression (PAVA).
- **constraints** — `(id, unix)` pairs where the account was *seen alive*:
  registration is not later than that. Hard upper bounds → right-to-left
  running-min sweep after the fit.
- **randomizedBlocks** — boundaries of the block era (>= 7e9). Openings are
  derived from the data (min first-seen inside the block); a block's close
  is the next block's opening.

The largest id seen per day by a big-funnel bot (~100k new users/day) is
practically the registration itself: such rows go into both observations
and constraints. Daily maxima of small bots are constraints only — their
frontier lags behind the global one.

## Refreshing from production (every 1–2 months)

First-seen envelope per id bucket (collections with `createdAt`):

```js
db.getCollection(COL).aggregate([
  { $match: { [ID_FIELD]: { $gt: 1000000, $type: 'number' }, createdAt: { $exists: true } } },
  { $project: { id: '$' + ID_FIELD, createdAt: 1, b: { $floor: { $divide: ['$' + ID_FIELD, 100000000] } } } },
  { $group: { _id: '$b', doc: { $top: { sortBy: { createdAt: 1 }, output: ['$id', '$createdAt'] } } } },
  { $sort: { _id: 1 } }
], { allowDiskUse: true })
```

Daily id maxima (new frontier anchors):

```js
db.pipeline_decisions.aggregate([
  { $match: { userId: { $gt: 1000000 } } },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, maxId: { $max: '$userId' } } },
  { $sort: { _id: 1 } }
])
```

Add the results as new keys in `observations`/`constraints` of sources.json
(key = source + harvest date) and re-run the calibrator. Do not delete old
keys — the curve learns from the whole history. Extra first-seen databases
(e.g. other bots' users collections on the same server) merge the same way
as constraints; if the database is "live" (records new users immediately),
its fresh tail can also be fed as observations.

When the daily-max id jumps past the current block ceiling, a new block has
opened: append its `[idLo, idHi]` to `randomizedBlocks`.

## Calibrated as of 2026-08-06

- Sources: v1 cross-bot audit + external dataset + first-seen envelopes of
  LyAdminBot (594k docs) and QuoteBot (28.7M users) + two bots' frontiers +
  2 accounts with owner-confirmed registration dates
- Sequential era (< 7e9): 124 observations → PAVA, 126 constraints
  (79 binding); p90 bands: 47d (pre-2^31), 138d (5–7e9)
- Block era: 8 blocks from 2024-02-19 (7.0–7.2e9) to the active 8.8–9.0e9
  (opened 2026-05-12); openings independently confirmed by both envelopes
  to within a day
- Verified empirically (sub-bucket envelope test, 2026-08-06): allocation
  inside a block is uniform across the whole range from day one — the id
  carries no date information beyond block membership
- The 9e9 ceiling is not yet broken: both bots' daily maxima have been
  pinned at 8.9999e9 since mid-May
