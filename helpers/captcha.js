// Pure logic for emoji-noun captcha challenges.
//
// Two operations:
//   generateChallenge(kind) → { kind, correctEmoji, correctNameKey, options }
//     options = 1 correct + 5 random decoys, shuffled. The *helper* doesn't
//     persist anything; the row that owns the challenge is the
//     `Captcha` model — its `consume()` / `findActive()` cover the DB side.
//
//   verifyChallenge(captcha, pickedEmoji)
//     Pure check against a Captcha row. Decrements `attemptsLeft` in-place
//     so the caller can `.save()` once and avoid double round-trips.
//     Returns { ok, attemptsLeft, correctEmoji }. The caller is responsible
//     for calling `Captcha.consume(challengeId)` on success — verifyChallenge
//     itself doesn't touch the DB.

const POOL = [
  { emoji: '🍌', nameKey: 'captcha.emoji.banana' },
  { emoji: '🍎', nameKey: 'captcha.emoji.apple' },
  { emoji: '🚗', nameKey: 'captcha.emoji.car' },
  { emoji: '⭐', nameKey: 'captcha.emoji.star' },
  { emoji: '🐶', nameKey: 'captcha.emoji.dog' },
  { emoji: '🐱', nameKey: 'captcha.emoji.cat' },
  { emoji: '☀️', nameKey: 'captcha.emoji.sun' },
  { emoji: '🌙', nameKey: 'captcha.emoji.moon' },
  { emoji: '❤️', nameKey: 'captcha.emoji.heart' },
  { emoji: '🔥', nameKey: 'captcha.emoji.fire' },
  { emoji: '📕', nameKey: 'captcha.emoji.book' },
  { emoji: '🔑', nameKey: 'captcha.emoji.key' },
  { emoji: '🌳', nameKey: 'captcha.emoji.tree' },
  { emoji: '🏠', nameKey: 'captcha.emoji.house' },
  { emoji: '⏰', nameKey: 'captcha.emoji.clock' }
]

const OPTION_COUNT = 6

// Fisher-Yates on a shallow copy. Math.random is fine: the captcha is
// rate-limited (3 attempts per challenge) and the row is dedup'd per user,
// so brute-forcing a uniform 1/6 with limited tries is the actual upper
// bound, not the RNG quality.
const shuffle = (arr) => {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp
  }
  return out
}

const generateChallenge = (kind) => {
  if (kind && typeof kind !== 'string') {
    throw new TypeError('captcha.generateChallenge: kind must be a string')
  }
  // 1 correct + 5 distinct decoys, then shuffle the union.
  const shuffled = shuffle(POOL)
  const correct = shuffled[0]
  const decoys = shuffled.slice(1, OPTION_COUNT)
  const options = shuffle([correct, ...decoys])
  return {
    kind: kind || null,
    correctEmoji: correct.emoji,
    correctNameKey: correct.nameKey,
    options
  }
}

// In-place decrement. Mirrors Mongoose subdoc semantics so the caller can
// `await captcha.save()` after the check.
const verifyChallenge = (captcha, pickedEmoji) => {
  if (!captcha) {
    return { ok: false, attemptsLeft: 0, correctEmoji: null }
  }
  const correctEmoji = captcha.correctEmoji
  if (!pickedEmoji || typeof pickedEmoji !== 'string') {
    return { ok: false, attemptsLeft: captcha.attemptsLeft || 0, correctEmoji }
  }
  if (pickedEmoji === correctEmoji) {
    return { ok: true, attemptsLeft: captcha.attemptsLeft || 0, correctEmoji }
  }
  const remaining = Math.max(0, (captcha.attemptsLeft || 0) - 1)
  captcha.attemptsLeft = remaining
  return { ok: false, attemptsLeft: remaining, correctEmoji }
}

module.exports = {
  POOL,
  OPTION_COUNT,
  generateChallenge,
  verifyChallenge
}
