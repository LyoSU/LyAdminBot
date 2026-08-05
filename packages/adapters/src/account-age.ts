/**
 * Account-age prediction from Telegram user ID.
 *
 * All tables below are GENERATED — do not hand-edit. Rebuild with
 * `node tools/account-age-calibrate/calibrate.mjs` (sources, method and
 * re-harvest queries are documented there and in the tool's README).
 *
 * Two allocation eras, discovered in the 2026-08 recalibration against
 * 29M first-seen records from two production databases:
 *
 *  - Sequential (< 7e9, until 2024-02): ids grow with time. Modeled by an
 *    isotonic (PAVA) curve over registration observations, forced under
 *    every production first-seen bound (an account cannot register after
 *    it was seen alive), with per-era p90 uncertainty bands.
 *
 *  - Randomized blocks (>= 7e9, since 2024-02): Telegram opens a block and
 *    hands out ids randomly across its whole range until it saturates
 *    (daily-max id pins at the block ceiling, then jumps when the next
 *    block opens). Inside a block the id carries no date information —
 *    only the block window does. The plausible-registration window IS the
 *    block window; the point estimate is its midpoint.
 *
 * The 2^31..5e9 id band is a verified-empty 32→64-bit migration gap and
 * returns null (a real registration cannot live there; interpolating would
 * feed false ages into the sleeper detector). Re-verified 2026-08-06:
 * 0 of 2331 spam actors fell in the band.
 */

const ANCHORS: readonly (readonly [number, number])[] = [
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
  [65331894, 1415060729],
  [66478514, 1415397073],
  [101260938, 1425600000], // 2015
  [101323197, 1426204000],
  [103151531, 1433073500],
  [109393468, 1434326000],
  [111220210, 1434326000],
  [112594714, 1438387000],
  [122600695, 1438387000],
  [124872445, 1439856000],
  [125828524, 1442663500],
  [130029930, 1442663500],
  [133909606, 1444176000],
  [143159169, 1448785495],
  [148670295, 1450799667],
  [157242073, 1450799667],
  [171295414, 1457481000], // 2016
  [181783990, 1460246000],
  [199290099, 1462463998],
  [211250953, 1463979421],
  [222021233, 1465344000],
  [225034354, 1466208000],
  [263924493, 1471443381],
  [278941742, 1473465000],
  [285253072, 1476835000],
  [289314178, 1478004931],
  [294851037, 1479600000],
  [297621225, 1481846000],
  [303986717, 1482076794],
  [328594461, 1482969000],
  [337808429, 1487707000], // 2017
  [352940995, 1487894000],
  [355821673, 1488414752],
  [369669043, 1490918000],
  [400169472, 1501459000],
  [424296049, 1504595730],
  [464741934, 1509854156],
  [488538152, 1512947936],
  [539850643, 1519619144], // 2018
  [587508425, 1525815199],
  [596624580, 1527000403],
  [600432868, 1527495524],
  [602353172, 1527745186],
  [616816630, 1529625600],
  [627309429, 1530140877],
  [681896077, 1532821500],
  [726342357, 1542278524],
  [727572658, 1542540300],
  [735973578, 1542540300],
  [758507935, 1542540300],
  [796147074, 1542540300],
  [824044288, 1547029979], // 2019
  [840410563, 1549663910],
  [868644893, 1554207844],
  [911993007, 1561184137],
  [925078064, 1563290000],
  [944486707, 1563378861],
  [958877875, 1571690252],
  [1014976950, 1571690252],
  [1039817325, 1571690252],
  [1054883348, 1575824436],
  [1056322611, 1575824436],
  [1057704545, 1582578392], // 2020
  [1105396994, 1582578392],
  [1131820536, 1582592309],
  [1140435543, 1582592309],
  [1145856008, 1585685330],
  [1228505297, 1585685330],
  [1236637863, 1585732260],
  [1284853910, 1585732260],
  [1311944697, 1593196505],
  [1329739102, 1593196505],
  [1342882602, 1593196505],
  [1382531194, 1600188120],
  [1429904943, 1602412250],
  [1440357817, 1602902997],
  [1453114996, 1603501928],
  [1555106878, 1608290301],
  [1568678500, 1608927469],
  [1585583199, 1609721120], // 2021
  [1650704855, 1611640603],
  [1657874476, 1611714201],
  [1658586909, 1613148540],
  [1669339768, 1613880296],
  [1692464211, 1615402500],
  [1729895907, 1615898037],
  [1777946019, 1615898037],
  [1789832304, 1615910542],
  [1807942741, 1620246318],
  [1848504313, 1620246318],
  [1877880887, 1620246318],
  [1896314196, 1620246318],
  [1922431793, 1626443697],
  [1924408874, 1626515255],
  [1941432564, 1628574256],
  [1974255900, 1631877715],
  [2042105550, 1631877715],
  [2044811265, 1631877715],
  [2046532165, 1631886263],
  [2104565855, 1636059095],
  [2118674413, 1636059095],
  [2132621410, 1636108055],
  [2138472342, 1637590800],
  [5000533025, 1638289600],
  [5020278812, 1638436810],
  [5041987100, 1638436810],
  [5107165824, 1642632581], // 2022
  [5137289599, 1642632581],
  [5156002542, 1642632581],
  [5243092981, 1642638127],
  [5252229222, 1642768936],
  [5278544618, 1646415595],
  [5304951856, 1649791918],
  [5309860296, 1649791918],
  [5350049340, 1649791918],
  [5364712507, 1649859732],
  [5387234031, 1653599113],
  [5417271591, 1653599113],
  [5487287282, 1653599113],
  [5497016260, 1653601056],
  [5516600336, 1653601056],
  [5551546228, 1653601056],
  [5580039596, 1653637436],
  [5591759222, 1659414306],
  [5608562550, 1660517154],
  [5626853637, 1660517154],
  [5636976951, 1660517154],
  [5653511200, 1660517154],
  [5732454608, 1660517154],
  [5735682862, 1660517154],
  [5756011460, 1660517154],
  [5756095415, 1662451545],
  [5772670706, 1662451545],
  [5778063231, 1667477640],
  [5802242180, 1668727900],
  [5840852489, 1668727900],
  [5861430918, 1668727900],
  [5872906224, 1668734534],
  [5904146990, 1668734534],
  [5909902795, 1668734534],
  [5970502205, 1668734534],
  [5982648124, 1674939680], // 2023
  [6006074162, 1674939680],
  [6033956012, 1674939680],
  [6042453225, 1674939680],
  [6107913831, 1674945762],
  [6160238077, 1674945762],
  [6176619163, 1675807534],
  [6208354357, 1675807534],
  [6240643206, 1675968138],
  [6299846457, 1675968138],
  [6306077724, 1688039421],
  [6310694403, 1688039421],
  [6327935359, 1688039421],
  [6364973680, 1689970890],
  [6377515692, 1689970890],
  [6409629616, 1689970890],
  [6430490944, 1689973081],
  [6434951955, 1689973081],
  [6541078635, 1689973081],
  [6541124691, 1689973081],
  [6563742141, 1689973081],
  [6609578962, 1689973081],
  [6624740802, 1689973081],
  [6649957266, 1690034398],
  [6743482183, 1696522650],
  [6744658360, 1696555871],
  [6751636932, 1696752980],
  [6805003594, 1697662903],
  [6841201713, 1697662903],
  [6874304038, 1697662903],
  [6916119317, 1697662903],
  [6952477948, 1697662903],
  [6984062645, 1699730520],
  [7000000000, 1708351706], // 2024
]

const UNCERTAINTY_BANDS: readonly (readonly [number, number])[] = [
  [2200000000, 4031667],
  [7000000000, 11885584],
]

/** [idLo, idHi, openUnix, closeUnix|null] — null means the block is still active. */
const RANDOMIZED_BLOCKS: readonly (readonly [number, number, number, number | null])[] = [
  [7000000000, 7200000000, 1708351706, 1716729388], // 2024-02-19 .. 2024-05-26
  [7200000000, 7500000000, 1716729388, 1723641696], // 2024-05-26 .. 2024-08-14
  [7500000000, 7600000000, 1723641696, 1726678480], // 2024-08-14 .. 2024-09-18
  [7600000000, 8200000000, 1726678480, 1753300167], // 2024-09-18 .. 2025-07-23
  [8200000000, 8500000000, 1753300167, 1761942128], // 2025-07-23 .. 2025-10-31
  [8500000000, 8600000000, 1761942128, 1771801757], // 2025-10-31 .. 2026-02-22
  [8600000000, 8800000000, 1771801757, 1778606483], // 2026-02-22 .. 2026-05-12
  [8800000000, 9000000000, 1778606483, null], // 2026-05-12 .. active
]

const LAST_EVIDENCE_UNIX = 1785974400

const TRANSITION_GAP_START = 2147483648 // 2^31
const TRANSITION_GAP_END = 5000000000

export interface AccountAgeBoundsDays {
  /** Point estimate, identical to predictAccountAgeDays. */
  mid: number
  /** Youngest plausible age — the account may have registered this recently. */
  lo: number
  /** Oldest plausible age — the account cannot be older than this estimate. */
  hi: number
}

/**
 * Plausible registration window [earliest, latest] in unix seconds.
 *
 * Sequential era (< first block): interpolated anchor curve ± the era's p90
 * residual band. Randomized-block era: the whole block window — inside an
 * active allocation block the id carries NO date information beyond it.
 * Above all known blocks: the id did not exist when the calibration data was
 * harvested, so it appeared between then and now.
 */
const registrationWindow = (userId: number, nowUnix: number): { earliest: number; latest: number } => {
  for (const [lo, hi, open, close] of RANDOMIZED_BLOCKS) {
    if (userId >= lo && userId < hi) {
      return { earliest: open, latest: Math.min(close ?? nowUnix, nowUnix) }
    }
  }

  const lastBlock = RANDOMIZED_BLOCKS[RANDOMIZED_BLOCKS.length - 1]!
  if (userId >= lastBlock[1]) {
    return { earliest: Math.min(LAST_EVIDENCE_UNIX, nowUnix), latest: nowUnix }
  }

  const first = ANCHORS[0]!
  let t: number
  if (userId <= first[0]) {
    t = first[1]
  } else {
    let lo = 0
    let hi = ANCHORS.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (ANCHORS[m]![0] <= userId) lo = m
      else hi = m
    }
    const [x0, y0] = ANCHORS[lo]!
    const [x1, y1] = ANCHORS[hi]!
    t = y0 + ((userId - x0) / (x1 - x0)) * (y1 - y0)
  }

  let band = UNCERTAINTY_BANDS[UNCERTAINTY_BANDS.length - 1]![1]
  for (const [limit, width] of UNCERTAINTY_BANDS) {
    if (userId < limit) {
      band = width
      break
    }
  }
  return { earliest: Math.min(t - band, nowUnix), latest: Math.min(t + band, nowUnix) }
}

const isPredictable = (userId: number): boolean =>
  Number.isFinite(userId) && userId > 0 && !(userId >= TRANSITION_GAP_START && userId < TRANSITION_GAP_END)

/** Predicted registration unix time (window midpoint), or null when unknowable. */
export const predictRegistrationUnix = (userId: number, nowUnix = Math.floor(Date.now() / 1000)): number | null => {
  if (!isPredictable(userId)) return null
  const { earliest, latest } = registrationWindow(userId, nowUnix)
  return Math.min(Math.floor((earliest + latest) / 2), nowUnix)
}

/** Predicted account age in days, or null when unknowable. */
export const predictAccountAgeDays = (userId: number, nowUnix = Math.floor(Date.now() / 1000)): number | null => {
  const registered = predictRegistrationUnix(userId, nowUnix)
  if (registered === null) return null
  return Math.max(0, (nowUnix - registered) / 86400)
}

/**
 * Age with its uncertainty interval. `lo` answers "could this account be
 * fresh?" and `hi` answers "is it certainly fresh?" — conservative gating for
 * fresh-account and sleeper signals uses the bound that avoids the false
 * positive, not the point estimate.
 */
export const predictAccountAgeBoundsDays = (
  userId: number,
  nowUnix = Math.floor(Date.now() / 1000),
): AccountAgeBoundsDays | null => {
  if (!isPredictable(userId)) return null
  const { earliest, latest } = registrationWindow(userId, nowUnix)
  const mid = Math.min(Math.floor((earliest + latest) / 2), nowUnix)
  return {
    mid: Math.max(0, (nowUnix - mid) / 86400),
    lo: Math.max(0, (nowUnix - latest) / 86400),
    hi: Math.max(0, (nowUnix - earliest) / 86400),
  }
}
