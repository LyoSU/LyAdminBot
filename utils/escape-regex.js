/**
 * Escape special regex characters in a string
 * Prevents ReDoS attacks when using user input in RegExp
 */
const escapeRegex = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = escapeRegex
