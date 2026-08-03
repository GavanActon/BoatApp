import type { Map as MlMap } from 'maplibre-gl'

/** Singleton access to the MapLibre map for non-React modules (weather, tracking). */

type MapReadyFn = (map: MlMap) => void

let map: MlMap | null = null
// style parsed — sources and layers can be added; tracked ourselves because no
// MapLibre predicate says exactly this (see setMap)
let ready = false
const waiters: MapReadyFn[] = [] // one-shot: the next ready map, then dropped
const perMap: MapReadyFn[] = [] // layer setup: re-run for every map instance

/** One callback must not take the others down with it: they're queued in one
 *  list, so an unguarded throw used to silently strand every layer behind it. */
function run(fn: MapReadyFn, m: MlMap) {
  try {
    fn(m)
  } catch (err) {
    console.error('[map] ready callback failed', err)
  }
}

export function setMap(m: MlMap | null) {
  map = m
  ready = false
  if (!m) return

  const markReady = () => {
    if (map !== m || ready) return
    ready = true
    for (const fn of perMap) run(fn, m)
    for (const fn of waiters.splice(0)) run(fn, m)
  }

  // 'style.load' — the moment the style's own sources and layers exist, which
  // is all addSource/addLayer needs. Deliberately NOT 'load' (nor loaded() /
  // isStyleLoaded(), which mean the same thing): those also wait on every tile
  // source, and a pmtiles archive that doesn't cover the whole view leaves a
  // raster tile loading forever — zoom out past the depth archive's coverage
  // and 'load' never fires, so the route, weather, tracking and measure layers
  // were never added at all, with nothing on screen to say why.
  if (m.isStyleLoaded()) markReady()
  else m.once('style.load', markReady)
  m.once('load', markReady) // belt and braces if 'style.load' is ever missed
}

export function getMap(): MlMap | null {
  return map
}

/** Run fn now if the map exists (and its style has loaded), otherwise when it becomes ready. */
export function withMap(fn: MapReadyFn) {
  if (map && ready) run(fn, map)
  else waiters.push(fn)
}

/** Like withMap, but for the layer modules: also runs against any *later* map.
 *  A one-shot withMap would leave a replacement map (a remount, an HMR update)
 *  with no route/weather/measure layers at all, and since render() writes
 *  through `map.getSource(...)?.setData`, that failure is completely silent. */
export function onEachMap(fn: MapReadyFn) {
  perMap.push(fn)
  if (map && ready) run(fn, map)
}

const LAYER_IDS: Record<string, string[]> = {
  depth: ['depth-shade'],
  contours: ['contour-lines', 'contour-labels', 'soundings'],
  seamarks: ['seamarks'],
  satellite: ['satellite'],
}

export function applyLayerVisibility(key: string, visible: boolean) {
  if (!map) return
  for (const id of LAYER_IDS[key] ?? []) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  }
}
