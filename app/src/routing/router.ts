import { getDepthGridRaw, loadDepthGrid } from '../map/depthGrid'
import { buildNavMask, routeOnGrid, type NavMask, type RouteResult } from './waterRouter'

/** Binds the pure water router to the app's loaded depth grid. */

let nav: NavMask | null = null

export type { RouteResult }

export async function computeRoute(
  start: [number, number],
  dest: [number, number],
  vias: [number, number][] = [],
): Promise<RouteResult | { error: string }> {
  if (!nav) {
    // at app boot (e.g. resuming a persisted trip) the grid may still be loading
    if (!getDepthGridRaw()) await loadDepthGrid()
    const raw = getDepthGridRaw()
    if (!raw) return { error: 'Depth chart not loaded yet — download the offline bundle or go online once.' }
    nav = buildNavMask(raw.header, raw.data)
  }

  // route each leg start → via… → dest; legs share their joint coordinate
  // (both legs snap the via to the same water cell), so drop the duplicate
  const stops: [number, number][] = [start, ...vias, dest]
  let coords: [number, number][] = []
  let distanceNm = 0
  const viaIdx: number[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const leg = routeOnGrid(nav, stops[i], stops[i + 1])
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
