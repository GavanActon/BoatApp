import { WATCHED_SPOTS, type DestinationDef } from '../config'
import { gridConditionsAt } from './weatherLayer'
import { seaBand, seaName, withinLimits } from './seaState'

/**
 * Live conditions at the handful of places worth watching, read straight out
 * of the regional grid the weather layer already fetches and caches offline.
 *
 * No new network calls: the grid covers the whole region seven days deep, and
 * a spot check verified it agrees with a per-point marine forecast to within
 * 0.02 m — the underlying wave model is coarser than the grid either way, so
 * sampling it claims no detail a point request would add.
 *
 * What the model does NOT resolve is shelter behind a headland at anything
 * finer than about 10 km. That is what the hand-written exposure note on each
 * spot is for, and why the note is worth more than it looks.
 */

export interface SpotConditions {
  spot: DestinationDef
  waveM: number | null
  wavePeriodS: number | null
  windKn: number | null
  gustKn: number | null
  windDir: number | null
  /** Chance of precipitation, 0–100. Null for a grid cached before it was fetched. */
  precipProbPct: number | null
  /** WMO sky code at the moment, or null off the grid. */
  weatherCode: number | null
  band: number | null
  /** Name of the sea state — "Choppy". Null when there's no wave data. */
  seaLabel: string | null
  /**
   * Inside the limits the skipper set. `null` when they haven't set any —
   * which is different from "no", and must never be drawn as a judgement.
   */
  clears: boolean | null
}

/** Conditions at each of `places` (the watched spots unless told otherwise)
 *  at `ms`, in the order given. */
export function spotConditionsAt(
  ms: number,
  waveLimitM: number | null,
  windLimitKn: number | null,
  places: DestinationDef[] = WATCHED_SPOTS,
): SpotConditions[] {
  return places.map((spot) => {
    const g = gridConditionsAt(spot.lon, spot.lat, ms)
    const waveM = g?.waveM ?? null
    const windKn = g?.windKn ?? null
    return {
      spot,
      waveM,
      wavePeriodS: g?.wavePeriodS ?? null,
      windKn,
      gustKn: g?.gustKn ?? null,
      windDir: g?.windDir ?? null,
      precipProbPct: g?.precipProbPct ?? null,
      weatherCode: g?.weatherCode ?? null,
      band: seaBand(waveM),
      seaLabel: seaName(waveM),
      clears:
        waveLimitM == null || windLimitKn == null
          ? null
          : withinLimits(waveM, windKn, waveLimitM, windLimitKn),
    }
  })
}

/**
 * Calmest first, then by name — and with the spots whose conditions we don't
 * know at the bottom rather than sorted as if they were flat.
 *
 * Deliberately NOT sorted by "clears your limits": that would turn the list
 * into a ranking of where the app thinks you should go. It sorts by how big
 * the water is, which is a fact, and the limit marks sit alongside.
 */
export function byCalmest(a: SpotConditions, b: SpotConditions): number {
  if (a.waveM == null && b.waveM == null) return a.spot.name.localeCompare(b.spot.name)
  if (a.waveM == null) return 1
  if (b.waveM == null) return -1
  if (a.waveM !== b.waveM) return a.waveM - b.waveM
  return a.spot.name.localeCompare(b.spot.name)
}
