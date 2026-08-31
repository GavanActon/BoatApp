import { depthAt, getDepthGridRaw, loadDepthGrid } from '../map/depthGrid'
import { buildNavMask, NODATA, routeOnGrid, type NavMask, type RouteResult } from './waterRouter'

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

const AFLOAT_RADIUS_M = 3000

/**
 * Is the boat on the water here? A different question from "can this point be
 * snapped to water", and the two were conflated: routeOnGrid's snap reaches
 * 13.4 km, which is the right latitude for a destination tapped roughly on the
 * map and badly wrong for deciding where the BOAT is. Ashore, it slid the
 * start 6-7 km onto the lake and quoted the whole trip from out there.
 *
 * Measured to CHARTED water on the depth grid — not navigable water. Water
 * too shallow for the nav mask is still water you float on: Batchawana Bay,
 * one of this app's own destinations, sits 0.53 km from charted water but
 * 1.22 km from anything the router will cross.
 *
 * Three kilometres, which sounds far for "on the water" and isn't: the grid
 * cannot see all the water. NODATA means land AND uncharted, and coverage is
 * uneven — 98% of the Canadian shore near the Sandies is charted against 21%
 * of the Michigan shore by Brimley. So a house 50 ft from a shallow bay can
 * sit 2.2 km from the nearest cell the grid admits is water (Bay Mills), and
 * a 1 km rule calls its owner inland. Measured across the region, the shore
 * runs 0-2.21 km from charted water and genuine inland starts at 5.09 km, so
 * 3 km is the gap between them rather than a round number.
 */
export function isAfloat(lon: number, lat: number): boolean {
  if (depthAt(lon, lat) != null) return true // standing on charted water
  const raw = getDepthGridRaw()
  if (!raw) return false // grid not up yet: don't claim afloat on no evidence
  const { header, data } = raw
  const { west, south, east, north, nx, ny } = header
  if (lon < west || lon > east || lat < south || lat > north) return false
  const mX = ((east - west) / nx) * 111320 * Math.cos((lat * Math.PI) / 180)
  const mY = ((north - south) / ny) * 111320
  const cx = Math.round(((lon - west) / (east - west)) * (nx - 1))
  const cy = Math.round(((north - lat) / (north - south)) * (ny - 1))
  const rx = Math.ceil(AFLOAT_RADIUS_M / mX)
  const ry = Math.ceil(AFLOAT_RADIUS_M / mY)
  for (let dy = -ry; dy <= ry; dy++) {
    const y = cy + dy
    if (y < 0 || y >= ny) continue
    for (let dx = -rx; dx <= rx; dx++) {
      const x = cx + dx
      if (x < 0 || x >= nx) continue
      if (data[y * nx + x] === NODATA) continue
      if (Math.hypot(dx * mX, dy * mY) <= AFLOAT_RADIUS_M) return true
    }
  }
  return false
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
