/**
 * Account-age curve calibrator.
 *
 * Rebuilds the anchor table for packages/adapters/src/account-age.ts from
 * sources.json. Two kinds of input:
 *
 *  - observations: (id, unix) pairs that approximate the registration moment
 *    (audits, external datasets). Noisy in both directions, so they are fitted
 *    with isotonic regression (PAVA): the least-squares NON-DECREASING curve.
 *    That kills id→time inversions instead of interpolating through them.
 *
 *  - constraints: (id, unix) pairs where the account was SEEN ALIVE at that
 *    moment — registration cannot be later. Enforced after the fit with a
 *    right-to-left running-min sweep, which keeps the curve monotone while
 *    pulling it under every hard bound.
 *
 * Ids >= 7e9 live in RANDOMIZED allocation blocks (discovered 2026-08-06):
 * Telegram opens a range and hands out ids randomly across it until the
 * daily-max id pins at the block ceiling, then the next block opens. Inside
 * a block the id carries no date information, so the runtime reports the
 * whole block window instead of a curve value. Block openings are derived
 * here as the earliest first-seen inside each range.
 *
 * Uncertainty bands are p90 absolute residuals of observations vs the final
 * curve, per id era (sequential era only). The Theil–Sen slope is printed as
 * a diagnostic; the runtime no longer extrapolates by rate.
 *
 * Usage: node tools/account-age-calibrate/calibrate.mjs
 * Output: stats to stderr, ready-to-paste TS constants to stdout.
 * To refresh the frontier, re-harvest sources.json from prod (see README).
 */
import { readFileSync } from 'node:fs'

const sources = JSON.parse(readFileSync(new URL('sources.json', import.meta.url)))
const day = (u) => new Date(u * 1000).toISOString().slice(0, 10)
const log = (...a) => console.error(...a)

const allObservations = Object.values(sources.observations).flat()
const allConstraints = Object.values(sources.constraints).flat()

// ── 0. Randomized blocks (>= 7e9): ids inside carry no date info ──────
// Block opening = earliest first-seen inside it (across all sources);
// closing = the next block's opening; the last block is active (null).
const blockRanges = sources.randomizedBlocks
const BLOCK_ERA_START = blockRanges[0][0]
const allRows = [...allObservations, ...allConstraints]
const blocks = blockRanges.map(([lo, hi]) => {
  const inBlock = allRows.filter(([id]) => id >= lo && id < hi).map(([, t]) => t)
  if (!inBlock.length) throw new Error(`block ${lo}..${hi} has no data rows`)
  return [lo, hi, Math.min(...inBlock)]
})
for (let i = 1; i < blocks.length; i++) {
  if (blocks[i][2] <= blocks[i - 1][2]) throw new Error(`non-monotone block openings @${blocks[i][0]}`)
  if (blocks[i][0] !== blocks[i - 1][1]) throw new Error(`hole between blocks @${blocks[i][0]}`)
}
const blockRows = blocks.map(([lo, hi, open], i) => [lo, hi, open, i + 1 < blocks.length ? blocks[i + 1][2] : null])
for (const [lo, hi, open, close] of blockRows)
  log(`Block ${lo}..${hi}: ${day(open)} .. ${close ? day(close) : 'active'}`)
const lastEvidence = Math.max(...allRows.map(([, t]) => t))
log(`Latest evidence in data: ${day(lastEvidence)}`)

// The curve is fitted over the sequential era only (< first block)
const observations = allObservations.filter(([id]) => id < BLOCK_ERA_START)
const constraints = allConstraints.filter(([id]) => id < BLOCK_ERA_START)

// ── 1. PAVA (pool adjacent violators) over observations ──────────────
// Group by id (mean for duplicates), sort, then merge adjacent pools
// until the pool means are non-decreasing.
const byId = new Map()
for (const [id, t] of observations) {
  const e = byId.get(id) ?? { sum: 0, n: 0 }
  e.sum += t; e.n += 1
  byId.set(id, e)
}
const pts = [...byId.entries()]
  .map(([id, { sum, n }]) => ({ id, t: sum / n, w: n }))
  .sort((a, b) => a.id - b.id)

const pools = []
for (const p of pts) {
  pools.push({ ids: [p.id], sum: p.t * p.w, w: p.w })
  while (pools.length > 1) {
    const b = pools[pools.length - 1]
    const a = pools[pools.length - 2]
    if (a.sum / a.w <= b.sum / b.w) break
    a.ids.push(...b.ids); a.sum += b.sum; a.w += b.w
    pools.pop()
  }
}
let knots = pools.flatMap((b) => b.ids.map((id) => [id, b.sum / b.w]))
// Terminal knot: at the start of the block era the curve equals the first
// block's opening — a seam with no discontinuity.
knots.push([BLOCK_ERA_START, blockRows[0][2]])
log(`PAVA: ${pts.length} points → ${pools.length} pools (${pts.length - pools.length} inversions merged)`)

// ── 2. Constraints: inserted as knots + right-to-left running-min ─────
const interp = (table, id) => {
  if (id <= table[0][0]) return table[0][1]
  if (id >= table[table.length - 1][0]) return table[table.length - 1][1]
  let lo = 0, hi = table.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (table[m][0] <= id) lo = m; else hi = m
  }
  const [x0, y0] = table[lo], [x1, y1] = table[hi]
  return y0 + ((id - x0) / (x1 - x0)) * (y1 - y0)
}

// Constraint-knot values are computed against a FROZEN copy of the PAVA
// table: inserting into the live array would break the binary search
// (the array would no longer be sorted).
const pavaTable = knots.map(([id, t]) => [id, t])
let binding = 0
const constraintKnots = constraints.map(([id, t]) => {
  const cur = interp(pavaTable, id)
  if (t < cur - 1) binding++
  return [id, Math.min(cur, t)]
})
knots = knots.concat(constraintKnots).sort((a, b) => a[0] - b[0])
// Dedupe by id: these are upper bounds, so the smaller time wins.
const dedup = []
for (const [id, t] of knots) {
  const last = dedup[dedup.length - 1]
  if (last && last[0] === id) last[1] = Math.min(last[1], t)
  else dedup.push([id, t])
}
knots = dedup
let cap = Infinity
for (let i = knots.length - 1; i >= 0; i--) {
  cap = Math.min(cap, knots[i][1])
  knots[i][1] = cap
}
log(`Constraints: ${constraints.length}, binding (pull the curve down): ${binding}`)

// ── 3. Thinning: collinear knots (neighbor interpolation within 2 days).
// Constraint knots are always kept — removing one could lift the curve
// above a hard bound between its neighbors.
const constraintIds = new Set(constraints.map(([id]) => id))
const before = knots.length
for (let i = knots.length - 2; i > 0; i--) {
  if (constraintIds.has(knots[i][0])) continue
  const [x0, y0] = knots[i - 1], [x, y] = knots[i], [x1, y1] = knots[i + 1]
  const lin = y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  if (Math.abs(lin - y) < 2 * 86400) knots.splice(i, 1)
}
log(`Thinned: ${before} → ${knots.length} knots`)

// ── 4. Theil–Sen slope over knots of the last ~550 days (diagnostic) ──
const tail = knots.filter(([, t]) => t >= knots[knots.length - 1][1] - 550 * 86400)
const slopes = []
for (let i = 0; i < tail.length; i++)
  for (let j = i + 1; j < tail.length; j++) {
    const dt = tail[j][1] - tail[i][1]
    if (dt > 86400) slopes.push((tail[j][0] - tail[i][0]) / dt)
  }
slopes.sort((a, b) => a - b)
const idsPerSec = slopes[Math.floor(slopes.length / 2)]
log(`Theil–Sen (last ${tail.length} knots): ${idsPerSec.toFixed(1)} ids/s (${slopes.length} pairwise slopes)`)

// ── 5. Uncertainty bands: p90 |observation residual| per era ──────────
const ERAS = [
  [2.2e9, 'pre-2^31'],
  [BLOCK_ERA_START, '5e9..7e9'],
]
const bandRows = []
for (let e = 0; e < ERAS.length; e++) {
  const lo = e === 0 ? 0 : ERAS[e - 1][0]
  const res = observations
    .filter(([id]) => id >= lo && id < ERAS[e][0])
    .map(([id, t]) => Math.abs(t - interp(knots, id)))
    .sort((a, b) => a - b)
  // 7-day floor: p90 ≈ 0 happens when the observations themselves defined
  // the curve, which does not mean zero error for neighboring ids.
  const p90 = Math.max(res.length ? res[Math.floor(0.9 * (res.length - 1))] : 45 * 86400, 7 * 86400)
  bandRows.push([ERAS[e][0], Math.round(p90)])
  log(`Band ${ERAS[e][1]}: n=${res.length}, p90=${(p90 / 86400).toFixed(0)}d`)
}

// ── 6. Sanity checks ──────────────────────────────────────────────────
for (let i = 1; i < knots.length; i++)
  if (knots[i][1] < knots[i - 1][1]) throw new Error(`non-monotone @${knots[i][0]}`)
for (const [id, t] of constraints)
  if (interp(knots, id) > t + 1) throw new Error(`violated constraint @${id}`)
const GAP_LO = 2147483648, GAP_HI = 5000000000
for (const [id] of knots)
  if (id >= GAP_LO && id < GAP_HI) throw new Error(`knot inside the gap @${id}`)
log(`Sanity: monotonicity ✓, constraints ✓, gap empty ✓`)
log(`Curve range: ${day(knots[0][1])} .. ${day(knots[knots.length - 1][1])} (last knot id=${knots[knots.length - 1][0]})`)

// ── 7. TS constants emission ──────────────────────────────────────────
let prevYear = null
const rows = knots.map(([id, t]) => {
  const year = new Date(t * 1000).getUTCFullYear()
  const tag = year !== prevYear ? ` // ${year}` : ''
  prevYear = year
  return `  [${id}, ${Math.round(t)}],${tag}`
}).join('\n')
console.log(`const ANCHORS: readonly (readonly [number, number])[] = [\n${rows}\n]\n`)
console.log(`const UNCERTAINTY_BANDS: readonly (readonly [number, number])[] = [`)
for (const [limit, w] of bandRows)
  console.log(`  [${limit}, ${w}],`)
console.log(`]\n`)
console.log(`/** [idLo, idHi, openUnix, closeUnix|null] — null means the block is still active. */`)
console.log(`const RANDOMIZED_BLOCKS: readonly (readonly [number, number, number, number | null])[] = [`)
for (const [lo, hi, open, close] of blockRows)
  console.log(`  [${lo}, ${hi}, ${open}, ${close}], // ${day(open)} .. ${close ? day(close) : 'active'}`)
console.log(`]\n`)
console.log(`const LAST_EVIDENCE_UNIX = ${lastEvidence}`)
