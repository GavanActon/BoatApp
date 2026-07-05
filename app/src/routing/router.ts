import { getDepthGridRaw, loadDepthGrid } from '../map/depthGrid'
import { buildNavMask, routeOnGrid, type NavMask, type RouteResult } from './waterRouter'

/** Binds the pure water router to the app's loaded depth grid. */

let nav: NavMask | null = null

export type { RouteResult }

export async function computeRoute(
  start: [number, number],
  dest: [number, number],
): Promise<RouteResult | { error: string }> {
  if (!nav) {
    // at app boot (e.g. resuming a persisted trip) the grid may still be loading
    if (!getDepthGridRaw()) await loadDepthGrid()
    const raw = getDepthGridRaw()
    if (!raw) return { error: 'Depth chart not loaded yet — download the offline bundle or go online once.' }
    nav = buildNavMask(raw.header, raw.data)
  }
  const route = routeOnGrid(nav, start, dest)
  if (!route) return { error: 'No water route found — pick a point on open water inside the charted area.' }
  return route
}
