import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { REGION_BBOX } from '../config'
import { onEachMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { depthAt } from '../map/depthGrid'
import { applyWaveOverlay, refreshWaveOverlay, waveOverlayAgeMs, waveOverlayInfo } from './rdwps'
import {
  applyWindOverlay,
  onWindOverlay,
  refreshWindOverlay,
  windOverlayAgeMs,
  windOverlayInfo,
  windOverlayStatus,
} from './hrdps'
import { SEA_BANDS, seaBounds, seaScaleK } from './seaState'
import { speedUnitLabel, windSpeed, type SpeedUnit } from '../units'
import { floorHourMs } from '../time'
import { cachedPointForecast, dressPointForecast, type PointForecast } from './openMeteo'
import {
  cachedGridForecast,
  fetchGridForecast,
  GRID_SHAPE,
  hourIndexAt,
  OUTLOOK_FROM_H,
  OUTLOOK_TO_H,
  type GridCell,
  type GridForecast,
  type RouteForecast,
  type RoutePointWx,
} from './openMeteo'

/**
 * Wind + wave map layer. One fixed forecast grid over the cruising region,
 * rendered as soft wave-height blobs with wind arrows on top. Always shows
 * the app-wide planning time (appStore.planTimeMs; null = now) — the same
 * moment the outlook strip has selected and the trip planner departs at.
 */

let grid: GridForecast | null = null
let gridStale = false
// the map the layers live on, so a replacement map re-adds them instead of
// silently swallowing every setData (see onEachMap)
let layersOn: MlMap | null = null

const GRID_MAX_AGE_MS = 30 * 60_000
// About ten arrows on screen, whatever the screen. A COUNT, not a pixel
// spacing: the forecast holds a fixed amount of information — 56 points over
// the whole region — and a wider display adds none of it. Sizing by spacing
// let a desktop ask for more columns than the grid has, and the halving below
// obliged by subdividing past the source: 45 arrows carrying two distinct
// values on a 1600px screen, ~112 on a 2548px one.
const TARGET_ARROWS = 10
const MAX_ARROWS = 400 // backstop against a pathological viewport

const ARROW_BUCKETS = [
  { id: 'wx-arrow-0', color: '#7fd4e8', max: 8 }, // light
  { id: 'wx-arrow-1', color: '#8be08f', max: 12 }, // moderate
  { id: 'wx-arrow-2', color: '#ffd166', max: 16 }, // fresh
  { id: 'wx-arrow-3', color: '#ff9f43', max: 22 }, // strong
  { id: 'wx-arrow-4', color: '#ff6b6b', max: Infinity }, // very strong
]

function makeArrowImage(color: string): ImageData {
  const size = 44
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  // arrow pointing up (rotated by wind direction at render time)
  ctx.beginPath()
  ctx.moveTo(0, -15)
  ctx.lineTo(8, 11)
  ctx.lineTo(0, 6)
  ctx.lineTo(-8, 11)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(8, 20, 34, 0.9)'
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

/** The sea's travel arrow — a foam-coloured chevron over a shaft, so it can't
 *  be read as one of the wind buckets' filled kites. Drawn pointing up and
 *  rotated per feature at render time, same convention as the wind arrows. */
function makeWaveArrowImage(): ImageData {
  const size = 36
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const draw = () => {
    ctx.beginPath()
    ctx.moveTo(0, 9)
    ctx.lineTo(0, -7)
    ctx.moveTo(-5.5, -1.5)
    ctx.lineTo(0, -8)
    ctx.lineTo(5.5, -1.5)
    ctx.stroke()
  }
  // dark halo pass first, foam stroke over it — same contrast recipe as the
  // text halos, so the arrow survives any water colour beneath it
  ctx.strokeStyle = 'rgba(8, 20, 34, 0.9)'
  ctx.lineWidth = 5
  draw()
  ctx.strokeStyle = 'rgba(232, 246, 255, 0.95)'
  ctx.lineWidth = 2.4
  draw()
  return ctx.getImageData(0, 0, size, size)
}

// The sea-state ramp's own hues (weather/seaState.ts), with alpha — the
// blobs, the strip and the lanes must tell one colour story. The stop
// heights were laid out on the base ramp and scale with the skipper's
// sea-state anchor exactly as the bands do.
const BLOB_STOPS: [number, string][] = [
  [0, 'rgba(185, 239, 173, 0.0)'],
  [0.3, 'rgba(127, 220, 106, 0.4)'],
  [0.8, 'rgba(242, 197, 61, 0.5)'],
  [1.5, 'rgba(233, 110, 63, 0.55)'],
  [2.2, 'rgba(199, 79, 134, 0.6)'],
  [3.0, 'rgba(123, 45, 143, 0.65)'],
]

function waveBlobColor(roughM?: number): never {
  const k = seaScaleK(roughM)
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'wave'], 0],
    ...BLOB_STOPS.flatMap(([h, c]) => [Math.round(h * k * 100) / 100, c]),
  ] as never
}

// step through the ramp's own band bounds, so a number and a crest would
// always have told the same colour story
function waveNumColor(roughM?: number): never {
  const bounds = seaBounds(roughM)
  return [
    'step',
    ['coalesce', ['get', 'wave'], 0],
    SEA_BANDS[0].color,
    ...SEA_BANDS.slice(0, -1).flatMap((_, i) => [bounds[i], SEA_BANDS[i + 1].color]),
  ] as never
}

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return

  for (const b of ARROW_BUCKETS) {
    if (!map.hasImage(b.id)) map.addImage(b.id, makeArrowImage(b.color), { pixelRatio: 2 })
  }
  if (!map.hasImage('wx-wave-arrow')) {
    map.addImage('wx-wave-arrow', makeWaveArrowImage(), { pixelRatio: 2 })
  }

  map.addSource('wx', { type: 'geojson', data: emptyFc() })

  map.addLayer({
    id: 'wx-wave',
    type: 'circle',
    source: 'wx',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 26, 11, 64],
      'circle-blur': 1.1,
      'circle-opacity': 0.55,
      'circle-color': waveBlobColor(),
    },
  })

  // Low power's stand-in for the sea-flow crests: the same lattice, wave
  // heights as plain numbers wearing the sea-state ramp's colour — the
  // information without the animation. Visibility is render()'s call.
  map.addLayer({
    id: 'wx-wave-num',
    type: 'symbol',
    source: 'wx',
    layout: {
      visibility: 'none',
      'text-field': ['get', 'waveText'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      // above the point — the wind arrow's own label sits below it
      'text-offset': [0, -1.1],
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': waveNumColor(),
      'text-halo-color': 'rgba(8, 20, 34, 0.85)',
      'text-halo-width': 1.3,
    },
  })

  // …and where that sea is GOING — the direction the crests were carrying
  // before they stood down. Its own layer, nudged above the number with a
  // screen-space translate: icon-offset rotates with the icon, and a rotated
  // offset would smear the number/arrow cluster all over the lattice point.
  map.addLayer({
    id: 'wx-wave-dir',
    type: 'symbol',
    source: 'wx',
    filter: ['all', ['!=', ['get', 'waveText'], ''], ['==', ['get', 'hasWaveDir'], true]],
    layout: {
      visibility: 'none',
      'icon-image': 'wx-wave-arrow',
      'icon-rotate': ['get', 'waveArrow'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.8, 11, 1.1],
    },
    paint: {
      'icon-translate': [0, -34],
      'icon-translate-anchor': 'viewport',
    },
  })

  map.addLayer({
    id: 'wx-wind',
    type: 'symbol',
    source: 'wx',
    layout: {
      visibility: 'none',
      'icon-image': [
        'step',
        ['get', 'wind'],
        'wx-arrow-0',
        ARROW_BUCKETS[0].max,
        'wx-arrow-1',
        ARROW_BUCKETS[1].max,
        'wx-arrow-2',
        ARROW_BUCKETS[2].max,
        'wx-arrow-3',
        ARROW_BUCKETS[3].max,
        'wx-arrow-4',
      ],
      'icon-rotate': ['get', 'arrowDir'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.8, 11, 1.25],
      // pre-formatted: `wind` stays in knots for the icon buckets below, whose
      // thresholds are Beaufort-ish and unit-bound
      'text-field': ['get', 'windText'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.6],
      'text-allow-overlap': true,
      'text-optional': true,
    },
    paint: {
      'text-color': 'rgba(220, 240, 255, 0.9)',
      'text-halo-color': 'rgba(8, 20, 34, 0.85)',
      'text-halo-width': 1.2,
    },
  })

  // the lattice spans the viewport, so panning and zooming rebuild it
  map.on('moveend', () => render(map))

  layersOn = map
}

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

// Wind blows over land (windy.com convention — the arrows stay), but a wave
// height quoted on a forest is a lie. Same shoreline mask the sea-flow crests
// use: the offline depth grid, with its shallow cutoff.
const MIN_WATER_M = 0.3

function waveTextAt(wave: number | null, lon: number, lat: number): string {
  if (wave == null) return ''
  const d = depthAt(lon, lat)
  return d != null && d >= MIN_WATER_M ? `${wave.toFixed(1)}m` : ''
}

/** The old rendering: one feature per forecast cell. Kept for a grid cached
 *  by an earlier build, whose shape this one can't assume. */
function fcAtCells(g: GridForecast, i: number, windUnit: SpeedUnit): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: g.cells.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: {
        wind: c.windKn[i] ?? 0,
        gust: c.gustKn[i] ?? 0,
        // wind_direction is where wind comes FROM; arrow points where it blows TO
        arrowDir: ((c.windDir[i] ?? 0) + 180) % 360,
        wave: c.waveM[i],
        windText: `${windSpeed(windUnit, c.windKn[i] ?? 0)} ${speedUnitLabel(windUnit)}`,
        waveText: waveTextAt(c.waveM[i] ?? null, c.lon, c.lat),
        // wave_direction is where the sea comes FROM; the arrow points where it travels
        hasWaveDir: c.waveDir?.[i] != null,
        waveArrow: ((c.waveDir?.[i] ?? 0) + 180) % 360,
      },
    })),
  }
}

interface Field {
  lon0: number
  lat0: number
  dLon: number
  dLat: number
  cols: number
  rows: number
}

/** The regional grid read as a regular lattice. Null for a cached grid whose
 *  shape doesn't match this build's — fcAtCells covers that. */
function fieldOf(g: GridForecast): Field | null {
  const { cols, rows } = GRID_SHAPE
  if (cols < 2 || rows < 2 || g.cells.length !== cols * rows) return null
  const dLon = g.cells[1].lon - g.cells[0].lon
  const dLat = g.cells[cols].lat - g.cells[0].lat
  if (!dLon || !dLat) return null
  return { lon0: g.cells[0].lon, lat0: g.cells[0].lat, dLon, dLat, cols, rows }
}

interface Sample {
  wind: number
  gust: number
  dir: number
  wave: number | null
  period: number | null
  waveDir: number | null
  precip: number | null
  water: number | null
}

/**
 * Bilinear sample of the forecast field. Speeds and heights interpolate as
 * plain scalars; direction goes through unit vectors, because averaging 359°
 * and 1° as numbers points the arrow due south. Corners are clamped rather
 * than extrapolated, so the edge of the region holds its own value.
 */
function sampleField(g: GridForecast, f: Field, i: number, lon: number, lat: number): Sample {
  const fx = (lon - f.lon0) / f.dLon
  const fy = (lat - f.lat0) / f.dLat
  const x0 = Math.min(f.cols - 2, Math.max(0, Math.floor(fx)))
  const y0 = Math.min(f.rows - 2, Math.max(0, Math.floor(fy)))
  const tx = Math.min(1, Math.max(0, fx - x0))
  const ty = Math.min(1, Math.max(0, fy - y0))
  const corners: [GridCell, number][] = [
    [g.cells[y0 * f.cols + x0], (1 - tx) * (1 - ty)],
    [g.cells[y0 * f.cols + x0 + 1], tx * (1 - ty)],
    [g.cells[(y0 + 1) * f.cols + x0], (1 - tx) * ty],
    [g.cells[(y0 + 1) * f.cols + x0 + 1], tx * ty],
  ]

  let wind = 0
  let gust = 0
  let u = 0
  let v = 0
  let wave = 0
  let waveW = 0
  let period = 0
  let periodW = 0
  let water = 0
  let waterW = 0
  let precip = 0
  let precipW = 0
  let wdU = 0
  let wdV = 0
  let wdW = 0
  for (const [c, w] of corners) {
    if (!c || !w) continue
    const kn = c.windKn[i] ?? 0
    wind += kn * w
    gust += (c.gustKn[i] ?? kn) * w
    const rad = ((c.windDir[i] ?? 0) * Math.PI) / 180
    u += Math.sin(rad) * w
    v += Math.cos(rad) * w
    const h = c.waveM[i]
    if (h != null) {
      wave += h * w
      waveW += w
    }
    // optional-chained: a grid cached before periods were fetched has no array
    const p = c.wavePeriodS?.[i]
    if (p != null) {
      period += p * w
      periodW += w
    }
    // optional-chained: a grid cached before rain chance was fetched has no array
    const wt = c.waterTempC?.[i]
    if (wt != null) {
      water += wt * w
      waterW += w
    }
    const pr = c.precipProbPct?.[i]
    if (pr != null) {
      precip += pr * w
      precipW += w
    }
    // like windDir: unit vectors, not degrees — and only corners that know
    const wd = c.waveDir?.[i]
    if (wd != null) {
      const wr = (wd * Math.PI) / 180
      wdU += Math.sin(wr) * w
      wdV += Math.cos(wr) * w
      wdW += w
    }
  }
  return {
    wind,
    gust,
    dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
    // a partly-covered corner set still gives a height, just from what it had
    wave: waveW > 0 ? wave / waveW : null,
    period: periodW > 0 ? period / periodW : null,
    waveDir: wdW > 0 ? ((Math.atan2(wdU, wdV) * 180) / Math.PI + 360) % 360 : null,
    water: waterW > 0 ? water / waterW : null,
    precip: precipW > 0 ? precip / precipW : null,
  }
}

/**
 * The lattice spacing: the grid's own step, halved until the arrows sit no
 * further apart than the target count asks for, and never coarser than the
 * grid itself. Halving rather than fitting the viewport exactly is what keeps
 * the lattice on fixed ground — a step derived from the live bounds re-spaces
 * on every pan, and the whole field crawls across the map with you.
 */
function latticeStep(native: number, want: number): number {
  // Negative steps COARSEN — doubling the native spacing rather than halving
  // it. Zoomed out past the region every native cell used to land on screen,
  // a wall of arrows; power-of-two multiples keep the coarser lattice
  // anchored on the same grid origin, so arrows still hold still while you
  // pan. Capped at 8× native (~100 km) — beyond that the region is a dot.
  const steps = Math.max(-3, Math.round(Math.log2(Math.abs(native) / want)))
  return Math.abs(native) / 2 ** steps
}

/**
 * Arrows on a lattice spanning the current view rather than on the forecast
 * grid's own points. The grid is one cell per ~13 x 15 km, so a phone zoomed
 * to a short trip sits INSIDE a single cell with nothing to draw — which is
 * exactly what it looked like: an empty map. Sampling the field instead keeps
 * arrows on screen at any zoom and costs no extra requests, and it claims no
 * false detail: the weather model's own resolution is ~10 km, so between two
 * cells there is nothing to know that interpolation doesn't already say.
 */
function fcForView(
  map: MlMap,
  g: GridForecast,
  targetMs: number,
  windUnit: SpeedUnit,
): FeatureCollection {
  const i = hourIndexAt(g.time, targetMs)
  const f = fieldOf(g)
  if (!f) return fcAtCells(g, i, windUnit)

  const b = map.getBounds()
  const cv = map.getCanvas()
  // spacing that lands TARGET_ARROWS across the viewport's area, so a phone and
  // a wide monitor show the same amount of field rather than the same density
  const spacing = Math.sqrt((cv.clientWidth * cv.clientHeight) / TARGET_ARROWS)
  const wantX = Math.max(2, Math.round(cv.clientWidth / spacing))
  const wantY = Math.max(2, Math.round(cv.clientHeight / spacing))
  const stepLon = latticeStep(f.dLon, (b.getEast() - b.getWest()) / wantX)
  const stepLat = latticeStep(f.dLat, (b.getNorth() - b.getSouth()) / wantY)

  // clipped to the charted region — the field says nothing about water the
  // grid doesn't cover, and edge-clamping out there would be an invention
  const west = Math.max(b.getWest(), REGION_BBOX.west)
  const east = Math.min(b.getEast(), REGION_BBOX.east)
  const south = Math.max(b.getSouth(), REGION_BBOX.south)
  const north = Math.min(b.getNorth(), REGION_BBOX.north)

  // anchored on the grid's own origin, so arrows hold still while you pan
  // instead of crawling with the viewport
  const lon0 = f.lon0 + Math.ceil((west - f.lon0) / stepLon) * stepLon
  const lat0 = f.lat0 + Math.ceil((south - f.lat0) / stepLat) * stepLat

  const features: FeatureCollection['features'] = []
  for (let lat = lat0; lat <= north && features.length < MAX_ARROWS; lat += stepLat) {
    for (let lon = lon0; lon <= east && features.length < MAX_ARROWS; lon += stepLon) {
      const s = sampleField(g, f, i, lon, lat)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          wind: s.wind,
          gust: s.gust,
          // wind_direction is where wind comes FROM; arrow points where it blows TO
          arrowDir: (s.dir + 180) % 360,
          wave: s.wave,
          windText: `${windSpeed(windUnit, s.wind)} ${speedUnitLabel(windUnit)}`,
          waveText: waveTextAt(s.wave, lon, lat),
          // wave_direction is where the sea comes FROM; the arrow points where it travels
          hasWaveDir: s.waveDir != null,
          waveArrow: ((s.waveDir ?? 0) + 180) % 360,
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Low power promised the wave INFO stays on the chart when the crests
 *  stand down — numbers whenever the crests would have been telling it (or
 *  the overlay is on, whose blobs colour but don't quote the height). */
function showWaveNumbers(): boolean {
  const { lowPower, layers } = useAppStore.getState()
  return lowPower && (layers.seaFlow || layers.weather)
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const { layers, planTimeMs, windUnit } = useAppStore.getState()
  const src = map.getSource('wx') as GeoJSONSource | undefined
  if (!src) return
  const nums = showWaveNumbers()
  src.setData(
    grid && (layers.weather || nums)
      ? fcForView(map, grid, planTimeMs ?? floorHourMs(), windUnit)
      : emptyFc(),
  )
  const vis = layers.weather ? 'visible' : 'none'
  map.setLayoutProperty('wx-wave', 'visibility', vis)
  map.setLayoutProperty('wx-wind', 'visibility', vis)
  map.setLayoutProperty('wx-wave-num', 'visibility', nums ? 'visible' : 'none')
  map.setLayoutProperty('wx-wave-dir', 'visibility', nums ? 'visible' : 'none')
}

let refreshing: Promise<{ fetchedAt: number; stale: boolean } | null> | null = null

// The grid is module state, not a store, so nothing tells a reader when it
// lands. The spot badges on the chart need exactly that moment — their
// numbers come out of this grid — so they register here rather than polling.
const gridListeners = new Set<() => void>()

/** Run `cb` every time a (re)fetched grid lands. Returns the unsubscribe. */
export function onWeatherGrid(cb: () => void): () => void {
  gridListeners.add(cb)
  return () => gridListeners.delete(cb)
}

export function refreshWeatherGrid(): Promise<{ fetchedAt: number; stale: boolean } | null> {
  // share one in-flight fetch across callers (strip taps, panel open)
  refreshing ??= (async () => {
    try {
      const { grid: g, stale } = await fetchGridForecast()
      grid = g
      gridStale = stale
      // the better waves: RDWPS 1 km cells overwrite the global model's for
      // the ~48 h it covers; Open-Meteo stands beyond and wherever it's null
      if (waveOverlayAgeMs() > 30 * 60_000) await refreshWaveOverlay()
      applyWaveOverlay(grid)
      // and the wind straight from ECCC: HRDPS via GeoMet overwrites
      // Open-Meteo's copy of the same model for the ~48 h the run covers —
      // so an Open-Meteo outage leaves the decision window's wind fresh
      // even when the grid underneath is the stale fallback. Its ~100
      // fetches are NOT waited for: dress with what's in hand, and the
      // onWindOverlay hook (init) re-dresses the grid when the rest lands.
      if (windOverlayAgeMs() > 30 * 60_000) void refreshWindOverlay()
      applyWindOverlay(grid)
      withMap((map) => {
        addLayers(map)
        render(map)
      })
      for (const cb of gridListeners) cb()
      return { fetchedAt: g.fetchedAt, stale }
    } catch {
      return null
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function weatherGridInfo(): {
  fetchedAt: number
  stale: boolean
  /** Non-null while RDWPS 1 km waves are overlaid on the grid. */
  waves: { model: string; run: string } | null
  /** Non-null while HRDPS wind from ECCC GeoMet is overlaid on the grid. */
  wind: { model: string; run: string } | null
} | null {
  return grid
    ? { fetchedAt: grid.fetchedAt, stale: gridStale, waves: waveOverlayInfo(), wind: windOverlayInfo() }
    : null
}

export interface GridConditions {
  windKn: number
  gustKn: number
  windDir: number
  waveM: number | null
  wavePeriodS: number | null
  /** Where the sea comes FROM, like windDir. Null before it was fetched. */
  waveDir: number | null
  /** Chance of precipitation, 0–100. Null for a grid cached before it was fetched. */
  precipProbPct: number | null
  waterTempC: number | null
  /** WMO code from the nearest cell — sky is not a thing to interpolate. */
  weatherCode: number | null
}

/**
 * Wind + waves at a point, at the hour containing `ms`.
 *
 * Interpolated across the lattice rather than snapped to the nearest cell:
 * cells are ~13 x 15 km, so two spots on opposite sides of a headland can
 * share one, and nearest-cell would report them as identical water. The
 * corner weights are null-aware (`sampleField`), so a point near shore reads
 * from whichever corners have wave data instead of blending in the land
 * cells' nulls as calm.
 *
 * Null until the grid has loaded — ensureWeatherGrid() populates it.
 */
export function gridConditionsAt(lon: number, lat: number, ms: number): GridConditions | null {
  if (!grid || grid.time.length === 0) return null
  const i = hourIndexAt(grid.time, ms)
  const f = fieldOf(grid)
  if (f) {
    const s = sampleField(grid, f, i, lon, lat)
    if (!Number.isFinite(s.wind)) return null
    return {
      windKn: s.wind,
      gustKn: s.gust,
      windDir: s.dir,
      waveM: s.wave,
      wavePeriodS: s.period,
      waveDir: s.waveDir,
      precipProbPct: s.precip,
      waterTempC: s.water,
      weatherCode: nearestCell(lon, lat)?.weatherCode?.[i] ?? null,
    }
  }

  // cached grid whose shape doesn't match this build — fall back to nearest cell
  const kx = Math.cos((lat * Math.PI) / 180) // a degree of lon is shorter than one of lat
  let best: GridCell | null = null
  let bestD = Infinity
  for (const c of grid.cells) {
    const d = ((c.lon - lon) * kx) ** 2 + (c.lat - lat) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  if (!best) return null
  const windKn = best.windKn[i]
  if (windKn == null) return null
  return {
    windKn,
    gustKn: best.gustKn[i] ?? windKn,
    windDir: best.windDir[i] ?? 0,
    waveM: best.waveM[i] ?? null,
    // optional-chained: a grid cached before periods were fetched has no array
    wavePeriodS: best.wavePeriodS?.[i] ?? null,
    waveDir: best.waveDir?.[i] ?? null,
    precipProbPct: best.precipProbPct?.[i] ?? null,
    waterTempC: best.waterTempC?.[i] ?? null,
    weatherCode: best.weatherCode?.[i] ?? null,
  }
}

/**
 * Resolves as soon as ANY grid is in hand. A stale one (including the
 * IndexedDB seed at startup) still answers now — last-known data beats a
 * spinner — while a refetch runs behind and notifies gridListeners when the
 * fresh copy lands. Only with no grid at all does the caller wait.
 */
export function ensureWeatherGrid(): Promise<unknown> {
  if (grid) {
    if (Date.now() - grid.fetchedAt > GRID_MAX_AGE_MS) void refreshWeatherGrid()
    return Promise.resolve(null)
  }
  return refreshWeatherGrid()
}

// ---------- the weather clock ----------

// The forecast is HOURLY and everything drawn "at now" reads the hour
// containing the moment — so at each top of the hour the hour steps and
// anything holding a rendered field is a full hour stale at once.
const hourListeners = new Set<() => void>()

/** Run `cb` at every top-of-hour while the app is visible (and after a nap:
 *  the first tick past a missed boundary fires it too). Returns unsubscribe. */
export function onWeatherHour(cb: () => void): () => void {
  hourListeners.add(cb)
  return () => hourListeners.delete(cb)
}

/**
 * One clock for the weather's whole cadence, matched to the data instead of
 * to user interaction:
 *
 *  - each top of the hour: the hourly arrays step, so the overlay re-renders
 *    and every hour listener (flow-layer fields, the strip's Now) re-reads;
 *  - past GRID_MAX_AGE_MS: the grid quietly refetches, catching the upstream
 *    model's ~6-hourly runs within half an hour of them landing.
 *
 * A 60 s tick, gated on visibility — a phone asleep spends nothing, and its
 * first tick after waking covers everything missed. Event-driven refreshes
 * (pan, toggle, planTime) still run; this is the floor under them, for the
 * chartplotter that sits mounted and untouched.
 */
function startWeatherClock() {
  let lastHour = Math.floor(Date.now() / 3600_000)
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    const hr = Math.floor(Date.now() / 3600_000)
    if (hr !== lastHour) {
      lastHour = hr
      withMap(render)
      for (const cb of hourListeners) cb()
    }
    if (useAppStore.getState().online && grid && Date.now() - grid.fetchedAt > GRID_MAX_AGE_MS) {
      void refreshWeatherGrid() // success notifies gridListeners → layers resync
    }
    // the RDWPS overlay regenerates 4×/day — check it hourly on its own
    if (useAppStore.getState().online && grid && waveOverlayAgeMs() > 60 * 60_000) {
      void refreshWaveOverlay().then(() => {
        if (grid && applyWaveOverlay(grid)) {
          withMap(render)
          for (const cb of gridListeners) cb()
        }
      })
    }
    // same cadence for the HRDPS wind — a new run is a cheap catalogue
    // check; only an actual new run costs the ~100 small fetches (and the
    // onWindOverlay hook dresses the grid when they land)
    if (useAppStore.getState().online && grid && windOverlayAgeMs() > 60 * 60_000) {
      void refreshWindOverlay()
    }
  }, 60_000)
}

let inited = false

/** Wire the layer into the map + store. Call once at startup. */
export function initWeatherLayer() {
  if (inited) return // React StrictMode double effect-run in dev
  inited = true
  startWeatherClock()
  // the HRDPS wind lands on its own schedule (~100 small GeoMet fetches,
  // usually started by the strip's point fetch before the grid exists):
  // whenever a run arrives, dress whatever grid is in hand and tell every
  // reader — badges, flow layers, the trip sweep, the forecast watch
  onWindOverlay(() => {
    if (grid && applyWindOverlay(grid)) {
      withMap(render)
      for (const cb of gridListeners) cb()
    }
  })
  if (import.meta.env.DEV) {
    // the verify harness reads the grid through the same doors the app does
    ;(window as unknown as Record<string, unknown>).__wx = {
      gridConditionsAt,
      weatherGridInfo,
      windOverlayStatus,
      depthAt,
    }
  }

  onEachMap((map) => {
    addLayers(map)
    render(map)
  })

  // Last-known weather first: seed from the IndexedDB copy so the strip, the
  // layers and the flow engines open with data the moment the map exists,
  // while the real fetch runs behind (and overwrites this when it lands).
  void cachedGridForecast().then((c) => {
    if (!c || grid) return // the network already won
    grid = c.grid
    gridStale = true
    applyWaveOverlay(grid)
    applyWindOverlay(grid)
    withMap((map) => {
      addLayers(map)
      render(map)
    })
    for (const cb of gridListeners) cb()
  })

  // layer persisted on from a previous session → fetch without waiting for a
  // toggle (the numeric wave readout needs the grid just like the overlay)
  if (useAppStore.getState().layers.weather || showWaveNumbers()) void refreshWeatherGrid()

  useAppStore.subscribe((s, prev) => {
    if (s.windUnit !== prev.windUnit) withMap(render) // arrow labels carry the unit
    // the ramp moved under the water — repaint the blobs and the numbers
    if (s.seaScaleM !== prev.seaScaleM) {
      withMap((map) => {
        if (layersOn !== map || !map.getLayer('wx-wave')) return
        map.setPaintProperty('wx-wave', 'circle-color', waveBlobColor(s.seaScaleM))
        map.setPaintProperty('wx-wave-num', 'text-color', waveNumColor(s.seaScaleM))
      })
    }
    if (
      s.layers.weather !== prev.layers.weather ||
      s.layers.seaFlow !== prev.layers.seaFlow ||
      s.lowPower !== prev.lowPower ||
      s.planTimeMs !== prev.planTimeMs
    ) {
      withMap(render)
      // fetch on first enable, refresh a stale grid on interaction
      if (
        (s.layers.weather || showWaveNumbers()) &&
        (!grid || Date.now() - grid.fetchedAt > GRID_MAX_AGE_MS)
      ) {
        void refreshWeatherGrid()
      }
    }
  })
}

/** Nearest grid cell — for the fields bilinear sampling shouldn't blend
 *  (weather codes, wave direction). */
function nearestCell(lon: number, lat: number): GridCell | null {
  if (!grid) return null
  const kx = Math.cos((lat * Math.PI) / 180)
  let best: GridCell | null = null
  let bestD = Infinity
  for (const c of grid.cells) {
    const d = ((c.lon - lon) * kx) ** 2 + (c.lat - lat) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/**
 * A route forecast built from the cached regional grid — the stand-in when
 * the per-point route fetch fails (offline, rate-limited). Same shape
 * planTrip eats, and the grid agrees with the point API to ~0.02 m on this
 * water, so a run through here loses nothing a skipper would notice. Without
 * it, a tapped point whose forecast couldn't be fetched got a route with no
 * segments at all — no lanes, no leg dots, no plan.
 */
export function routeForecastFromGrid(pts: [number, number][]): RouteForecast | null {
  const g = grid
  if (!g || g.time.length === 0) return null
  const f = fieldOf(g)
  const n = g.time.length
  const points: RoutePointWx[] = pts.map(([lon, lat]) => {
    const near = nearestCell(lon, lat)
    const windKn: number[] = new Array(n)
    const gustKn: number[] = new Array(n)
    const windDir: number[] = new Array(n)
    const weatherCode: number[] = new Array(n)
    const waveM: (number | null)[] = new Array(n)
    const wavePeriodS: (number | null)[] = new Array(n)
    const waveDir: (number | null)[] = new Array(n)
    for (let i = 0; i < n; i++) {
      if (f) {
        const smp = sampleField(g, f, i, lon, lat)
        windKn[i] = Number.isFinite(smp.wind) ? smp.wind : (near?.windKn[i] ?? 0)
        gustKn[i] = Number.isFinite(smp.gust) ? smp.gust : (near?.gustKn[i] ?? windKn[i])
        windDir[i] = Number.isFinite(smp.dir) ? smp.dir : (near?.windDir[i] ?? 0)
        waveM[i] = smp.wave
        wavePeriodS[i] = smp.period
      } else {
        windKn[i] = near?.windKn[i] ?? 0
        gustKn[i] = near?.gustKn[i] ?? windKn[i]
        windDir[i] = near?.windDir[i] ?? 0
        waveM[i] = near?.waveM[i] ?? null
        wavePeriodS[i] = near?.wavePeriodS?.[i] ?? null
      }
      weatherCode[i] = near?.weatherCode?.[i] ?? 0
      waveDir[i] = near?.waveDir?.[i] ?? null
    }
    return { lon, lat, time: g.time, windKn, gustKn, windDir, weatherCode, waveM, wavePeriodS, waveDir }
  })
  return { fetchedAt: g.fetchedAt, points }
}

/**
 * A point forecast synthesised from the cached grid, for the readers nobody
 * polls — a leg row, a spot with no cached point forecast. The grid carries
 * no air temperature, so tempC is NaN and the hourly table leaves it blank.
 */
export function pointForecastFromGrid(lon: number, lat: number): PointForecast | null {
  const g = grid
  if (!g || g.time.length === 0) return null
  const r = routeForecastFromGrid([[lon, lat]])
  if (!r) return null
  const p = r.points[0]
  const near = nearestCell(lon, lat)
  return {
    lon,
    lat,
    fetchedAt: g.fetchedAt,
    hourly: {
      time: p.time,
      windKn: p.windKn,
      gustKn: p.gustKn,
      windDir: p.windDir,
      tempC: new Array<number>(g.time.length).fill(NaN),
      weatherCode: p.weatherCode,
      precipProbPct: near?.precipProbPct,
      waveM: p.waveM,
      wavePeriodS: p.wavePeriodS,
      waveDir: p.waveDir ?? [],
    },
  }
}

/**
 * The forecast at a point WITHOUT touching the network. Fetching is the
 * pollers' job — the strip for its focus point, the weather clock for the
 * grid — and everything else reads what they left: the cached point
 * forecast when there is one, else the cached grid. Null only before the
 * first grid has ever landed.
 */
export async function pointForecastCached(
  lon: number,
  lat: number,
): Promise<{ forecast: PointForecast; stale: boolean } | null> {
  const c = await cachedPointForecast(lon, lat)
  if (c) {
    // the disk copy may predate an overlay that has since landed
    await dressPointForecast(c.forecast)
    return { forecast: c.forecast, stale: c.ageMs > GRID_MAX_AGE_MS }
  }
  const fromGrid = pointForecastFromGrid(lon, lat)
  return fromGrid ? { forecast: fromGrid, stale: gridStale } : null
}

export interface DayBand {
  dayStartMs: number
  /** Biggest sea across the day's boating hours, or null off the grid. */
  waveMaxM: number | null
  thunder: boolean
}

/**
 * The week at a point, one band per day, straight off the cached grid — the
 * Places sheet paints these as its ramp gradient. Same boating-hours window
 * the strip's day chips rate (OUTLOOK_FROM_H–OUTLOOK_TO_H), so a place's band
 * and its day chip never disagree about the same day.
 */
export function weekAt(lon: number, lat: number): DayBand[] {
  const g = grid
  const out: DayBand[] = []
  const t0 = new Date()
  const near = g ? nearestCell(lon, lat) : null
  for (let d = 0; d < 7; d++) {
    const dayStartMs = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + d).getTime()
    let waveMaxM: number | null = null
    let thunder = false
    if (g && g.time.length > 0) {
      for (let h = OUTLOOK_FROM_H; h <= OUTLOOK_TO_H; h += 2) {
        const ms = dayStartMs + h * 3600_000
        if (ms < Date.now() - 3600_000) continue // that water has passed
        const i = hourIndexAt(g.time, ms)
        const f = fieldOf(g)
        const wave = f ? sampleField(g, f, i, lon, lat).wave : (near?.waveM[i] ?? null)
        if (wave != null) waveMaxM = waveMaxM == null ? wave : Math.max(waveMaxM, wave)
        if ((near?.weatherCode?.[i] ?? 0) >= 95) thunder = true
      }
    }
    out.push({ dayStartMs, waveMaxM, thunder })
  }
  return out
}

export interface DayRange {
  windLoKn: number | null
  windHiKn: number | null
  waveLoM: number | null
  waveHiM: number | null
}

/**
 * The day's spread at a point — the low and high of wind and sea across the
 * boating hours, off the cached grid. The Places rows quote these as the
 * "important numbers" over their colour band; hours already sailed today
 * don't count, the same rule the week bands use.
 */
export function dayRangeAt(lon: number, lat: number, dayStartMs: number): DayRange {
  const g = grid
  const out: DayRange = { windLoKn: null, windHiKn: null, waveLoM: null, waveHiM: null }
  if (!g || g.time.length === 0) return out
  const f = fieldOf(g)
  const near = nearestCell(lon, lat)
  for (let h = OUTLOOK_FROM_H; h <= OUTLOOK_TO_H; h += 2) {
    const ms = dayStartMs + h * 3600_000
    if (ms < Date.now() - 3600_000) continue
    const i = hourIndexAt(g.time, ms)
    let wind: number | null = null
    let wave: number | null = null
    if (f) {
      const smp = sampleField(g, f, i, lon, lat)
      wind = Number.isFinite(smp.wind) ? smp.wind : null
      wave = smp.wave
    } else {
      wind = near?.windKn[i] ?? null
      wave = near?.waveM[i] ?? null
    }
    if (wind != null) {
      out.windLoKn = out.windLoKn == null ? wind : Math.min(out.windLoKn, wind)
      out.windHiKn = out.windHiKn == null ? wind : Math.max(out.windHiKn, wind)
    }
    if (wave != null) {
      out.waveLoM = out.waveLoM == null ? wave : Math.min(out.waveLoM, wave)
      out.waveHiM = out.waveHiM == null ? wave : Math.max(out.waveHiM, wave)
    }
  }
  return out
}
