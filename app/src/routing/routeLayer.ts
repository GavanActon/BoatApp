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
import { depthAt } from '../map/depthGrid'
import { getMap, onEachMap, withMap } from '../map/mapController'
import { useMeasureStore } from '../measure/measureStore'
import { homeBase } from '../state/placesStore'
import { useAppStore } from '../state/appStore'
import { formatPeriod } from '../weather/openMeteo'
import { seaBand, seaColor, SEA_UNKNOWN } from '../weather/seaState'
import { lighten } from '../weather/seaShade'
import { initRunAnimation, isRakeForced } from './runAnimation'
import { initSpotBadges } from './spotBadges'
import { useRouteStore } from './routeStore'
import { timeLabel, type TripSample } from './tripPlan'
import { haversineNm } from './waterRouter'

/**
 * Draws the planned run on the map.
 *
 * The run wears its own weather: two lanes, the way out and the way home,
 * each carrying a gradient of the sea state at the minute the boat is on it.
 * On this lake those are routinely two different afternoons, and a single
 * number for the trip hides the half that usually bites.
 *
 * Over that sits the course itself — the accent line, unchanged, because it
 * is the only thing on the chart saying where you are going. A dot marks each
 * leg point, coloured by the rougher of its two passes, and exactly one of
 * them is allowed a label: the roughest of the run. Tapping a dot points the
 * forecast strip at the top of the map at that spot.
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
// The ramp each lane last wore, keyed by layer id. The comet moves every step,
// so its stops always differ — but a null highlight, a progress replan that
// lands the same samples, or a settings repaint would otherwise re-send an
// identical expression, and setPaintProperty validates, deep-compares and
// dirties the layer before it finds that out.
const lastRamp = new Map<string, string>()

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

/**
 * The one label a leg point is ever allowed: how big the water is there, and
 * when the boat is there. Nothing else.
 *
 * Every leg used to carry its own two-line "out ... / back ..." readout, which
 * put ten labels over the water and made the chart unreadable. The two lanes
 * carry the conditions now, so the label only has to name the moment — and the
 * clock time says which leg it is without the word.
 */
function sampleLabel(s: TripSample, showPeriod: boolean): string {
  const per = showPeriod ? formatPeriod(s.wavePeriodS) : null
  const sea = s.waveM == null ? '' : `${s.waveM.toFixed(1)} m${per ? ` ${per}` : ''} · `
  return `${sea}${timeLabel(s.atMs)}`
}

// Eight-point arrows pointing DOWNWIND — the way the wind arrows on the
// weather layer, the outlook strip and the tap popup all point, so a glance
// at any of them reads the same. Noto Sans carries all eight, and the glyph
// range they live in ships with the offline font set.
const WIND_ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘']

function windArrow(fromDeg: number): string {
  return WIND_ARROWS[Math.round(fromDeg / 45) % 8]
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

  // Tiled no finer than z13: geojson sources default to z18, so a pitched
  // chart at the helm kept a dozen tiles of this source alive per zoom and
  // asked the worker for fresh ones on every move. At z13 a tile unit is
  // ~1.2 m — finer than a pixel at any zoom the chart reaches — and the
  // view is three or four tiles.
  map.addSource('route', { type: 'geojson', maxzoom: 13, data: emptyFc() })

  // The run's own source, separate from `route` so the editing interactions
  // (drag handles, the fat hit target) keep working on untouched geometry.
  // lineMetrics is what makes `line-progress` — and so `line-gradient` —
  // available at all.
  map.addSource('run', { type: 'geojson', maxzoom: 13, lineMetrics: true, data: emptyFc() })
  // the rake: crests combed off the run, an ADDITIVE layer over the lanes
  map.addSource('rake', { type: 'geojson', maxzoom: 12, data: emptyFc() })
  map.addSource('run-shallow', { type: 'geojson', maxzoom: 13, data: emptyFc() })

  map.addLayer({
    id: 'route-line-casing',
    type: 'line',
    source: 'route',
    filter: ROUTE_LINE_FILTER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(8, 20, 34, 0.85)', 'line-width': 7 },
  })

  // Two lanes carrying the sea state at the minute the boat is on them: the
  // way out and the way home, which on this lake are routinely two different
  // afternoons. Both take the SAME positive offset — MapLibre offsets a line
  // to the right of its own direction of travel, and the return geometry runs
  // the other way, so they separate themselves onto opposite sides. Offset is
  // in screen pixels, so the lanes stay equally spaced at every zoom.
  for (const lane of ['out', 'back'] as const) {
    map.addLayer({
      id: `run-${lane}`,
      type: 'line',
      source: 'run',
      filter: ['==', ['get', 'lane'], lane],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        // Offset has to grow as the lanes thin out, or at bay zoom the two
        // merge into a single band and the whole point of them is lost.
        'line-offset': ['interpolate', ['linear'], ['zoom'], 8, 4, 11, 4.5, 15, 6],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.6, 11, 3.4, 15, 6],
        // replaced with a line-progress ramp whenever there's a plan
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, SEA_UNKNOWN, 1, SEA_UNKNOWN],
      },
    })
  }

  // Where the course crosses charted water under 2 m, it says so: the same
  // salmon the chart's shallow tint wears, dashed down the centreline between
  // the lanes. Prefer deep water, penalize sub-2 m — and when the router does
  // thread shallow, the person at the wheel sees exactly where.
  map.addLayer({
    id: 'run-shallow',
    type: 'line',
    source: 'run-shallow',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': 'rgba(255, 138, 128, 0.95)',
      'line-width': 3,
      'line-dasharray': [1.2, 1.6],
    },
  })
  // The wave rake. The lanes carry HEIGHT as colour; this carries which way
  // the sea is running, which is the thing that decides how a crossing
  // actually feels and which nothing else on the chart can say. Additive:
  // turning it on doesn't turn the lanes off, because they use different
  // channels. Off by default — it's for while you're deciding.
  // Swell bands: a wide haze with a softer core over it, so each crest has a
  // soft edge instead of a hard one. Blended, not stamped on — close enough to
  // the water's own colour to read as texture in the chart rather than as
  // notation lying over it. Height stays the lanes' job; this only says which
  // way the sea runs.
  map.addLayer({
    id: 'run-rake-haze',
    type: 'line',
    source: 'rake',
    filter: ['==', ['get', 'kind'], 'crest'],
    layout: { 'line-cap': 'round', visibility: 'none' },
    paint: {
      'line-color': '#bcdcf0',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.13, 13, 0.2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 9, 13, 16],
    },
  })
  map.addLayer({
    id: 'run-rake',
    type: 'line',
    source: 'rake',
    filter: ['==', ['get', 'kind'], 'crest'],
    layout: { 'line-cap': 'round', visibility: 'none' },
    paint: {
      'line-color': '#cfe6f5',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.24, 13, 0.36],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 13, 7],
    },
  })
  // Wind, alongside the waves and deliberately NOT animated — two moving
  // systems at once is unreadable, and on this lake the wind and the sea are
  // routinely twenty or thirty degrees apart, which is the thing worth seeing.
  map.addLayer({
    id: 'run-wind',
    type: 'symbol',
    source: 'rake',
    filter: ['==', ['get', 'kind'], 'wind'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'arrow'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 15,
      'text-allow-overlap': true,
      // clear of the leg dot and its crests, which sit on the same point
      'text-offset': [0, -1.3],
    },
    paint: {
      'text-color': '#9fe8ff',
      'text-halo-color': 'rgba(8, 20, 34, 0.85)',
      'text-halo-width': 1.3,
    },
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
    // The label budget. Every leg carrying its own two-line readout put ten
    // labels over the water and made the chart unreadable; the lanes already
    // say what the conditions are along the run. So: the roughest leg (and
    // only when it actually stands above the rest), plus whichever dot you
    // tapped. Everything else is a tap away.
    filter: [
      'all',
      ['==', ['get', 'kind'], 'sample'],
      ['boolean', ['get', 'showLabel'], false],
    ],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-max-width': 14,
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

  // fresh layers wear the default flat ramp; forget what the last map's wore
  lastRamp.clear()
  layersOn = map
}

function buildFc(): FeatureCollection {
  const { route, plan, destination, viaPoints, startPoint, startFrom } = useRouteStore.getState()
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
    // can wear the rougher of its two passes
    const nOut = outboundCount(plan)

    // The roughest leg of the way out — the one label the budget always
    // affords. It only earns it by standing a band above the rest of the run:
    // on a flat day every leg is the same water and the gradient has said so
    // already, so nothing gets labelled.
    let peakIdx = -1
    let peakBand = -1
    let lowBand = Number.MAX_SAFE_INTEGER
    for (let i = 0; i < nOut; i++) {
      const b = seaBand(plan.samples[i].waveM)
      if (b == null) continue
      if (b > peakBand) {
        peakBand = b
        peakIdx = i
      }
      if (b < lowBand) lowBand = b
    }
    if (peakBand <= lowBand) peakIdx = -1

    for (let i = 0; i < nOut; i++) {
      const out = plan.samples[i]
      const backIdx = 2 * nOut - 2 - i
      const back = backIdx > i && backIdx < plan.samples.length ? plan.samples[backIdx] : null
      // the dot wears the bigger of the two passes, on the sea-state ramp —
      // a magnitude, not a verdict about the trip
      const worstWave = Math.max(out.waveM ?? -1, back?.waveM ?? -1)
      // The label names the rougher of the two passes. No "out"/"back" words
      // are needed — the clock time already says which leg it is, and the two
      // coloured lanes have said the rest.
      const worst = back != null && (back.waveM ?? -1) > (out.waveM ?? -1) ? back : out
      const focused =
        focus != null && Math.abs(focus.lon - out.lon) < 1e-6 && Math.abs(focus.lat - out.lat) < 1e-6

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [out.lon, out.lat] },
        properties: {
          kind: 'sample',
          color: seaColor(worstWave < 0 ? null : worstWave),
          showLabel: focused || i === peakIdx,
          label: sampleLabel(worst, showPeriod),
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
  } else if (startFrom === 'home' && route) {
    // the boat isn't on the water, so the run was planned from the home base.
    // Unsaid, that reads as a trip from where you're standing — mark it.
    const h = homeBase()
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: route.coords[0] },
      properties: { kind: 'start', label: h ? `From ${h.name}` : 'From home base' },
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

/** How many samples belong to the way out (the rest are the ride home). */
function outboundCount(plan: { samples: TripSample[] }): number {
  return plan.samples.filter(
    (s) => s.phase === 'depart' || s.phase === 'outbound' || s.phase === 'arrive',
  ).length
}

/**
 * The two lanes. Same coordinates both ways — the ride home retraces the
 * plotted course — with the return reversed so its direction of travel is
 * genuinely opposite, which is what makes one shared `line-offset` put them
 * on opposite sides.
 */
function buildRunFc(): FeatureCollection {
  const { route, plan, roundTrip, tripStartedAt } = useRouteStore.getState()
  if (!route || route.coords.length < 2) return emptyFc()

  const features: Feature[] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coords },
      properties: { lane: 'out' },
    },
  ]
  // no second lane on a one-way run, and none once under way on the ride home:
  // by then the outbound lane IS history and the plan has flipped to the return
  const hasBack = roundTrip && tripStartedAt == null && plan != null && plan.homeMs != null
  if (hasBack) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [...route.coords].reverse() },
      properties: { lane: 'back' },
    })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * A `line-progress` colour ramp from the leg's samples.
 *
 * No resampling is needed to make this line up with the clock: line-progress
 * is a fraction of DISTANCE along the feature, and at a constant cruise speed
 * distance and time are the same axis — so a stop at fraction f is the sea the
 * boat meets at depart + f x duration, wherever the router happened to put its
 * sample points.
 */
function gradientStops(
  samples: TripSample[],
  fracOf: (s: TripSample) => number,
  highlight: number | null = null,
): (number | string)[] | null {
  const base: [number, string][] = []
  let last = -1
  for (const s of samples) {
    const f = Math.min(1, Math.max(0, fracOf(s)))
    // strictly increasing, or MapLibre rejects the whole expression
    if (f <= last) continue
    last = f
    base.push([f, seaColor(s.waveM)])
  }
  if (base.length < 2) return null
  // anchor both ends so the ramp covers the full lane rather than fading out
  if (base[0][0] !== 0) base.unshift([0, base[0][1]])
  if (base[base.length - 1][0] !== 1) base.push([1, base[base.length - 1][1]])

  /** The band colour at any fraction — needed so the highlight is a brighter
   *  patch of THIS water rather than a colour of its own. */
  const colourAt = (f: number): string => {
    let c = base[0][1]
    for (const [bf, bc] of base) {
      if (bf > f) break
      c = bc
    }
    return c
  }

  const pts: [number, string][] = [...base]
  if (highlight != null) {
    // A comet, not a symmetrical crest: the head is where the light is and the
    // tail falls away behind it, which is what makes the direction readable
    // without anything being drawn on top. Kept deliberately faint — the wave
    // bands are the information, and this only has to move.
    for (const [off, amt] of [
      [-HL_TAIL, 0],
      [-HL_TAIL * 0.55, HL_PEAK * 0.25],
      [-HL_TAIL * 0.22, HL_PEAK * 0.6],
      [0, HL_PEAK],
      [HL_TAIL * 0.06, 0],
    ]) {
      const f = highlight + off
      if (f <= 0 || f >= 1) continue
      pts.push([f, amt === 0 ? colourAt(f) : lighten(colourAt(f), amt)])
    }
  }

  pts.sort((a, b) => a[0] - b[0])
  const stops: (number | string)[] = []
  let prev = -1
  for (const [f, c] of pts) {
    // MapLibre needs strictly increasing stops; nudge ties rather than drop
    // them, so a highlight landing on a band edge still renders
    const v = f <= prev ? prev + 1e-4 : f
    if (v >= 1 && stops.length >= 4) continue
    prev = v
    stops.push(v, c)
  }
  return stops.length >= 4 ? stops : null
}

const FLAT_UNKNOWN = ['interpolate', ['linear'], ['line-progress'], 0, SEA_UNKNOWN, 1, SEA_UNKNOWN]

/** Half-length of a crest, in degrees of latitude. */
const RAKE_HALF_DEG = 0.0062
/** Arc spacing between crests along the course, in nautical miles. */
const RAKE_STEP_NM = 0.3
/** Ceiling on crests per run, so a long passage stays cheap. */
const RAKE_MAX = 120

/** Wave direction at the sample nearest a point — crests are laid along the
 *  course, not at the samples, so each one looks its own sea up. */
function seaDirAt(samples: TripSample[], lon: number, lat: number): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (const s of samples) {
    if (s.waveDir == null) continue
    const d = (s.lon - lon) ** 2 + (s.lat - lat) ** 2
    if (d < bestD) {
      bestD = d
      best = s.waveDir
    }
  }
  return best
}

/** Cumulative arc length along a polyline, in nm. */
function cumulative(coords: [number, number][]): number[] {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    cum.push(
      cum[i - 1] + haversineNm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]),
    )
  }
  return cum
}

/**
 * The rake: crests combed off the course itself, all the way along it.
 *
 * Laying them ON the path rather than clustering them at the leg points is
 * what makes it read — the run gets a texture instead of five clumps of
 * diagonals, and every crest sits on water the boat will actually cross. Each
 * is angled by the sea at that spot, so read against the course it tells you
 * whether the sea lands on the nose or the beam.
 *
 * Every crest carries `d`, its fraction along the course. That is what lets
 * the sweep reveal them as a trail: the layer's FILTER moves, which is cheap,
 * instead of the geometry being rebuilt sixty times a second.
 */
function buildRakeFc(): FeatureCollection {
  const { route, plan } = useRouteStore.getState()
  if (!route || !plan || route.coords.length < 2) return emptyFc()
  const coords = route.coords
  const features: Feature[] = []

  const cum = cumulative(coords)
  const total = cum[cum.length - 1]
  if (total <= 0) return emptyFc()

  const step = Math.max(RAKE_STEP_NM, total / RAKE_MAX)
  let seg = 1
  for (let d = 0; d < total; d += step) {
    while (seg < cum.length - 1 && cum[seg] < d) seg++
    const t = (d - cum[seg - 1]) / Math.max(1e-9, cum[seg] - cum[seg - 1])
    const lon = coords[seg - 1][0] + (coords[seg][0] - coords[seg - 1][0]) * t
    const lat = coords[seg - 1][1] + (coords[seg][1] - coords[seg - 1][1]) * t

    const dir = seaDirAt(plan.samples, lon, lat)
    if (dir == null) continue
    const kx = 1 / Math.cos((lat * Math.PI) / 180)
    // A broad soft band lying across the way the sea travels — swell, not
    // notation. Chevrons said the direction louder but read as road marking;
    // a band is the shape water actually makes, and drawn wide and faint it
    // sits in the chart instead of on top of it.
    const crestRad = ((dir + 90) * Math.PI) / 180
    const aLat = Math.cos(crestRad) * RAKE_HALF_DEG
    const aLon = Math.sin(crestRad) * RAKE_HALF_DEG * kx
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon - aLon, lat - aLat],
          [lon + aLon, lat + aLat],
        ],
      },
      // `dir` rides along so an animation can move a crest the way its own
      // sea travels, without re-deriving anything from the plan
      properties: { kind: 'crest', d: d / total, dir },
    })
  }

  // wind stays at the leg points and stays still — two moving systems at once
  // is unreadable, and the wind is often well off the sea's own direction
  for (const s of plan.samples) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { kind: 'wind', arrow: windArrow(s.windDir) },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** How long the comet's tail is, as a fraction of the lane. */
const HL_TAIL = 0.26
/** How bright its head gets. Subtle on purpose: the swell bands carry the
 *  information, and this only has to say which way and that it's live. */
const HL_PEAK = 0.34

/** The stretches of the plotted course that cross charted water under 2 m —
 *  sampled every ~60 m along the line off the offline depth grid. */
const SHALLOW_MARK_M = 2
function buildShallowFc(): FeatureCollection {
  const { route } = useRouteStore.getState()
  if (!route || route.coords.length < 2) return emptyFc()
  const lines: [number, number][][] = []
  let cur: [number, number][] | null = null
  const endRun = () => {
    if (cur && cur.length > 1) lines.push(cur)
    cur = null
  }
  for (let i = 0; i < route.coords.length - 1; i++) {
    const a = route.coords[i]
    const b = route.coords[i + 1]
    const mLat = 110540
    const mLon = 111320 * Math.cos((a[1] * Math.PI) / 180)
    const segM = Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * mLat)
    const n = Math.max(1, Math.ceil(segM / 60))
    for (let k = 0; k < n; k++) {
      const p0: [number, number] = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
      const p1: [number, number] = [
        a[0] + ((b[0] - a[0]) * (k + 1)) / n,
        a[1] + ((b[1] - a[1]) * (k + 1)) / n,
      ]
      const d = depthAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
      if (d != null && d >= 0 && d < SHALLOW_MARK_M) {
        if (!cur) cur = [p0]
        cur.push(p1)
      } else endRun()
    }
  }
  endRun()
  return {
    type: 'FeatureCollection',
    features: lines.map((c) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: c },
      properties: {},
    })),
  }
}

/**
 * The run's geometry: the rake, the lanes and the shallow marks, rebuilt from
 * the store. Three setData round-trips to the worker — and a depth sample
 * every ~60 m of course for the shallow marks — so this runs on route and
 * plan changes ONLY, never per animation frame. The comet lives in paintRun,
 * which touches no source at all; that is what lets the `run` source reach
 * (and stay in) its loaded state while the light moves.
 */
function renderRunGeometry(map: MlMap) {
  const rakeSrc = map.getSource('rake') as GeoJSONSource | undefined
  if (rakeSrc) {
    rakeSrc.setData(buildRakeFc())
    // The rake has no user toggle any more — the sea-flow layer superseded
    // it (crests on the whole lake, the run's water included). The layers
    // stay for the crest-pass animation trials, which borrow them here.
    const on = isRakeForced()
    for (const id of ['run-rake', 'run-rake-haze', 'run-wind']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    }
  }

  const src = map.getSource('run') as GeoJSONSource | undefined
  if (!src) return
  src.setData(buildRunFc())
  ;(map.getSource('run-shallow') as GeoJSONSource | undefined)?.setData(buildShallowFc())
}

/** One lane's ramp — sent only when it differs from what the lane already wears. */
function setRamp(map: MlMap, id: string, stops: (number | string)[] | null) {
  const key = stops ? stops.join(',') : 'flat'
  if (lastRamp.get(id) === key) return
  lastRamp.set(id, key)
  map.setPaintProperty(
    id,
    'line-gradient',
    stops ? ['interpolate', ['linear'], ['line-progress'], ...stops] : FLAT_UNKNOWN,
  )
}

/**
 * Repaint both lanes.
 *
 * `highlight` (0..1, or null) slides a crest of light along each lane inside
 * its own gradient — the lane brightens where the light is and settles back
 * behind it. Motion carried by the colour ramp rather than by dashes riding on
 * top: nothing is added to the chart, the water just moves. Each lane's
 * geometry runs its own way, so one shared value sends the light out along one
 * and home along the other.
 *
 * Paint only: two `line-gradient` expressions, no source data. MapLibre
 * re-renders a lane's gradient texture from the new ramp without reloading
 * the tile, which is why this is cheap enough to run at 25 fps.
 */
function paintRun(
  map: MlMap,
  highlight: number | null = null,
  lane: 'out' | 'back' | 'both' = 'both',
) {
  if (!map.getLayer('run-out')) return
  const { plan } = useRouteStore.getState()

  if (!plan || plan.samples.length < 2 || plan.oneWayNm <= 0) {
    // a route with no forecast yet: neutral grey, never a pale ramp colour —
    // pale reads as calm, and "we don't know" is not calm
    setRamp(map, 'run-out', null)
    setRamp(map, 'run-back', null)
    return
  }

  const nOut = outboundCount(plan)
  const out = plan.samples.slice(0, nOut)
  setRamp(
    map,
    'run-out',
    gradientStops(out, (s) => s.distNm / plan.oneWayNm, lane !== 'back' ? highlight : null),
  )

  const back = plan.samples.slice(nOut)
  const backSpan = plan.totalNm - plan.oneWayNm
  setRamp(
    map,
    'run-back',
    backSpan > 0
      ? gradientStops(
          back,
          (s) => (s.distNm - plan.oneWayNm) / backSpan,
          lane !== 'out' ? highlight : null,
        )
      : null,
  )
}

/** Slide the lanes' highlight without touching anything else — paint only,
 *  no source is rebuilt. `lane` narrows the light to one lane, for animations
 *  that take the run one way at a time. */
export function setLaneHighlight(
  map: MlMap,
  highlight: number | null,
  lane: 'out' | 'back' | 'both' = 'both',
) {
  if (layersOn !== map) return
  paintRun(map, highlight, lane)
}

/** Rebuild the run's sources from the store — for a caller that has been
 *  drawing its own geometry into them (the crest-variant trials borrow the
 *  rake) and is handing them back. Not for the animation loop. */
export function refreshRunGeometry(map: MlMap) {
  if (layersOn !== map) return
  renderRunGeometry(map)
}

function render(map: MlMap) {
  if (layersOn !== map) return
  renderRunGeometry(map)
  paintRun(map)
  // the handles grow while the course is editable — the only on-map sign that
  // a press will now do something, and the thing you have to hit to drag
  const editing = useRouteStore.getState().editing
  map.setPaintProperty('route-vias', 'circle-radius', editing ? 9 : 6.5)
  map.setPaintProperty('route-vias', 'circle-stroke-width', editing ? 3.5 : 2.5)
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
    // the outlook strip (plus its focus chip, which is exactly what a fresh
    // route adds) is real chrome too — measure it, or the far end of the run
    // frames underneath it
    const topH = document.querySelector('.toparea')?.getBoundingClientRect().height ?? 110
    // ...and so is the FAB column: without this an endpoint that lands on the
    // right edge sits BEHIND the locate button, and "zoom to see the whole
    // run" quietly fails at exactly one screen edge
    const fabW = document.querySelector('.fabstack')?.getBoundingClientRect().width ?? 46
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: {
          top: Math.round(topH) + 24,
          // 56 keeps an endpoint's own label on screen, not just its dot
          left: 56,
          right: Math.max(56, Math.round(fabW) + 24),
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
  if (!useRouteStore.getState().editing) return // the course is read-only outside edit mode
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
    // The endpoints and existing course points keep their own gestures. The
    // ETA sample dots deliberately DON'T block here: beginDrag only acts in
    // edit mode, and in edit mode those dots are just paint riding the line
    // — they're the most visible thing on it, so pressing one is the natural
    // way to grab the course. (Outside edit mode their tap still points the
    // strip; this handler is inert then.)
    const covered = map.queryRenderedFeatures(e.point, {
      layers: ['route-vias', 'route-dest', 'route-start'],
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
    initRunAnimation(map)

    // tap near a leg dot → point the top forecast strip at that spot
    // (tap again to release); padded hit-test so fingers don't have to be exact
    map.on('click', (e) => {
      if (routeEditedRecently()) return // the click that ends an edit gesture
      if (useMeasureStore.getState().active) return
      if (useAppStore.getState().pickingHome) return // the home pick owns the tap
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

  // the watched spots as badges on the chart — the map is the selector
  // (§0.2). After the dot handler above, so a leg dot wins a contested tap.
  initSpotBadges()

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
      s.startPoint !== prev.startPoint ||
      s.editing !== prev.editing
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
    // raising the dock is the route drawer's old "open the run" moment now
    if (s.detent === 'raised' && prev.detent !== 'raised') refit()
    // the leg labels carry the period and the wind, so both have to reach
    // them; the lanes and dots wear the ramp, so its scale does too
    if (
      s.wavePeriod !== prev.wavePeriod ||
      s.windUnit !== prev.windUnit ||
      s.seaScaleM !== prev.seaScaleM
    ) {
      const live = getMap()
      if (live && layersOn === live) render(live)
    }
  })
}
