/**
 * Reading a sender's cadence: the same account posting at a steady interval for
 * a long run, with nothing typed in any of the messages.
 *
 * Shadow only. Nothing here reaches the scorer — it exists so the pattern can be
 * counted on production before it is allowed to weigh anything. A person is
 * irregular: they answer, wander off, come back. A script on a timer is not, and
 * `burst` cannot see it because its window is minutes and its distinctness is
 * measured on text, which a sticker does not have.
 */

/** Messages before the cadence is read — five intervals. */
const METRONOME_MIN_MESSAGES = 6
/** Intervals shorter than this are a flood, which `burst` already reads. */
const METRONOME_MIN_GAP_MS = 20_000
/** Intervals longer than this are a different visit, not a cadence. */
const METRONOME_MAX_GAP_MS = 3_600_000
/** Spread of the intervals relative to their mean; human gaps sit far above it. */
const METRONOME_MAX_CV = 0.25

export interface MetronomeShape {
  messages: number
  meanGapSec: number
  cv: number
}

/**
 * The cadence of `times` (ms, any order), or null when it is not a metronome.
 *
 * Duplicate instants collapse first: an album or an edit is one act, not a
 * zero-length interval.
 */
export const metronomeShape = (times: readonly number[]): MetronomeShape | null => {
  const sorted = [...new Set(times)].sort((a, b) => a - b)
  if (sorted.length < METRONOME_MIN_MESSAGES) return null
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!)
  if (gaps.some((g) => g < METRONOME_MIN_GAP_MS || g > METRONOME_MAX_GAP_MS)) return null
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length)
  const cv = sd / mean
  if (cv > METRONOME_MAX_CV) return null
  return { messages: sorted.length, meanGapSec: Math.round(mean / 1000), cv: Math.round(cv * 1000) / 1000 }
}
