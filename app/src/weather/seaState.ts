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
 *
 * WHERE the bands fall is the skipper's call, not the app's. The base ramp
 * below was laid out with Rough beginning at 1.4 m — a ship's idea of rough.
 * On this water half a metre is a big sea for the boats that use this app,
 * so the ramp is anchored on the height at which Rough (the red-orange band)
 * begins — appStore.seaScaleM, 0.5 m by default, moved from Settings — and
 * every band scales with it in proportion. One anchor, so the same colour
 * keeps meaning the same water on the strip, the lanes, the blobs and the
 * sheet, whatever it is set to.
 */

import { useAppStore } from '../state/appStore'

export interface SeaBandDef {
  /** Upper bound of the band, in metres (exclusive), on the BASE ramp —
   *  see seaBounds() for where it lands under the skipper's scale. */
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

/** Index of the Rough band — the anchor the sea-state scale setting moves. */
export const SEA_ROUGH_BAND = 5
/** Where Rough begins on the base ramp; the scale is a ratio against this. */
const SEA_ROUGH_BASE_M = SEA_BANDS[SEA_ROUGH_BAND - 1].maxM

/** Drawn wherever a height is unknown — never a ramp colour, because a pale
 *  ramp colour reads as calm and "we don't know" is not calm. */
export const SEA_UNKNOWN = '#3a536b'

/** The scale in force: the wave height at which Rough begins. Components
 *  that draw the ramp should subscribe to the store and pass it in, so a
 *  change in Settings repaints them; module code can take this default. */
export function seaScaleM(): number {
  return useAppStore.getState().seaScaleM
}

/** Ratio between the skipper's ramp and the base one. */
export function seaScaleK(roughM: number = seaScaleM()): number {
  return roughM / SEA_ROUGH_BASE_M
}

/** Upper bounds of every band, in metres, for a ramp whose Rough band begins
 *  at `roughM`. Two decimals, so the legend and the paint agree. */
export function seaBounds(roughM: number = seaScaleM()): number[] {
  const k = seaScaleK(roughM)
  return SEA_BANDS.map((b) =>
    Number.isFinite(b.maxM) ? Math.round(b.maxM * k * 100) / 100 : Infinity,
  )
}

/** Band index for a wave height, or null when there's no data. */
export function seaBand(waveM: number | null | undefined, roughM?: number): number | null {
  if (waveM == null || !Number.isFinite(waveM)) return null
  const bounds = seaBounds(roughM)
  for (let i = 0; i < bounds.length; i++) if (waveM < bounds[i]) return i
  return SEA_BANDS.length - 1
}

/** Ramp colour for a wave height; the neutral grey when unknown. */
export function seaColor(waveM: number | null | undefined, roughM?: number): string {
  const b = seaBand(waveM, roughM)
  return b == null ? SEA_UNKNOWN : SEA_BANDS[b].color
}

/** "Choppy" — the word, for a headline. Null when there's no data. */
export function seaName(waveM: number | null | undefined, roughM?: number): string | null {
  const b = seaBand(waveM, roughM)
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
