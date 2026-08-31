import { depthAt, getDepthGridRaw, loadDepthGrid } from '../map/depthGrid'
import {
  buildNavMask,
  cellToLonLat,
  haversineNm,
  routeOnGrid,
  snapToWater,
  type NavMask,
  type RouteResult,
} from './waterRouter'

/** Binds the pure water router to the app's loaded depth grid. */

let nav: NavMask | null = null

export type { RouteResult }

/** Build (or reuse) the nav mask. At app boot the grid may still be loading. */
export async function ensureNav(): Promise<NavMask | null> {
  if (nav) return nav
  if (!getDepthGridRaw()) await loadDepthGrid()
  const raw = getDepthGridRaw()
  if (!raw) return null
  nav = buildNavMask(raw.header, raw.data)
  return nav
}

const AFLOAT_TOLERANCE_M = 1500

/**
 * Is the boat actually on the water here? A different question from "can this
 * point be snapped to water", and the two were being conflated: routeOnGrid's
 * snap reaches 13.4 km, which is the right latitude for a destination tapped
 * roughly on the map and badly wrong for deciding where the BOAT is. Ashore,
 * it slides the start 6-7 km onto the lake and quotes the trip from there.
 *
 * Charted water is the strong signal. The tolerance covers water the depth
 * grid doesn't reach: Batchawana Bay — one of this app's own destinations —
 * sits 1.2 km from the nearest navigable cell. Inland positions in this region
 * run 5 km and up, so 1.5 km separates the two references cleanly. Between
 * them is a grey band no distance can resolve, which is why the trip card now
 * names the start it used and one tap overrides it.
 */
export function isAfloat(lon: number, lat: number): boolean {
  if (depthAt(lon, lat) != null) return true // over charted water
  if (!nav) return false // grid not up yet: don't claim afloat on no evidence
  const cell = snapToWater(nav, lon, lat)
  if (!cell) return false
  const [wlon, wlat] = cellToLonLat(nav, cell[0], cell[1])
  return haversineNm(lon, lat, wlon, wlat) * 1852 <= AFLOAT_TOLERANCE_M
}

export async function computeRoute(
  start: [number, number],
  dest: [number, number],
  vias: [number, number][] = [],
): Promise<RouteResult | { error: string }> {
  const n = await ensureNav()
  if (!n) {
    return { error: 'Depth chart not loaded yet — download the offline bundle or go online once.' }
  }

  // route each leg start → via… → dest; legs share their joint coordinate
  // (both legs snap the via to the same water cell), so drop the duplicate
  const stops: [number, number][] = [start, ...vias, dest]
  let coords: [number, number][] = []
  let distanceNm = 0
  const viaIdx: number[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const leg = routeOnGrid(n, stops[i], stops[i + 1])
    if (!leg) {
      return {
        error:
          vias.length > 0
            ? 'No water route through a course point — drag it onto open water.'
            : 'No water route found — pick a point on open water inside the charted area.',
      }
    }
    coords = coords.length ? coords.concat(leg.coords.slice(1)) : leg.coords.slice()
    distanceNm += leg.distanceNm
    if (i < vias.length) viaIdx.push(coords.length - 1)
  }
  return { coords, distanceNm, viaIdx }
}
