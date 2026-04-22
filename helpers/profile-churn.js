const { analyzeBio, analyzeUrls } = require('./profile-signals')

/**
 * Profile-churn detectors — bio + business intro.
 *
 * All signals are STRUCTURAL (URLs, mentions, invisible chars, length,
 * character-class density). No keyword or language lists.
 *
 * Why this matters: profile metadata changes are one of the strongest
 * campaign-level signals we can observe, because an attacker rotating bios
 * across a stolen-account pool leaves a clean temporal fingerprint
 * (previously empty or plain, suddenly contains links).
 *
 *   - bio_churn_to_promo:  previous bio had no URLs/mentions, new bio has.
 *                          Strong "account was repurposed" signal.
 *   - bio_structural_promo: bio analysis flags it as promotional on its own
 *                          (relies on profile-signals.analyzeBio, already
 *                          keyword-free).
 *   - business_intro_structural_promo: business_intro contains URL / >=2
 *                          mentions / invisibles. Business intros exist to
 *                          describe a business — spammers abuse them with
 *                          ads instead.
 *
 * Verdict combinations (only the ones used by deterministic layer here):
 *
 *   Rule: bio_churn_new_promo
 *     - bioHistory has >=1 previous value
 *     - new bio is structurally promotional
 *     - previous bio was NOT structurally promotional
 *     Confidence 85. Only fires when the delta is structural.
 *
 *   Rule: business_intro_promo
 *     - businessIntro.text is structurally promotional
 *     Confidence 80. Stand-alone signal: no legitimate user weaponises
 *     business_intro for external links.
 */

const NAME_DIVERSITY_THRESHOLD = 0.3

const isBioStructuralPromo = (bio) => {
  const a = analyzeBio(bio)
  return Boolean(a && a.structuralPromo)
}

/**
 * Analyze bio-history on the user document and look for promo-escalation.
 * Requires `userInfo.bio.text` (current) + `userInfo.bio.history[]` (prev).
 */
const analyzeBioChurn = (userInfo) => {
  const bio = userInfo?.bio
  if (!bio || !Array.isArray(bio.history) || bio.history.length === 0) return null

  const currentText = bio.text || ''
  const previousText = bio.history[0]?.value || ''
  const currentPromo = isBioStructuralPromo(currentText)
  const previousPromo = isBioStructuralPromo(previousText)

  return {
    currentText,
    previousText,
    changedTo: currentPromo && !previousPromo,
    changedFrom: !currentPromo && previousPromo,
    currentPromo,
    previousPromo,
    changesRecorded: bio.history.length
  }
}

/**
 * Analyse business_intro.text for structural promo evidence. Works without
 * keyword lists — any URL, >=2 mentions, or invisible chars is a tell.
 */
const analyzeBusinessIntro = (userInfo) => {
  const intro = userInfo?.businessIntro
  if (!intro || !intro.text || typeof intro.text !== 'string' || intro.text.length === 0) {
    return { present: false, structuralPromo: false }
  }
  const urls = analyzeUrls(intro.text)
  const mentions = (intro.text.match(/@[A-Za-z0-9_]{3,}/g) || []).length
  const INVISIBLE = require('./scripts').INVISIBLE_REGEX
  const invisible = INVISIBLE.test(intro.text)
  const structuralPromo = Boolean(urls.total > 0 || mentions >= 2 || invisible)
  return {
    present: true,
    text: intro.text,
    length: intro.text.length,
    urls,
    mentions,
    invisible,
    structuralPromo
  }
}

/**
 * Combined verdict maker. Feeds off a user document + current profile
 * signals. Conservative — only returns a spam verdict when the structural
 * evidence is clear.
 */
const evaluateProfileChurn = (userInfo) => {
  const churn = analyzeBioChurn(userInfo)
  const intro = analyzeBusinessIntro(userInfo)

  const signals = []
  if (churn?.currentPromo) signals.push('bio_structural_promo')
  if (churn?.changedTo) signals.push('bio_churn_to_promo')
  if (intro.structuralPromo) signals.push('business_intro_structural_promo')

  let verdict = null
  if (churn?.changedTo) {
    verdict = {
      decision: 'spam',
      rule: 'bio_churn_new_promo',
      confidence: 85,
      reason: 'Profile bio recently changed from non-promotional to structurally promotional'
    }
  } else if (intro.structuralPromo) {
    verdict = {
      decision: 'spam',
      rule: 'business_intro_promo',
      confidence: 80,
      reason: 'Business intro contains URLs / mentions / invisible characters (structural promo)'
    }
  }

  return { churn, intro, signals, verdict }
}

module.exports = {
  analyzeBioChurn,
  analyzeBusinessIntro,
  evaluateProfileChurn,
  isBioStructuralPromo,
  NAME_DIVERSITY_THRESHOLD
}
