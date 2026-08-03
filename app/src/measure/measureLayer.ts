import type { Feature, FeatureCollection } from 'geojson'
import type {
  FilterSpecification,
  GeoJSONSource,
  Map as MlMap,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
} from 'maplibre-gl'
import { getMap, onEachMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { formatBearing, formatDistance, legsOf } from './measureMath'
import { useMeasureStore } from './measureStore'

/**
 * The measuring tool on the map: tap water to drop points, and every leg
 * carries its range and bearing. Points are draggable, and a tap on one
 * removes it — the same gestures the route already teaches.
 *
 * Straight-line ranges, the way a chartplotter's ruler works. Routing around
 * land is the trip planner's job.
 */

const COLOR = '#ffb454' // amber — never mistakable for the blue route line
const TAP_SLOP_PX = 8 // travel below this is a tap, not a drag

// the map the layers live on, so a replacement map re-adds them instead of
// silently swallowing every setData (see onEachMap)
let layersOn: MlMap | null = null
let drag: { idx: number; lngLat: [number, number]; moved: boolean } | null = null
let abandonDrag: (() => void) | null = null
let lastEditMs = 0
// after a touch gesture the browser replays it as mouse events; those must not
// start a second drag on top of the one the finger just finished
let lastTouchMs = 0

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return

  map.addSource('measure', { type: 'geojson', data: emptyFc() })

  const lineFilter: FilterSpecification = ['==', ['get', 'kind'], 'track']
  map.addLayer({
    id: 'measure-line-casing',
    type: 'line',
    source: 'measure',
    filter: lineFilter,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(8, 20, 34, 0.85)', 'line-width': 6 },
  })
  map.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    filter: lineFilter,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLOR, 'line-width': 2.5 },
  })
  // range + bearing written along each leg, sitting just off the line the way
  // a chart annotates a course
  map.addLayer({
    id: 'measure-leg-labels',
    type: 'symbol',
    source: 'measure',
    filter: ['==', ['get', 'kind'], 'leg'],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11.5,
      'text-offset': [0, -0.9],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffe0b0',
      'text-halo-color': 'rgba(8, 20, 34, 0.92)',
      'text-halo-width': 1.6,
    },
  })
  map.addLayer({
    id: 'measure-points',
    type: 'circle',
    source: 'measure',
    filter: ['==', ['get', 'kind'], 'point'],
    paint: {
      'circle-radius': 7,
      'circle-color': '#12263c',
      'circle-stroke-color': COLOR,
      'circle-stroke-width': 2.5,
    },
  })

  layersOn = map
}

function buildFc(): FeatureCollection {
  const { active, points } = useMeasureStore.getState()
  if (!active) return emptyFc()

  const pts = points.map((p, i) => (drag && drag.idx === i ? drag.lngLat : p))
  const features: Feature[] = []

  if (pts.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { kind: 'track' },
    })
    // each leg carries its own label geometry, so the text follows that leg's
    // heading rather than the whole course
    const { depthUnit, speedUnit } = useAppStore.getState()
    const legs = legsOf(pts)
    for (let i = 0; i < legs.length; i++) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [pts[i], pts[i + 1]] },
        properties: {
          kind: 'leg',
          label: `${formatDistance(legs[i].nm, speedUnit, depthUnit)} · ${formatBearing(legs[i].deg)}`,
        },
      })
    }
  }
  for (let i = 0; i < pts.length; i++) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pts[i] },
      properties: { kind: 'point', idx: i },
    })
  }
  return { type: 'FeatureCollection', features }
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const src = map.getSource('measure') as GeoJSONSource | undefined
  src?.setData(buildFc())
}

/** True right after a point was dragged or removed — the click that ends the
 *  gesture must not drop another point. Kept short: it only has to outlast the
 *  browser's own click echo, and a longer window swallows a quick next tap. */
function editedRecently(withinMs = 350): boolean {
  return Date.now() - lastEditMs < withinMs
}

function beginDrag(map: MlMap, idx: number, e: MapLayerMouseEvent | MapLayerTouchEvent) {
  const touch = e.type === 'touchstart'
  if (touch) lastTouchMs = Date.now()
  else if (Date.now() - lastTouchMs < 700) return // the browser replaying a tap
  if ('points' in e && e.points.length > 1) return // pinch, not an edit
  // a gesture whose end we never saw (the finger left the window) must not
  // wedge the tool shut — drop it and let this one through
  abandonDrag?.()
  e.preventDefault() // keep the map itself from panning under the gesture
  drag = { idx, lngLat: [e.lngLat.lng, e.lngLat.lat], moved: false }
  map.getCanvas().style.cursor = 'grabbing'

  // the gesture is tracked on the window, not the map: a finger that lifts
  // over the card or a FAB — they sit right on top of the chart — still ends
  // the drag, where map-scoped listeners would simply never hear about it
  const container = map.getCanvasContainer()
  const start = { x: e.point.x, y: e.point.y }
  const move = (ev: MouseEvent | TouchEvent) => {
    const p = 'touches' in ev ? ev.touches[0] : ev
    if (!drag || !p) return
    const r = container.getBoundingClientRect()
    const x = p.clientX - r.left
    const y = p.clientY - r.top
    // a boat deck wobbles: until the finger has really travelled, this is
    // still a tap, and a tap means "remove this point"
    if (!drag.moved && Math.hypot(x - start.x, y - start.y) < TAP_SLOP_PX) return
    const ll = map.unproject([x, y])
    drag.lngLat = [ll.lng, ll.lat]
    drag.moved = true
    render(map)
  }
  const detach = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', up)
    window.removeEventListener('touchcancel', up)
    drag = null
    abandonDrag = null
    map.getCanvas().style.cursor = ''
  }
  function up() {
    const done = drag
    detach()
    if (!done) return
    if (touch) lastTouchMs = Date.now()
    lastEditMs = Date.now()
    const st = useMeasureStore.getState()
    // a tap that went nowhere means "I'm done with this point"
    if (done.moved) st.movePoint(done.idx, done.lngLat)
    else st.removePoint(done.idx)
  }
  abandonDrag = () => {
    detach()
    render(map) // back to where the store says the point is
  }
  if (touch) {
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    window.addEventListener('touchcancel', up)
  } else {
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
}

let inited = false

/** Call once at startup (after the route layer, so measurements draw on top). */
export function initMeasureLayer() {
  if (inited) return // React StrictMode mounts twice in dev
  inited = true

  onEachMap((map) => {
    addLayers(map)
    render(map)

    map.on('click', (e) => {
      if (!useMeasureStore.getState().active) return
      if (editedRecently()) return
      // a tap on an existing point is that point's own gesture
      if (map.queryRenderedFeatures(e.point, { layers: ['measure-points'] }).length > 0) return
      useMeasureStore.getState().addPoint([e.lngLat.lng, e.lngLat.lat])
    })

    const startDrag = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
      const idx = e.features?.[0]?.properties?.idx
      if (typeof idx !== 'number') return
      beginDrag(map, idx, e)
    }
    map.on('mousedown', 'measure-points', startDrag)
    map.on('touchstart', 'measure-points', startDrag)
    map.on('mouseenter', 'measure-points', () => {
      if (!drag) map.getCanvas().style.cursor = 'grab'
    })
    map.on('mouseleave', 'measure-points', () => {
      if (!drag) map.getCanvas().style.cursor = ''
    })
  })

  useMeasureStore.subscribe((s, prev) => {
    if (s.points === prev.points && s.active === prev.active) return
    const live = getMap()
    if (live && layersOn === live) render(live)
    else withMap(render)
  })

  // leg labels are written in the user's units — redraw when those change
  useAppStore.subscribe((s, prev) => {
    if (s.depthUnit === prev.depthUnit && s.speedUnit === prev.speedUnit) return
    const live = getMap()
    if (live && layersOn === live && useMeasureStore.getState().active) render(live)
  })
}
