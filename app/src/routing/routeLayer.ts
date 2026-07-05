import type { Feature, FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { getMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { useRouteStore } from './routeStore'
import { condRank, timeLabel } from './tripPlan'

/**
 * Draws the planned route on the map: the track itself, a dot at each leg
 * point labelled with the ETA outbound AND on the way back (coloured by the
 * worse of the two conditions), and the destination pin. Tapping a dot points
 * the forecast strip at the top of the map at that spot.
 */

let layersAdded = false
let lastRoute: unknown = null

const COND_COLORS = { good: '#59e0b8', mod: '#ffb454', rough: '#ff6b6b' }

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

const HIT_PAD = 22 // px — finger-sized halo around each dot, not just its pixels

/** The leg dot near a tapped point (nearest within HIT_PAD), or null. */
export function sampleDotAt(
  map: MlMap,
  point: { x: number; y: number },
): { idx: number } | null {
  if (!map.getLayer('route-samples')) return null
  const feats = map.queryRenderedFeatures(
    [
      [point.x - HIT_PAD, point.y - HIT_PAD],
      [point.x + HIT_PAD, point.y + HIT_PAD],
    ],
    { layers: ['route-samples'] },
  )
  let best: { idx: number } | null = null
  let bestD = Infinity
  for (const f of feats) {
    if (f.geometry.type !== 'Point') continue
    const p = map.project(f.geometry.coordinates as [number, number])
    const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2
    if (d < bestD && typeof f.properties?.idx === 'number') {
      bestD = d
      best = { idx: f.properties.idx }
    }
  }
  return best
}

function addLayers(map: MlMap) {
  if (layersAdded || !map.getStyle()) return

  map.addSource('route', { type: 'geojson', data: emptyFc() })

  map.addLayer({
    id: 'route-line-casing',
    type: 'line',
    source: 'route',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(8, 20, 34, 0.85)', 'line-width': 7 },
  })
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3fc8ff', 'line-width': 3.5, 'line-dasharray': [2.2, 1.6] },
  })
  map.addLayer({
    id: 'route-samples',
    type: 'circle',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'sample'],
    paint: {
      'circle-radius': ['case', ['boolean', ['get', 'focused'], false], 10, 7],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': [
        'case',
        ['boolean', ['get', 'focused'], false],
        '#eaf3fb',
        'rgba(8, 20, 34, 0.9)',
      ],
      'circle-stroke-width': ['case', ['boolean', ['get', 'focused'], false], 3, 2],
    },
  })
  map.addLayer({
    id: 'route-sample-labels',
    type: 'symbol',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'sample'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      'text-offset': [0, 1.25],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': 'rgba(220, 240, 255, 0.95)',
      'text-halo-color': 'rgba(8, 20, 34, 0.85)',
      'text-halo-width': 1.2,
    },
  })
  map.addLayer({
    id: 'route-dest',
    type: 'circle',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'dest'],
    paint: {
      'circle-radius': 9,
      'circle-color': '#3fc8ff',
      'circle-stroke-color': '#eaf3fb',
      'circle-stroke-width': 2.5,
    },
  })
  map.addLayer({
    id: 'route-dest-label',
    type: 'symbol',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'dest'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#eaf3fb',
      'text-halo-color': 'rgba(8, 20, 34, 0.9)',
      'text-halo-width': 1.4,
    },
  })

  layersAdded = true
}

function buildFc(): FeatureCollection {
  const { route, plan, destination } = useRouteStore.getState()
  const features: Feature[] = []

  if (route) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coords },
      properties: {},
    })
  }
  if (plan) {
    const focus = useRouteStore.getState().focusPoint

    // the return leg re-visits the outbound spots — pair them up so each dot
    // carries both legs: ETA out on top, ETA back underneath
    const nOut = plan.samples.filter(
      (s) => s.phase === 'depart' || s.phase === 'outbound' || s.phase === 'arrive',
    ).length
    for (let i = 0; i < nOut; i++) {
      const out = plan.samples[i]
      const backIdx = 2 * nOut - 2 - i
      const back = backIdx > i && backIdx < plan.samples.length ? plan.samples[backIdx] : null
      const cond = back && condRank(back.cond) > condRank(out.cond) ? back.cond : out.cond
      const label = back ? `${timeLabel(out.atMs)}\n${timeLabel(back.atMs)}` : timeLabel(out.atMs)
      const focused =
        focus != null && Math.abs(focus.lon - out.lon) < 1e-6 && Math.abs(focus.lat - out.lat) < 1e-6

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [out.lon, out.lat] },
        properties: {
          kind: 'sample',
          color: COND_COLORS[cond],
          label,
          idx: i,
          focused,
        },
      })
    }
  }
  if (destination) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [destination.lon, destination.lat] },
      properties: { kind: 'dest', label: destination.name ?? 'Destination' },
    })
  }
  return { type: 'FeatureCollection', features }
}

function render(map: MlMap) {
  if (!layersAdded) return
  const src = map.getSource('route') as GeoJSONSource | undefined
  src?.setData(buildFc())
}

function fitToRoute(map: MlMap) {
  const { route } = useRouteStore.getState()
  if (!route || route.coords.length < 2) return
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lon, lat] of route.coords) {
    w = Math.min(w, lon)
    e = Math.max(e, lon)
    s = Math.min(s, lat)
    n = Math.max(n, lat)
  }
  const sheetOpen = useAppStore.getState().sheetTab != null
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    {
      padding: {
        top: 110,
        left: 45,
        right: 45,
        bottom: sheetOpen ? Math.round(window.innerHeight * 0.55) + 30 : 140,
      },
      maxZoom: 13,
      duration: 600,
    },
  )
}

let inited = false

/** Call once at startup. */
export function initRouteLayer() {
  // React StrictMode mounts twice in dev — a second init would register the
  // click handler twice, and a double-fired toggle cancels itself out
  if (inited) return
  inited = true

  withMap((map) => {
    addLayers(map)
    render(map)

    // tap near a leg dot → point the top forecast strip at that spot
    // (tap again to release); padded hit-test so fingers don't have to be exact
    map.on('click', (e) => {
      const hit = sampleDotAt(map, e.point)
      if (!hit) return
      const { plan, destination, focusPoint, setFocusPoint } = useRouteStore.getState()
      const s = plan?.samples[hit.idx]
      if (!s) return
      if (
        focusPoint &&
        Math.abs(focusPoint.lon - s.lon) < 1e-6 &&
        Math.abs(focusPoint.lat - s.lat) < 1e-6
      ) {
        setFocusPoint(null)
        return
      }
      const label =
        s.phase === 'depart'
          ? 'Trip start'
          : s.phase === 'arrive'
            ? (plan?.destName ?? destination?.name ?? 'Destination')
            : `En route · ${timeLabel(s.atMs)}`
      setFocusPoint({ lon: s.lon, lat: s.lat, label })
    })
  })

  useRouteStore.subscribe((s, prev) => {
    if (s.focusPoint !== prev.focusPoint) {
      const live = getMap()
      if (live && layersAdded) render(live)
    }
    if (s.route !== prev.route || s.plan !== prev.plan || s.destination !== prev.destination) {
      const apply = (map: MlMap) => {
        addLayers(map)
        render(map)
        if (s.route && s.route !== lastRoute) {
          lastRoute = s.route
          // don't yank the camera on progress replans while the boat is moving
          if (s.tripStartedAt == null) fitToRoute(map)
        }
        if (!s.route) {
          lastRoute = null
          // no route to frame — still bring the dropped pin into view
          if (s.destination && s.destination !== prev.destination) {
            map.easeTo({ center: [s.destination.lon, s.destination.lat], duration: 600 })
          }
        }
      }
      // once layers exist, update directly rather than waiting on withMap
      const live = getMap()
      if (live && layersAdded) apply(live)
      else withMap(apply)
    }
  })
}
