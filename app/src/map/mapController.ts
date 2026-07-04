import type { Map as MlMap } from 'maplibre-gl'

/** Singleton access to the MapLibre map for non-React modules (weather, tracking). */

type MapReadyFn = (map: MlMap) => void

let map: MlMap | null = null
const waiters: MapReadyFn[] = []

export function setMap(m: MlMap | null) {
  map = m
  if (m) {
    for (const w of waiters.splice(0)) w(m)
  }
}

export function getMap(): MlMap | null {
  return map
}

/** Run fn now if the map exists (and is loaded), otherwise when it becomes ready. */
export function withMap(fn: MapReadyFn) {
  if (map) {
    if (map.loaded()) fn(map)
    else map.once('load', () => map && fn(map))
  } else {
    waiters.push(fn)
  }
}

const LAYER_IDS: Record<string, string[]> = {
  depth: ['depth-shade'],
  contours: ['contour-lines', 'contour-labels', 'soundings'],
  seamarks: ['seamarks'],
}

export function applyLayerVisibility(key: string, visible: boolean) {
  if (!map) return
  for (const id of LAYER_IDS[key] ?? []) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  }
}
