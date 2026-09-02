import type { Feature, FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { getMap, onEachMap } from '../map/mapController'
import { useMeasureStore } from '../measure/measureStore'
import { useAppStore } from '../state/appStore'
import { badgedPlaces, usePlacesStore } from '../state/placesStore'
import { seaColor, SEA_UNKNOWN } from '../weather/seaState'
import { spotConditionsAt } from '../weather/spotConditions'
import { onWeatherGrid } from '../weather/weatherLayer'
import { routeEditedRecently, sampleDotAt } from './routeLayer'
import { useRouteStore } from './routeStore'

/**
 * The watched spots — and the user's saved pins — ON the chart, each wearing
 * its wave number (§0.2). The
 * map is the selector: tapping a badge makes that spot the subject — the
 * dock's shelf, the outlook strip and the run's lanes all retarget to it.
 *
 * Rendering note, a deviation from the mock's filled squares: MapLibre can't
 * draw rounded-rect sprites behind live text cheaply, so a badge is the
 * number in its ramp colour under a heavy dark halo with the name beneath —
 * the same treatment the route's sample labels already use, and it stays
 * legible over land and water alike (§3.6).
 *
 * The numbers read from the cached forecast grid at the app-wide planning
 * time, so the badges, the shelf and the wind & wave layer always describe
 * the same moment. The subject's own badge is hidden: the run's arrive dot
 * sits on those coordinates, and two glyphs on one point read as neither.
 */

// which map the layers live on — an identity, not a flag, so a replacement
// map gets its own layers instead of silently swallowing every setData
let layersOn: MlMap | null = null

const HIT_PAD = 22 // px — finger-sized halo around the number, like the leg dots

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return

  map.addSource('spots', { type: 'geojson', data: emptyFc() })
  // the focus dot: wherever the outlook strip is pointed, ON the chart — a
  // Places row tap, a water tap, a badge. Drawn last, so it rides on top.
  map.addSource('focus-dot', { type: 'geojson', data: emptyFc() })

  // inserted beneath the route layers when they exist, so a plotted run and
  // its dots always draw over the badges rather than under them
  const before = map.getLayer('route-line-casing') ? 'route-line-casing' : undefined

  map.addLayer(
    {
      id: 'spot-badges',
      type: 'symbol',
      source: 'spots',
      layout: {
        'text-field': ['get', 'wave'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 14,
        // the five spots are the map's fixed furniture — never culled
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(8, 20, 34, 0.95)',
        'text-halo-width': 2,
      },
    },
    before,
  )
  map.addLayer(
    {
      id: 'spot-badge-names',
      type: 'symbol',
      source: 'spots',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 9.5,
        'text-offset': [0, 1.15],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': 'rgba(233, 242, 250, 0.95)',
        'text-halo-color': 'rgba(8, 20, 34, 0.9)',
        'text-halo-width': 1.4,
      },
    },
    before,
  )

  map.addLayer({
    id: 'focus-halo',
    type: 'circle',
    source: 'focus-dot',
    paint: {
      'circle-radius': 14,
      'circle-color': '#3fc8ff',
      'circle-opacity': 0.2,
      'circle-stroke-color': '#3fc8ff',
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.55,
    },
  })
  map.addLayer({
    id: 'focus-dot',
    type: 'circle',
    source: 'focus-dot',
    paint: {
      // the same family as the run's destination dot, smaller — this is
      // "the strip is talking about here", not a trip
      'circle-radius': 5,
      'circle-color': '#3fc8ff',
      'circle-stroke-color': '#eaf3fb',
      'circle-stroke-width': 2,
    },
  })

  layersOn = map
}

function buildFc(): FeatureCollection {
  const destName = useRouteStore.getState().destination?.name ?? null
  const ms = useAppStore.getState().planTimeMs ?? Date.now()
  // limits play no part here: a badge is a magnitude, never a judgement
  const features: Feature[] = spotConditionsAt(ms, null, null, badgedPlaces())
    .filter((r) => r.spot.name !== destName)
    .map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.spot.lon, r.spot.lat] },
      properties: {
        name: r.spot.name,
        wave: r.waveM != null ? r.waveM.toFixed(1) : '–',
        // unknown wears the neutral grey, never a pale ramp colour (§5.5)
        color: r.waveM != null ? seaColor(r.waveM) : SEA_UNKNOWN,
      },
    }))
  return { type: 'FeatureCollection', features }
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const src = map.getSource('spots') as GeoJSONSource | undefined
  src?.setData(buildFc())
}

function renderFocus(map: MlMap) {
  if (layersOn !== map) return
  const fp = useRouteStore.getState().focusPoint
  const src = map.getSource('focus-dot') as GeoJSONSource | undefined
  src?.setData(
    fp
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [fp.lon, fp.lat] }, properties: {} }],
        }
      : emptyFc(),
  )
}

/** The badge near a tapped point (nearest within HIT_PAD), or null. Exported
 *  so the depth-popup tap handler can stand down when a badge was hit. */
export function spotBadgeAt(
  map: MlMap,
  point: { x: number; y: number },
): { name: string; lon: number; lat: number } | null {
  if (!map.getLayer('spot-badges')) return null
  const feats = map.queryRenderedFeatures(
    [
      [point.x - HIT_PAD, point.y - HIT_PAD],
      [point.x + HIT_PAD, point.y + HIT_PAD],
    ],
    { layers: ['spot-badges', 'spot-badge-names'] },
  )
  let best: { name: string; lon: number; lat: number } | null = null
  let bestD = Infinity
  for (const f of feats) {
    if (f.geometry.type !== 'Point') continue
    const [lon, lat] = f.geometry.coordinates as [number, number]
    const p = map.project([lon, lat])
    const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2
    if (d < bestD && typeof f.properties?.name === 'string') {
      bestD = d
      best = { name: f.properties.name, lon, lat }
    }
  }
  return best
}

let inited = false

/** Call once at startup (initRouteLayer does). */
export function initSpotBadges() {
  if (inited) return // React StrictMode double effect-run in dev
  inited = true

  onEachMap((map) => {
    addLayers(map)
    render(map)
    renderFocus(map)

    // tap a badge → that spot is the subject: destination (the lanes draw)
    // AND focus point (the strip retargets). Registered after the route
    // layer's own click handler, and the leg dots win a contested tap — a
    // run's own readout outranks changing the subject by accident.
    map.on('click', (e) => {
      if (routeEditedRecently()) return
      if (useMeasureStore.getState().active) return
      // The first-run home pick (§10.3) is consumed HERE, in the map's
      // last-registered click handler — every earlier handler stands down
      // while the pick is armed, so disarming can't leak the same tap to a
      // handler that runs later. A tap on a known place's badge stars THAT
      // place; open water saves a new Home dock pin.
      if (useAppStore.getState().pickingHome) {
        const known = spotBadgeAt(map, e.point)
        if (known) usePlacesStore.getState().setHome(known.name)
        else usePlacesStore.getState().addHome(e.lngLat.lng, e.lngLat.lat)
        useAppStore.getState().setPickingHome(false)
        return
      }
      if (useRouteStore.getState().picking) return
      if (sampleDotAt(map, e.point)) return
      const hit = spotBadgeAt(map, e.point)
      if (!hit) return
      const rs = useRouteStore.getState()
      // chips arm, surfaces answer: an armed slot takes the badge
      const slot = useAppStore.getState().armedSlot
      if (slot) {
        if (slot === 'from') {
          rs.setStartPoint({ name: hit.name, lon: hit.lon, lat: hit.lat })
        } else {
          useAppStore.getState().setPlanPicked(false)
          rs.setDestination({ name: hit.name, lon: hit.lon, lat: hit.lat })
          rs.setFocusPoint({ lon: hit.lon, lat: hit.lat, label: hit.name })
          rs.setCard('trip')
        }
        useAppStore.getState().setArmedSlot(null)
        return
      }
      if (rs.destination?.name === hit.name) {
        // the subject's badge is hidden, but a tap can still land here off a
        // stale frame — treat it as the ✕: back to Here
        rs.setDestination(null)
        useAppStore.getState().setPlanPicked(false)
        return
      }
      const spot = badgedPlaces().find((s) => s.name === hit.name)
      if (!spot) return
      // a fresh subject is being LOOKED at, not planned — the window UI stays
      // away until a time is picked on the strip
      useAppStore.getState().setPlanPicked(false)
      rs.setDestination({ name: spot.name, lon: spot.lon, lat: spot.lat })
      // after setDestination — which clears the previous trip's focus
      rs.setFocusPoint({ lon: spot.lon, lat: spot.lat, label: spot.name })
      rs.setCard('trip')
      useAppStore.getState().setDetent('rest')
    })
  })

  const repaint = () => {
    const live = getMap()
    if (live && layersOn === live) render(live)
  }

  // the numbers come out of the grid — repaint the moment one lands
  onWeatherGrid(repaint)

  useAppStore.subscribe((s, prev) => {
    // the badges show the app-wide planning moment, like everything else,
    // and wear the ramp, so they follow its scale
    if (s.planTimeMs !== prev.planTimeMs || s.seaScaleM !== prev.seaScaleM) repaint()
  })
  useRouteStore.subscribe((s, prev) => {
    // the subject's own badge hides while its spot is the destination
    if (s.destination !== prev.destination) repaint()
    if (s.focusPoint !== prev.focusPoint) {
      const live = getMap()
      if (live && layersOn === live) renderFocus(live)
    }
  })
  usePlacesStore.subscribe((s, prev) => {
    // a pin saved or deleted — or a built-in hidden or restored — at once
    if (s.saved !== prev.saved || s.hidden !== prev.hidden) repaint()
  })
}
