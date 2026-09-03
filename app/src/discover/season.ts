/**
 * The season: places to reach this year. A flag fills on arrival, dated —
 * no clocks, no order, no streak.
 *
 * Positions: the Sandies' two islands are the two land masses the depth
 * grid shows there (the config spot sits on the southern one; the northern
 * one is 1.5 nm up the coast) — confirm on the water; the light stands on
 * Île Parisienne's southern tip; Sydney's Shoal is Gavan's own pin.
 */
export interface SeasonPlace {
  id: string
  name: string
  lon: number
  lat: number
}

export const SEASON_PLACES: SeasonPlace[] = [
  { id: 'sandies-north', name: 'The Sandies · north', lon: -84.6622, lat: 46.8297 },
  { id: 'sandies-south', name: 'The Sandies · south', lon: -84.6527, lat: 46.8061 },
  { id: 'parisienne-light', name: 'Parisienne light', lon: -84.753, lat: 46.6245 },
  { id: 'sydneys-shoal', name: "Sydney's Shoal", lon: -84.5538437, lat: 46.4889748 },
  { id: 'batchawana', name: 'Batchawana Bay', lon: -84.52, lat: 46.93 },
]

/** Within this of a place counts as being there — the planner's own arrival range. */
export const REACH_NM = 0.5

/** The season is the calendar year: the lake freezes between two of them. */
export function seasonOf(ms: number): number {
  return new Date(ms).getFullYear()
}
