// Account creation prediction data based on Telegram user IDs and registration timestamps
const entries = [
  [1000000, 1380326400], // 2013
  [2768409, 1383264000],
  [7679610, 1388448000],
  [11538514, 1391212000], // 2014
  [15835244, 1392940000],
  [23646077, 1393459000],
  [38015510, 1393632000],
  [44634663, 1399334000],
  [46145305, 1400198000],
  [54845238, 1411257000],
  [63263518, 1414454000],
  [101260938, 1425600000], // 2015
  [101323197, 1426204000],
  [103151531, 1433376000],
  [103258382, 1432771000],
  [109393468, 1439078000],
  [111220210, 1429574000],
  [112594714, 1439683000],
  [116812045, 1437696000],
  [122600695, 1437782000],
  [124872445, 1439856000],
  [125828524, 1444003000],
  [130029930, 1441324000],
  [133909606, 1444176000],
  [143445125, 1448928000],
  [148670295, 1452211000], // 2016
  [152079341, 1453420000],
  [157242073, 1446768000],
  [171295414, 1457481000],
  [181783990, 1460246000],
  [222021233, 1465344000],
  [225034354, 1466208000],
  [278941742, 1473465000],
  [285253072, 1476835000],
  [294851037, 1479600000],
  [297621225, 1481846000],
  [328594461, 1482969000],
  [337808429, 1487707000], // 2017
  [341546272, 1487782000],
  [352940995, 1487894000],
  [369669043, 1490918000],
  [400169472, 1501459000],
  [616816630, 1529625600], // 2018
  [681896077, 1532821500],
  [727572658, 1543708800],
  [796147074, 1541371800],
  [925078064, 1563290000], // 2019
  [928636984, 1581513420], // 2020
  [1054883348, 1585674420],
  [1057704545, 1580393640],
  [1145856008, 1586342040],
  [1227964864, 1596127860],
  [1382531194, 1600188120],
  [1658586909, 1613148540], // 2021
  [1660971491, 1613329440],
  [1692464211, 1615402500],
  [1719536397, 1619293500],
  [1721844091, 1620224820],
  [1772991138, 1617540360],
  [1807942741, 1625520300],
  [1893429550, 1622040000],
  [1972424006, 1631669400],
  [1974255900, 1634000000],
  [2030606431, 1631992680],
  [2041327411, 1631989620],
  [2078711279, 1634321820],
  [2104178931, 1638353220],
  [2120496865, 1636714020],
  [2123596685, 1636503180],
  [2138472342, 1637590800],
  // Removed two synthetic entries:
  //   [3318845111, 1618028800] (2021-04-10) and
  //   [4317845111, 1620028800] (2021-05-03)
  // They were time-going-backwards relative to neighbours (≈Nov 2021),
  // breaking monotonicity and producing absurd interpolation results
  // anywhere in 2.1B–5.16B. Cross-bot probe (fStikBot 20.4M users +
  // QuoteBot 22.9M users) shows ZERO real users in the entire 2.20B–5.00B
  // range — Telegram skipped this id band during the 32→64-bit migration
  // (post-int32-max 2.147B straight to ~5B). The TRANSITION_GAP guard at
  // the top of predictCreationDate now returns '?' for any id in this
  // dead zone instead of letting linear interpolation produce noise.
  [5162494923, 1652449800], // 2022
  [5186883095, 1648764360],
  [5304951856, 1656718440],
  [5317829834, 1653152820],
  [5318092331, 1652024220],
  [5336336790, 1646368100],
  [5362593868, 1652024520],
  [5387234031, 1662137700],
  [5396587273, 1648014800],
  [5409444610, 1659025020],
  [5416026704, 1660925460],
  [5465223076, 1661710860],
  [5480654757, 1660926300],
  [5499934702, 1662130740],
  [5513192189, 1659626400],
  [5522237606, 1654167240],
  [5537251684, 1664269800],
  [5559167331, 1656718560],
  [5568348673, 1654642200],
  [5591759222, 1659025500],
  [5608562550, 1664012820],
  [5614111200, 1661780160],
  [5666819340, 1664112240],
  [5684254605, 1662134040],
  [5684689868, 1661304720],
  [5707112959, 1663803300],
  [5756095415, 1660925940],
  [5772670706, 1661539140],
  [5778063231, 1667477640],
  [5802242180, 1671821040],
  [5853442730, 1674866100], // 2023
  [5859878513, 1673117760],
  [5885964106, 1671081840],
  [5982648124, 1686941700],
  [6020888206, 1675534800],
  [6032606998, 1686998640],
  [6057123350, 1676198350],
  [6058560984, 1686907980],
  [6101607245, 1686830760],
  [6108011341, 1681032060],
  [6132325730, 1692033840],
  [6182056052, 1687870740],
  [6279839148, 1688399160],
  [6306077724, 1692442920],
  [6321562426, 1688486760],
  [6364973680, 1696349340],
  [6386727079, 1691696880],
  [6429580803, 1692082680],
  [6527226055, 1690289160],
  [6813121418, 1698489600],
  [6865576492, 1699052400],
  [6925870357, 1701192327], // 2023-11-29 (existing; legacy comment said
  //                           "2024" but the unix value is in fact Nov 2023)

  // ─── Cross-bot calibration anchors (2026-04-26 audit) ──────────────────
  // Source: min(createdAt) across LyAdminBot + fStikBot + QuoteBot + lybot
  // user collections per 100M-id bucket. Multi-bot earliest is the tightest
  // available *upper bound* on Telegram registration date — true creation
  // is at-or-before this. Safe direction for our anti-spam detectors:
  // accountAge predictions can only become *older* than reality, never
  // newer, so the "fresh-bake" rule doesn't fire on legitimate veterans.
  //
  // The 7.6B–8.1B plateau (all 2024-09-18) is real: ≈0.5B IDs allocated
  // in a single day. Likely a Telegram-side ID allocation event or a mass
  // bot-farm registration spike. We anchor the plateau explicitly so
  // interpolation matches observed reality rather than smearing the dates
  // linearly across what was actually a one-day jump.
  [7000000000, 1708351706], // 2024-02-19
  [7100000000, 1708352108], // 2024-02-19
  [7200000000, 1716731573], // 2024-05-26
  [7300000000, 1716733039], // 2024-05-26
  [7400000000, 1716729388], // 2024-05-26
  [7500000000, 1723641696], // 2024-08-14
  [7600000000, 1726680317], // 2024-09-18 ─┐
  [7700000000, 1726678480], //              │ 2024-09-18 plateau
  [7800000000, 1726680015], //              │ (~0.5B IDs in one day,
  [7900000000, 1726679350], //              │  Telegram alloc event /
  [8000000000, 1726680694], //              │  bot-farm spike)
  [8100000000, 1726685883], // 2024-09-18 ─┘
  [8200000000, 1753301180], // 2025-07-23
  [8300000000, 1753300167], // 2025-07-23
  [8400000000, 1753303865], // 2025-07-23
  [8500000000, 1761942128], // 2025-10-31
  [8600000000, 1771801757], // 2026-02-22
  [8700000000, 1771806478]  // 2026-02-23
]

entries.sort((a, b) => a[0] - b[0])

// 32→64-bit migration dead zone. int32_max = 2,147,483,647. From mid-2021
// Telegram extended user_id to int64 in MTProto layer 133, but rather than
// continuing allocations sequentially past 2^31 it skipped a wide band and
// resumed at ~5B. Empirical verification: a min(createdAt)/count probe
// across fStikBot (20.4M users) + QuoteBot (22.9M users) found ZERO real
// users in 2.20B–5.00B (28 contiguous 100M-wide buckets, all empty).
//
// A user_id that lands in this gap is therefore one of:
//   - a spoofed / forged value (someone pretending to be an older account)
//   - a bot or other special account allocated outside the normal pool
//   - a future migration extension — re-probe before changing this guard
// In none of these cases should our interpolation try to invent a
// "creation date" — it would feed false age signals into the spam
// detectors (sleeper_awakened triggers at predictedAgeDays>365, and a wild
// interpolation in this range can land anywhere from 2018 to 2024).
const TRANSITION_GAP_START = 2_147_483_648  // 2^31, last 32-bit boundary
const TRANSITION_GAP_END   = 5_000_000_000  // first observed real users in cross-bot data

const parseRegistrationTime = (prefix, regTime) => {
  return [prefix, new Date(regTime * 1000)]
}

const predictCreationDate = (id) => {
  const n = entries.length
  const nowUnix = Math.floor(Date.now() / 1000)

  // Invalid or missing ID - treat as brand new
  if (!id || typeof id !== 'number') {
    return parseRegistrationTime('?', nowUnix)
  }

  // Channel IDs are negative - no creation date available
  // Return current time with '?' prefix to indicate unknown
  if (id < 0) {
    return parseRegistrationTime('?', nowUnix)
  }

  // 32→64-bit transition gap (see comment near TRANSITION_GAP_*).
  // Empirically empty across 42M cross-bot users — anything here is a
  // spoof or a special-allocation account, not a real registration.
  if (id >= TRANSITION_GAP_START && id < TRANSITION_GAP_END) {
    return parseRegistrationTime('?', nowUnix)
  }

  // Interpolation for IDs within known range
  for (let i = 1; i < n; i++) {
    if (id >= entries[i - 1][0] && id <= entries[i][0]) {
      const t = (id - entries[i - 1][0]) / (entries[i][0] - entries[i - 1][0])
      const regTime = Math.floor(
        entries[i - 1][1] + t * (entries[i][1] - entries[i - 1][1])
      )
      // Sanity check: can't be in the future
      return parseRegistrationTime('~', Math.min(regTime, nowUnix))
    }
  }

  // Very old accounts (before first known entry)
  if (id <= entries[0][0]) {
    return parseRegistrationTime('<', entries[0][1])
  }

  // Extrapolation for IDs beyond known range (newer accounts)
  // Calculate growth rate from last ~10 entries for stability
  const windowSize = Math.min(10, n - 1)
  const startEntry = entries[n - 1 - windowSize]
  const endEntry = entries[n - 1]

  const idGrowth = endEntry[0] - startEntry[0]
  const timeGrowth = endEntry[1] - startEntry[1]

  // Fallback rate if data is inconsistent (~100 IDs/sec is conservative)
  const growthRate = timeGrowth > 0 ? idGrowth / timeGrowth : 100

  // Extrapolate forward from last known entry
  const idBeyond = id - endEntry[0]
  const extrapolatedTime = endEntry[1] + Math.floor(idBeyond / growthRate)

  // Cap at current time (account can't be from the future)
  const estimatedTime = Math.min(extrapolatedTime, nowUnix)

  return parseRegistrationTime('>', estimatedTime)
}

/**
 * Check if account is new (less than 6 months old)
 */
const isNewAccount = (ctx) => {
  if (!ctx.from) return false
  const userId = ctx.from.id
  const [, creationDate] = predictCreationDate(userId)
  const now = new Date()
  const ageInMonths = (now - creationDate) / (1000 * 60 * 60 * 24 * 30)
  return ageInMonths < 6
}

/**
 * Get account age estimation category
 */
const getAccountAge = (ctx) => {
  if (!ctx.from) return 'unknown'
  const userId = ctx.from.id
  const [, creationDate] = predictCreationDate(userId)
  const now = new Date()
  const ageInMonths = (now - creationDate) / (1000 * 60 * 60 * 24 * 30)

  if (ageInMonths < 1) return 'very_new'
  if (ageInMonths < 6) return 'new'
  if (ageInMonths < 24) return 'recent'
  return 'established'
}

/**
 * Stolen / dormant account detection.
 *
 * Telegram user_ids are monotonically-ish increasing. We estimate the
 * account's true creation date from the id (see predictCreationDate), and
 * compare it against our locally-observed firstSeen timestamp. A large
 * gap between "account exists since 2018" and "we first saw them writing
 * yesterday" is a strong signal that the account is:
 *   a) a long-dormant sleeper awakened for a campaign, or
 *   b) a stolen/purchased account in a new owner's hands.
 *
 * The detector returns a structural verdict — no age-of-account keyword
 * bias, no country data. Pure arithmetic on two timestamps.
 */
const getAccountAgeParadox = (userId, firstSeenDate, nowMs = Date.now()) => {
  if (!userId || typeof userId !== 'number' || userId <= 0) return null
  if (!firstSeenDate) return null
  const [, predicted] = predictCreationDate(userId)
  if (!(predicted instanceof Date)) return null

  const firstSeen = firstSeenDate instanceof Date ? firstSeenDate : new Date(firstSeenDate)
  if (Number.isNaN(firstSeen.getTime())) return null

  const predictedAgeMs = nowMs - predicted.getTime()
  const localAgeMs = nowMs - firstSeen.getTime()

  const DAY = 24 * 60 * 60 * 1000
  const predictedAgeDays = predictedAgeMs / DAY
  const localAgeDays = localAgeMs / DAY

  return {
    predictedAgeDays: Math.max(0, predictedAgeDays),
    localAgeDays: Math.max(0, localAgeDays),
    predictedCreation: predicted,
    firstSeen,
    // Gap in days: how long the account existed before we observed it.
    // High values = long sleeper / new-ownership candidate.
    sleeperDays: Math.max(0, predictedAgeDays - localAgeDays),
    // Veteran + fresh-in-our-data signal: the account has existed >1yr on
    // Telegram but we've only known it for <7 days — classic sleeper awake.
    isSleeperAwakened: predictedAgeDays > 365 && localAgeDays < 7,
    // Newly-registered account actively posting within its first day —
    // classic bot-farm fresh bake.
    isFreshBake: predictedAgeDays < 7 && localAgeDays < 2
  }
}

module.exports = {
  isNewAccount,
  getAccountAge,
  predictCreationDate,
  getAccountAgeParadox
}
