/**
 * Signature hashing — BYTE-COMPATIBLE port of v1 helpers/spam-signatures.js.
 *
 * Compatibility is a hard requirement: v2 must match the 7k+ signatures
 * already in production Mongo. Do not "improve" the normalization without
 * a migration plan — any change silently orphans every existing hash.
 */
import { createHash } from 'node:crypto'

export const normalizeLight = (text: string): string => {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export const normalizeHeavy = (text: string): string => {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(/@[\w]+/g, '@_')
    .replace(/https?:\/\/[^\s]+/gi, '_URL_')
    .replace(/t\.me\/[\w+]+/gi, '_URL_')
    .replace(/\d+([.,]\d+)?/g, '_NUM_')
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[$€£₴₽¥]/g, '_CUR_')
    .replace(/\s+/g, ' ')
    .trim()
}

/** v1 truncates sha256 hex to 32 chars — keep identical. */
export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex').substring(0, 32)

export interface SignatureHashes {
  exactHash: string
  normalizedHash: string | null
}

const MIN_HEAVY_NORM_LENGTH = 5

/** Compute lookup hashes the same way v1 computes storage hashes. */
export const computeSignatureHashes = (text: string): SignatureHashes | null => {
  const lightNorm = normalizeLight(text)
  if (!lightNorm) return null
  const heavyNorm = normalizeHeavy(text)
  // Guard against the emoji-only collision bug (all-emoji text collapses
  // to an empty heavy norm — hashing it would match unrelated messages).
  const hasEnoughNormalized = heavyNorm.length >= MIN_HEAVY_NORM_LENGTH
  return {
    exactHash: sha256(lightNorm),
    normalizedHash: hasEnoughNormalized ? sha256(heavyNorm) : null
  }
}
