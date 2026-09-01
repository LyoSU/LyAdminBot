/**
 * The API's own name for a refusal, and nothing else.
 *
 * Failures on this codebase's moderation paths are caught into booleans — a
 * mute that did not happen, a whisper that did not send — and a boolean cannot
 * be audited. Production 2026-09-01 produced three of them in one day: 32
 * `undeliverable` captchas naming no cause, a quorum whose enforcement half
 * failed with `muted: false` in a chat that plainly had the rights, and an
 * account-screen hold that could only say it did not go on.
 *
 * A whitelist of SHAPE rather than a slice of the message, because an error
 * string is the one place a stranger's own text can end up inside an exception,
 * and this value is stored. `Telegram API error 400: USER_NOT_PARTICIPANT`
 * becomes `USER_NOT_PARTICIPANT`; anything that does not look like a wire error
 * name becomes `unknown`, which is honest and cannot leak.
 */
export const telegramErrorName = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err)
  // Underscore-joined SCREAMING_SNAKE only: a bare word in caps is something
  // somebody shouted, and mtcute's own error classes are PascalCase.
  const wire = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(text)
  if (wire?.[1]) return wire[1]
  // mtcute raises typed errors of its own — `MtPeerNotFoundError` — and the
  // class name is the whole of what they say that is worth keeping.
  const klass = err instanceof Error && /^Mt[A-Za-z]{3,60}Error$/.test(err.name) ? err.name : null
  return klass ?? 'unknown'
}
