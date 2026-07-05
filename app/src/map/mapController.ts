import type { Map as MlMap } from 'maplibre-gl'

/** Singleton access to the MapLibre map for non-React modules (weather, tracking). */

type MapReadyFn = (map: MlMap) => void

let map: MlMap | null = null
let ready = false // style loaded; map.loaded() is false during any pan/tile fetch, so track our own flag
const waiters: MapReadyFn[] = []

export function setMap(m: MlMap | null) {
  map = m
  ready = m != null && m.loaded()
  if (!m) return
  if (ready) {
    for (const w of waiters.splice(0)) w(m)
  } else {
    m.once('load', () => {
      if (map !== m) return
      ready = true
      for (const w of waiters.splice(0)) w(m)
    })
  }
}

export function getMap(): MlMap | null {
  return map
}

/** Run fn now if the map exists (and its style has loaded), otherwise when it becomes ready. */
export function withMap(fn: MapReadyFn) {
  if (map && ready) fn(map)
  else waiters.push(fn)
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
