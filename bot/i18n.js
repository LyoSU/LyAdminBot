// Single source of truth for the telegraf-i18n configuration.
//
// Both bot.js (production) and the test suite import this so that
// everything wired through `i18n.t` / `i18n.createContext` resolves
// `${e.*}` placeholders the same way. Before this module existed,
// every test file rebuilt its own `new I18n({...})` config and
// stitched `e: emojiMap` in by hand — which let production-only
// wiring bugs (the 2026-04-27 "Failed to compile template" outage)
// slip past CI because the tests didn't actually exercise the same
// I18n instance the bot uses.

const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales')

/**
 * Build a telegraf-i18n instance with the production configuration.
 *
 * `e: emojiMap` lives in the global `templateData` so EVERY
 * I18nContext (middleware-attached or background-job) can resolve
 * `${e.*}`. `defaultLanguageOnMissing` lets non-EN locales degrade
 * gracefully to English instead of returning bare keys.
 *
 * @returns {I18n}
 */
const createI18n = () => new I18n({
  directory: LOCALES_DIR,
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true,
  templateData: { e: emojiMap }
})

module.exports = {
  createI18n,
  LOCALES_DIR
}
