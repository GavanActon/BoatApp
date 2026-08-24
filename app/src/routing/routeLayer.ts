import type { Feature, FeatureCollection } from 'geojson'
import maplibregl from 'maplibre-gl'
import type {
  FilterSpecification,
  GeoJSONSource,
  Map as MlMap,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  MapMouseEvent,
  MapTouchEvent,
} from 'maplibre-gl'
import { getMap, onEachMap, withMap } from '../map/mapController'
import { useMeasureStore } from '../measure/measureStore'
import { useAppStore } from '../state/appStore'
import { formatPeriod } from '../weather/openMeteo'
import { useRouteStore } from './routeStore'
import { condRank, timeLabel, type TripSample } from './tripPlan'

/**
 * Draws the planned route on the map: the track itself, a dot at each leg
 * point labelled with the conditions there outbound AND on the way back
 * (coloured by the worse of the two), and the destination pin. Tapping a dot
 * points the forecast strip at the top of the map at that spot.
 *
 * The route is editable in place: press-drag the line to pull in a new course
 * point, drag a course point (or the destination pin) to move it, tap a
 * course point to remove it. Every edit re-routes each leg through safe water.
 */

// which map the layers live on — an identity, not a flag, so a replacement map
// gets its own layers instead of silently swallowing every setData
let layersOn: MlMap | null = null
let lastRoute: unknown = null
// 'launch' frames the persisted trip on startup but lets auto-follow win the
// camera afterwards; 'user' (a trip change) also switches follow off so the
// frame sticks
let fitPending: 'launch' | 'user' | null = 'launch'

// in-flight edit gesture; the moving point renders from here until commit
type Drag =
  | { kind: 'via'; idx: number; fresh: boolean; lngLat: [number, number]; moved: boolean }
  | { kind: 'dest'; lngLat: [number, number]; moved: boolean }
  | { kind: 'start'; lngLat: [number, number]; moved: boolean }
let drag: Drag | null = null
let lastEditMs = 0

/** True right after a route edit — map tap handlers use this to stand down. */
export function routeEditedRecently(withinMs = 600): boolean {
  return Date.now() - lastEditMs < withinMs
}

const COND_COLORS = { good: '#59e0b8', mod: '#ffb454', rough: '#ff6b6b' }

// Eight-point arrows pointing DOWNWIND — the way the wind arrows on the
// weather layer, the outlook strip and the tap popup all point, so a glance
// at any of them reads the same. Noto Sans carries all eight, and the glyph
// range they live in ships with the offline font set.
const WIND_ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘']

function windArrow(fromDeg: number): string {
  return WIND_ARROWS[Math.round(fromDeg / 45) % 8]
}

/**
 * What it will be like at one pass of a leg point — "↘ 12 · 0.4m 5s" — which
 * is what you look at a planned route for; the clock lives on the trip card.
 * Wind stays in knots like every other forecast readout (the speed preference
 * is for the boat, not the weather), the period rides along only when the Wave
 * period preference is on, and the sea drops out where the model has no data.
 *
 * The arrow comes back on its own because the label layer renders it a size up
 * — at body size the glyph is small enough to read as punctuation.
 */
function wxParts(s: TripSample, showPeriod: boolean): { arrow: string; text: string } {
  const per = showPeriod ? formatPeriod(s.wavePeriodS) : null
  const sea = s.waveM == null ? '' : ` · ${s.waveM.toFixed(1)}m${per ? ` ${per}` : ''}`
  return { arrow: windArrow(s.windDir), text: ` ${Math.round(s.windKn)}${sea}` }
}

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

// the route line proper, excluding the transient drag-preview line
const ROUTE_LINE_FILTER: FilterSpecification = [
  'all',
  ['==', ['geometry-type'], 'LineString'],
  ['!=', ['coalesce', ['get', 'kind'], ''], 'preview'],
]

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return

  map.addSource('route', { type: 'geojson', data: emptyFc() })

  map.addLayer({
    id: 'route-line-casing',
    type: 'line',
    source: 'route',
    filter: ROUTE_LINE_FILTER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(8, 20, 34, 0.85)', 'line-width': 7 },
  })
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    filter: ROUTE_LINE_FILTER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3fc8ff', 'line-width': 3.5, 'line-dasharray': [2.2, 1.6] },
  })
  // invisible fat twin of the line — the finger-sized grab target for
  // pulling a new course point out of the route
  map.addLayer({
    id: 'route-line-hit',
    type: 'line',
    source: 'route',
    filter: ROUTE_LINE_FILTER,
    paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 26 },
  })
  // straight rubber-band shown while a point is being dragged
  map.addLayer({
    id: 'route-preview',
    type: 'line',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'preview'],
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(234, 243, 251, 0.7)',
      'line-width': 2,
      'line-dasharray': [1.4, 1.8],
    },
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
      // assembled here rather than baked into one string so the wind arrows can
      // run a size up (see wxParts); every section is always a string, the
      // empty ones collapsing the label to a single outbound line
      'text-field': [
        'format',
        ['get', 'pOut'],
        {},
        ['get', 'aOut'],
        { 'font-scale': 1.35 },
        ['get', 'tOut'],
        {},
        ['get', 'sep'],
        {},
        ['get', 'pBack'],
        {},
        ['get', 'aBack'],
        { 'font-scale': 1.35 },
        ['get', 'tBack'],
        {},
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      // conditions run wider than the ETAs they replaced — without this the
      // default 10-em wrap breaks every leg across two ragged lines
      'text-max-width': 20,
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
  // user-placed course points: small ringed handles, visually distinct from
  // the condition-coloured leg dots
  map.addLayer({
    id: 'route-vias',
    type: 'circle',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'via'],
    paint: {
      'circle-radius': 6.5,
      'circle-color': '#12263c',
      'circle-stroke-color': '#3fc8ff',
      'circle-stroke-width': 2.5,
    },
  })
  // fixed start point (launch ramp, marina) — green to say "from here",
  // draggable like the destination pin
  map.addLayer({
    id: 'route-start',
    type: 'circle',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'start'],
    paint: {
      'circle-radius': 8,
      'circle-color': '#12263c',
      'circle-stroke-color': '#59e0b8',
      'circle-stroke-width': 3,
    },
  })
  map.addLayer({
    id: 'route-start-label',
    type: 'symbol',
    source: 'route',
    filter: ['==', ['get', 'kind'], 'start'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#bff2e0',
      'text-halo-color': 'rgba(8, 20, 34, 0.9)',
      'text-halo-width': 1.3,
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

  layersOn = map
}

function buildFc(): FeatureCollection {
  const { route, plan, destination, viaPoints, startPoint } = useRouteStore.getState()
  const features: Feature[] = []

  // course points, with the in-flight drag applied; `idx` is the point's
  // position in the store (what a later grab needs), -1 for a not-yet-committed
  // fresh point pulled out of the line
  const vias = viaPoints.map((p, i) => ({ p, idx: i }))
  if (drag?.kind === 'via') {
    if (drag.fresh) vias.splice(drag.idx, 0, { p: drag.lngLat, idx: -1 })
    else vias[drag.idx] = { p: drag.lngLat, idx: drag.idx }
  }
  const destPos: [number, number] | null = destination
    ? drag?.kind === 'dest'
      ? drag.lngLat
      : [destination.lon, destination.lat]
    : null
  const startPos: [number, number] | null = startPoint
    ? drag?.kind === 'start'
      ? drag.lngLat
      : [startPoint.lon, startPoint.lat]
    : null

  if (route) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coords },
      properties: {},
    })
  }
  if (plan) {
    const focus = useRouteStore.getState().focusPoint
    const showPeriod = useAppStore.getState().wavePeriod

    // the return leg re-visits the outbound spots — pair them up so each dot
    // carries both legs: conditions out on top, conditions back underneath
    const nOut = plan.samples.filter(
      (s) => s.phase === 'depart' || s.phase === 'outbound' || s.phase === 'arrive',
    ).length
    for (let i = 0; i < nOut; i++) {
      const out = plan.samples[i]
      const backIdx = 2 * nOut - 2 - i
      const back = backIdx > i && backIdx < plan.samples.length ? plan.samples[backIdx] : null
      const cond = back && condRank(back.cond) > condRank(out.cond) ? back.cond : out.cond
      // one dot, two passes: ordering alone said which was which when these
      // were clock times, but two lines of weather look alike
      const o = wxParts(out, showPeriod)
      const b = back ? wxParts(back, showPeriod) : null
      const focused =
        focus != null && Math.abs(focus.lon - out.lon) < 1e-6 && Math.abs(focus.lat - out.lat) < 1e-6

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [out.lon, out.lat] },
        properties: {
          kind: 'sample',
          color: COND_COLORS[cond],
          pOut: b ? 'out ' : '',
          aOut: o.arrow,
          tOut: o.text,
          sep: b ? '\n' : '',
          pBack: b ? 'back ' : '',
          aBack: b?.arrow ?? '',
          tBack: b?.text ?? '',
          idx: i,
          focused,
        },
      })
    }
  }
  for (const v of vias) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: v.p },
      properties: { kind: 'via', idx: v.idx },
    })
  }
  if (startPoint && startPos) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: startPos },
      properties: { kind: 'start', label: startPoint.name ?? 'Start' },
    })
  }
  if (destination && destPos) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: destPos },
      properties: { kind: 'dest', label: destination.name ?? 'Destination' },
    })
  }

  // rubber-band from the dragged point to its neighbours on the course
  if (drag && route) {
    const chain: [number, number][] = [startPos ?? route.coords[0], ...vias.map((v) => v.p)]
    if (destPos) chain.push(destPos)
    const at = drag.kind === 'dest' ? chain.length - 1 : drag.kind === 'start' ? 0 : 1 + drag.idx
    const seg = chain.slice(Math.max(0, at - 1), Math.min(chain.length, at + 2))
    if (seg.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: seg },
        properties: { kind: 'preview' },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const src = map.getSource('route') as GeoJSONSource | undefined
  src?.setData(buildFc())
}

function fitToRoute(map: MlMap, breakFollow: boolean) {
  const fitted = useRouteStore.getState().route
  if (!fitted || fitted.coords.length < 2) return
  // framing a newly chosen run is a deliberate "look here" — without this,
  // follow mode tugs the camera back to the boat on the very next GPS fix
  // and the preview never sticks (one tap on the locate FAB re-follows)
  if (breakFollow) useAppStore.getState().setFollow(false)
  // wait a frame so the trip-builder card has rendered at its final size —
  // its measured height keeps the whole run clear of the bottom chrome
  requestAnimationFrame(() => {
    if (useRouteStore.getState().route !== fitted) return // superseded
    let w = Infinity
    let s = Infinity
    let e = -Infinity
    let n = -Infinity
    for (const [lon, lat] of fitted.coords) {
      w = Math.min(w, lon)
      e = Math.max(e, lon)
      s = Math.min(s, lat)
      n = Math.max(n, lat)
    }
    const sheetOpen = useAppStore.getState().sheetTab != null
    const barH = document.querySelector('.bottombar')?.getBoundingClientRect().height ?? 120
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
          // +30 leaves room for the verdict line that joins the card once
          // the weather lands
          bottom: sheetOpen ? Math.round(window.innerHeight * 0.55) + 30 : Math.round(barH) + 30,
        },
        maxZoom: 13,
        duration: 600,
      },
    )
  })
}

// ---------- route editing ----------

function distToSegSq(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len))
  const x = a.x + t * dx
  const y = a.y + t * dy
  return (p.x - x) ** 2 + (p.y - y) ** 2
}

/** Where a point grabbed on the route line slots into the via list: count the
 *  course points that lie before the nearest route segment. */
function insertionIndexAt(map: MlMap, point: { x: number; y: number }): number {
  const { route } = useRouteStore.getState()
  if (!route) return 0
  const pts = route.coords.map((c) => map.project(c))
  let bestSeg = 0
  let bestD = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegSq(point, pts[i], pts[i + 1])
    if (d < bestD) {
      bestD = d
      bestSeg = i
    }
  }
  const viaIdx = route.viaIdx ?? []
  let n = 0
  while (n < viaIdx.length && viaIdx[n] <= bestSeg) n++
  return n
}

let viaPopup: maplibregl.Popup | null = null

function showRemovePopup(map: MlMap, idx: number) {
  viaPopup?.remove()
  const p = useRouteStore.getState().viaPoints[idx]
  if (!p) return
  const btn = document.createElement('button')
  btn.className = 'via-remove-btn'
  btn.textContent = 'Remove point'
  btn.onclick = () => {
    viaPopup?.remove()
    viaPopup = null
    lastEditMs = Date.now()
    useRouteStore.getState().removeVia(idx)
  }
  // closeOnClick would eat the popup instantly: the click event of the very
  // tap that opened it fires right after mouseup; dismissed on the NEXT tap
  // by the map click handler instead
  viaPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'via-popup',
    offset: 12,
    maxWidth: 'none',
  })
    .setLngLat(p)
    .setDOMContent(btn)
    .addTo(map)
}

function beginDrag(map: MlMap, d: Drag, e: MapLayerMouseEvent | MapLayerTouchEvent) {
  if (drag) return
  if (useRouteStore.getState().picking) return
  if (useMeasureStore.getState().active) return // the ruler owns the map
  if ('points' in e && e.points.length > 1) return // pinch, not an edit
  e.preventDefault() // keep the map itself from panning under the gesture
  drag = d
  viaPopup?.remove()
  map.getCanvas().style.cursor = 'grabbing'
  render(map)

  const move = (ev: MapMouseEvent | MapTouchEvent) => {
    if (!drag) return
    drag.lngLat = [ev.lngLat.lng, ev.lngLat.lat]
    drag.moved = true
    render(map)
  }
  const up = () => {
    map.off('mousemove', move)
    map.off('touchmove', move)
    map.off('mouseup', up)
    map.off('touchend', up)
    map.off('touchcancel', up)
    const done = drag
    drag = null
    map.getCanvas().style.cursor = ''
    if (!done) return
    lastEditMs = Date.now()
    const st = useRouteStore.getState()
    if (done.kind === 'dest') {
      if (done.moved) st.moveDestination(done.lngLat[0], done.lngLat[1])
      else render(map)
    } else if (done.kind === 'start') {
      if (done.moved) st.moveStartPoint(done.lngLat[0], done.lngLat[1])
      else render(map)
    } else if (done.fresh) {
      // even a no-move tap on the line drops a point there, ready to drag
      st.insertVia(done.idx, done.lngLat)
    } else if (done.moved) {
      st.moveVia(done.idx, done.lngLat)
    } else {
      render(map) // tap on an existing point → offer to remove it
      showRemovePopup(map, done.idx)
    }
  }
  if (e.type === 'touchstart') {
    map.on('touchmove', move)
    map.on('touchend', up)
    map.on('touchcancel', up)
  } else {
    map.on('mousemove', move)
    map.on('mouseup', up)
  }
}

function addEditHandlers(map: MlMap) {
  const startVia = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    const idx = e.features?.[0]?.properties?.idx
    if (typeof idx !== 'number' || idx < 0) return
    beginDrag(map, { kind: 'via', idx, fresh: false, lngLat: [e.lngLat.lng, e.lngLat.lat], moved: false }, e)
  }
  map.on('mousedown', 'route-vias', startVia)
  map.on('touchstart', 'route-vias', startVia)

  const startDest = (e: MapLayerMouseEvent | MapLayerTouchEvent) =>
    beginDrag(map, { kind: 'dest', lngLat: [e.lngLat.lng, e.lngLat.lat], moved: false }, e)
  map.on('mousedown', 'route-dest', startDest)
  map.on('touchstart', 'route-dest', startDest)

  const startStart = (e: MapLayerMouseEvent | MapLayerTouchEvent) =>
    beginDrag(map, { kind: 'start', lngLat: [e.lngLat.lng, e.lngLat.lat], moved: false }, e)
  map.on('mousedown', 'route-start', startStart)
  map.on('touchstart', 'route-start', startStart)

  // registered after the point handlers so a press on a point wins; a press on
  // bare line pulls a fresh course point out of it
  const startLine = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (drag || !useRouteStore.getState().route) return
    // dots riding the line (ETA dots, points, pin) keep their own gestures
    const covered = map.queryRenderedFeatures(e.point, {
      layers: ['route-vias', 'route-dest', 'route-start', 'route-samples'],
    })
    if (covered.length > 0) return
    const idx = insertionIndexAt(map, e.point)
    beginDrag(map, { kind: 'via', idx, fresh: true, lngLat: [e.lngLat.lng, e.lngLat.lat], moved: false }, e)
  }
  map.on('mousedown', 'route-line-hit', startLine)
  map.on('touchstart', 'route-line-hit', startLine)

  for (const layer of ['route-vias', 'route-dest', 'route-start']) {
    map.on('mouseenter', layer, () => {
      if (!drag) map.getCanvas().style.cursor = 'grab'
    })
    map.on('mouseleave', layer, () => {
      if (!drag) map.getCanvas().style.cursor = ''
    })
  }
}

let inited = false

/** Call once at startup. */
export function initRouteLayer() {
  // React StrictMode mounts twice in dev — a second init would register the
  // click handler twice, and a double-fired toggle cancels itself out
  if (inited) return
  inited = true

  onEachMap((map) => {
    addLayers(map)
    addEditHandlers(map)
    render(map)

    // tap near a leg dot → point the top forecast strip at that spot
    // (tap again to release); padded hit-test so fingers don't have to be exact
    map.on('click', (e) => {
      if (routeEditedRecently()) return // the click that ends an edit gesture
      if (useMeasureStore.getState().active) return
      if (viaPopup) {
        viaPopup.remove()
        viaPopup = null
      }
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
    // a new place to run to — either end, or the course between — earns a
    // re-frame when its route lands; weather-refresh replans of the same
    // trip recompute the route too and must NOT move the camera
    if (
      s.destination !== prev.destination ||
      s.startPoint !== prev.startPoint ||
      s.viaPoints !== prev.viaPoints
    ) {
      fitPending = 'user'
    }
    if (
      s.focusPoint !== prev.focusPoint ||
      s.viaPoints !== prev.viaPoints ||
      s.startPoint !== prev.startPoint
    ) {
      const live = getMap()
      if (live && layersOn === live) render(live)
    }
    if (s.route !== prev.route || s.plan !== prev.plan || s.destination !== prev.destination) {
      const apply = (map: MlMap) => {
        addLayers(map)
        render(map)
        if (s.route && s.route !== lastRoute) {
          lastRoute = s.route
          const wantFit = fitPending
          fitPending = null
          // don't yank the camera on progress replans while the boat is moving,
          // nor right after an on-map edit — the user is already looking there
          if (wantFit && s.tripStartedAt == null && !routeEditedRecently(3000)) {
            fitToRoute(map, wantFit === 'user')
          }
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
      if (live && layersOn === live) apply(live)
      else withMap(apply)
    }
  })

  // coming (back) to a trip surface re-frames the run: since the route last
  // landed, GPS follow or plain panning may have carried the camera anywhere.
  // Skip while a trip change is mid-flight — its route-landing fit will frame
  // the NEW run; fitting now would frame the old one first.
  const refit = () => {
    if (fitPending || useRouteStore.getState().tripStartedAt != null) return
    const live = getMap()
    if (live) fitToRoute(live, true)
    else withMap((m) => fitToRoute(m, true))
  }
  useRouteStore.subscribe((s, prev) => {
    if (s.card === 'trip' && prev.card !== 'trip') refit()
  })
  useAppStore.subscribe((s, prev) => {
    if (s.sheetTab === 'route' && prev.sheetTab !== 'route') refit()
    // the leg labels carry the period, so the preference has to reach them
    if (s.wavePeriod !== prev.wavePeriod) {
      const live = getMap()
      if (live && layersOn === live) render(live)
    }
  })
}
