/**
 * The sea-state ramp — a sequential scale, not a score.
 *
 * `conditionFor` still exists and still answers "is this comfortable for a
 * small boat", which is a judgement about YOU. This is the other thing: how
 * big the water is, full stop. Eight bands walking the whole spectrum —
 * light green through gold and burnt orange into magenta and deep purple —
 * so a strip, a lane or a week of it carries real information in colour
 * alone, and bigger reads as bigger at a glance.
 *
 * The ramp moves in lightness as well as hue, so it survives a colour-blind
 * viewer and direct sun. The top is deep purple, not red, on purpose: red
 * belongs to warnings an agency issued, never to anything the app worked
 * out for itself — and purple past magenta reads every bit as serious.
 */

export interface SeaBandDef {
  /** Upper bound of the band, in metres (exclusive). */
  maxM: number
  /** What people here call it. */
  name: string
  /** Ramp colour. */
  color: string
}

export const SEA_BANDS: SeaBandDef[] = [
  { maxM: 0.2, name: 'Glassy', color: '#b9efad' },
  { maxM: 0.4, name: 'Calm', color: '#7fdc6a' },
  { maxM: 0.7, name: 'Rippled', color: '#c9d84a' },
  { maxM: 1.0, name: 'Choppy', color: '#f2c53d' },
  { maxM: 1.4, name: 'Lumpy', color: '#f39a3a' },
  { maxM: 2.0, name: 'Rough', color: '#e96e3f' },
  { maxM: 2.8, name: 'Heavy', color: '#c74f86' },
  { maxM: Infinity, name: 'Big', color: '#7b2d8f' },
]

/** Drawn wherever a height is unknown — never a ramp colour, because a pale
 *  ramp colour reads as calm and "we don't know" is not calm. */
export const SEA_UNKNOWN = '#3a536b'

/** Band index for a wave height, or null when there's no data. */
export function seaBand(waveM: number | null | undefined): number | null {
  if (waveM == null || !Number.isFinite(waveM)) return null
  for (let i = 0; i < SEA_BANDS.length; i++) if (waveM < SEA_BANDS[i].maxM) return i
  return SEA_BANDS.length - 1
}

/** Ramp colour for a wave height; the neutral grey when unknown. */
export function seaColor(waveM: number | null | undefined): string {
  const b = seaBand(waveM)
  return b == null ? SEA_UNKNOWN : SEA_BANDS[b].color
}

/** "Choppy" — the word, for a headline. Null when there's no data. */
export function seaName(waveM: number | null | undefined): string | null {
  const b = seaBand(waveM)
  return b == null ? null : SEA_BANDS[b].name
}

/**
 * Does this hour sit inside the limits the user typed in?
 *
 * Note what this is and isn't: it compares the forecast against numbers the
 * skipper chose, and says nothing about whether the trip is a good idea. The
 * app never picks these values on the user's behalf — see the boat profile.
 */
export function withinLimits(
  waveM: number | null | undefined,
  windKn: number | null | undefined,
  waveLimitM: number,
  windLimitKn: number,
): boolean {
  if (waveM != null && waveM > waveLimitM) return false
  if (windKn != null && windKn > windLimitKn) return false
  return waveM != null || windKn != null
}
