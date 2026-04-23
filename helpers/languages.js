// Single source of truth for supported UI locales. Used by both the global
// /start lang picker (helpers/menu/screens/lang-picker.js) and the group
// /settings lang screen (helpers/menu/screens/settings.js). If you're adding
// a locale: add the YAML file under locales/, add the entry here, done.

const LANGUAGES = [
  { code: 'uk', name: 'Українська' },
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'by', name: 'Беларуская' }
]

const LANGUAGE_CODES = LANGUAGES.map(l => l.code)

const languageName = (code) => {
  const match = LANGUAGES.find(l => l.code === code)
  return match ? match.name : 'English'
}

const isKnownLanguage = (code) => LANGUAGE_CODES.includes(code)

module.exports = { LANGUAGES, LANGUAGE_CODES, languageName, isKnownLanguage }
