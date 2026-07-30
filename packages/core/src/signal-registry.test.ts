/**
 * Cross-checks the signal vocabulary against itself.
 *
 * Why this file exists: `scoreSignals` reads `SIGNAL_WEIGHTS[name] ?? 0`. That
 * fallback keeps a stray name from crashing the pipeline, but it also means a
 * signal nobody remembered to weight scores ZERO in complete silence. On
 * 2026-07-27 four of them were in that state — `moderation_flagged`,
 * `signature_candidate_match`, `vector_similar_spam`, `bot_mention` — so the
 * bot paid for Qdrant, OpenAI and signature lookups whose answers were then
 * discarded, while `hasDecisiveSignal` still counted them and suppressed the
 * LLM escalation that would have caught the message.
 *
 * These are static checks over the source: no unit test would notice, because
 * every individual module was behaving exactly as written.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SIGNAL_GROUP_CAPS, SIGNAL_WEIGHTS, SOFT_SHAPE_SIGNALS, hasDecisiveSignal, DECISIVE_MIN_WEIGHT
} from './score.js'

/** `{ name: 'newness', cap: … }` group descriptors are not signals. */
const GROUP_NAMES = new Set(SIGNAL_GROUP_CAPS.map((g) => g.name))

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

const sourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const SOURCES = sourceFiles(SRC_DIR).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

/** Every `{ name: 'x' }` a production module can push into the signal list. */
const producedSignals = (): Map<string, string> => {
  const found = new Map<string, string>()
  for (const { path, text } of SOURCES) {
    for (const [, name] of text.matchAll(/name: '([a-z_0-9]+)'/g)) {
      if (name && !GROUP_NAMES.has(name) && !found.has(name)) found.set(name, path)
    }
  }
  return found
}

/** Signals a production module marks as trust signals. */
const negativeSignals = (): Set<string> => {
  const found = new Set<string>()
  for (const { text } of SOURCES) {
    for (const [, name] of text.matchAll(/name: '([a-z_0-9]+)', negative: true/g)) {
      if (name) found.add(name)
    }
  }
  return found
}

describe('signal registry', () => {
  it('every produced signal carries a weight', () => {
    const orphans = [...producedSignals()]
      .filter(([name]) => !(name in SIGNAL_WEIGHTS))
      .map(([name, path]) => `${name} (${path.replace(SRC_DIR, '')})`)

    expect(orphans, 'signals produced by the pipeline but silently scored 0').toEqual([])
  })

  it('every weight has a producer', () => {
    const produced = producedSignals()
    const dead = Object.keys(SIGNAL_WEIGHTS).filter((name) => !produced.has(name))

    expect(dead, 'weights nothing can ever raise — dead calibration surface').toEqual([])
  })

  it('trust signals and negative weights agree', () => {
    const negatives = negativeSignals()
    const negativeWeights = Object.keys(SIGNAL_WEIGHTS).filter((n) => (SIGNAL_WEIGHTS[n] ?? 0) < 0)

    // A signal with a negative weight that is NOT pushed with `negative: true`
    // is the dangerous direction: `hasDecisiveSignal` would treat this trust
    // signal as evidence of spam and let the pipeline enforce on it.
    expect(negativeWeights.filter((n) => !negatives.has(n)),
      'negative weight but not marked `negative: true`').toEqual([])
    expect([...negatives].filter((n) => (SIGNAL_WEIGHTS[n] ?? 0) >= 0),
      'marked `negative: true` but does not lower the score').toEqual([])
  })

  it('soft-shape signals all exist and none is a trust signal', () => {
    for (const name of SOFT_SHAPE_SIGNALS) {
      expect(SIGNAL_WEIGHTS[name], `${name} is soft-shape but unweighted`).toBeDefined()
      expect(SIGNAL_WEIGHTS[name] ?? 0, `${name} is soft-shape but negative`).toBeGreaterThan(0)
    }
  })

  it('soft-shape signals alone are never decisive', () => {
    const all = [...SOFT_SHAPE_SIGNALS].map((name) => ({ name }))
    expect(hasDecisiveSignal(all)).toBe(false)
  })

  /** Message-evidence signals too light to license enforcement on their own. */
  const NUDGES = [
    'bot_mention', 'edited_message', 'external_url', 'guest_bot_delivery',
    'long_text', 'restricted_flag', 'story_share', 'unknown_media'
  ]

  it('the list of sub-threshold nudges is exactly the one we intend', () => {
    // Listed by hand so that adding a light signal is a decision rather than an
    // accident: a new signal under DECISIVE_MIN_WEIGHT silently changes whether
    // a soft-shape stack may enforce, which is how the 2026-07-30 kick happened
    // (`edited_message`, weight 0.2, counted as proof about the message).
    const belowBar = Object.keys(SIGNAL_WEIGHTS)
      .filter((n) => {
        const w = SIGNAL_WEIGHTS[n] ?? 0
        return w > 0 && !SOFT_SHAPE_SIGNALS.has(n) && w < DECISIVE_MIN_WEIGHT
      })
      .sort()
    expect(belowBar).toEqual([...NUDGES].sort())
  })

  it('every content signal at or above the bar is decisive on its own', () => {
    const decisive = Object.keys(SIGNAL_WEIGHTS).filter((n) =>
      (SIGNAL_WEIGHTS[n] ?? 0) >= DECISIVE_MIN_WEIGHT && !SOFT_SHAPE_SIGNALS.has(n))
    expect(decisive.length).toBeGreaterThan(0)
    for (const name of decisive) {
      expect(hasDecisiveSignal([{ name }]), `${name} should be decisive`).toBe(true)
    }
  })

  it('no nudge can enforce, alone or piled on sender shape', () => {
    const shape = [...SOFT_SHAPE_SIGNALS].map((name) => ({ name }))
    for (const name of NUDGES) {
      expect(hasDecisiveSignal([{ name }]), name).toBe(false)
      expect(hasDecisiveSignal([...shape, { name }]), `${name} + shape`).toBe(false)
    }
  })

  it('trust signals never count as decisive evidence', () => {
    for (const name of negativeSignals()) {
      expect(hasDecisiveSignal([{ name, negative: true }]), `${name}`).toBe(false)
    }
  })
})
