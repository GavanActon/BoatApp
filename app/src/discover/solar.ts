/**
 * Sunrise and sunset for a point and a day — the NOAA solar equations,
 * good to a minute or two, which is all First Light and Closing Time need.
 */

const RAD = Math.PI / 180

function julianDay(ms: number): number {
  return ms / 86_400_000 + 2440587.5
}

/** Sunrise and sunset (ms epoch) on the local calendar day containing `ms`,
 *  or null in polar conditions (never on this lake, but the maths allows it). */
export function sunTimes(lon: number, lat: number, ms: number): { rise: number; set: number } | null {
  const d = new Date(ms)
  const noonLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  const jd = julianDay(noonLocal)
  const t = (jd - 2451545) / 36525
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const C =
    Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * M * RAD) * 0.000289
  const trueLong = L0 + C
  const omega = 125.04 - 1934.136 * t
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD)
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD
  const y = Math.tan((eps / 2) * RAD) ** 2
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD))
  const cosHa =
    Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl * RAD)) -
    Math.tan(lat * RAD) * Math.tan(decl * RAD)
  if (cosHa < -1 || cosHa > 1) return null
  const ha = Math.acos(cosHa) / RAD
  // minutes past UTC midnight
  const riseUtcMin = 720 - 4 * (lon + ha) - eqTime
  const setUtcMin = 720 - 4 * (lon - ha) - eqTime
  const utcMidnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return { rise: utcMidnight + riseUtcMin * 60_000, set: utcMidnight + setUtcMin * 60_000 }
}
