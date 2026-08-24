import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { REGION_BBOX } from '../config'
import { onEachMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { speedUnitLabel, windSpeed, type SpeedUnit } from '../units'
import { floorHourMs } from '../time'
import {
  fetchGridForecast,
  GRID_SHAPE,
  hourIndexAt,
  type GridCell,
  type GridForecast,
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
// About half a dozen arrows on a phone screen. Deliberately sparse: zoomed
// in on a trip, every arrow is sampled from the same cell or two, so a dense
// field just prints one number a dozen times and implies detail the forecast
// hasn't got. Spacing rather than a fixed count, so a bigger screen shows
// more of the field instead of the same six arrows stretched across it.
const ARROW_SPACING_PX = 170
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

function addLayers(map: MlMap) {
  if (layersOn === map || !map.getStyle()) return

  for (const b of ARROW_BUCKETS) {
    if (!map.hasImage(b.id)) map.addImage(b.id, makeArrowImage(b.color), { pixelRatio: 2 })
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
      'circle-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'wave'], 0],
        0,
        'rgba(30, 90, 140, 0.0)',
        0.3,
        'rgba(63, 160, 220, 0.45)',
        0.8,
        'rgba(120, 220, 170, 0.5)',
        1.5,
        'rgba(255, 209, 102, 0.55)',
        2.5,
        'rgba(255, 107, 107, 0.6)',
      ],
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
  }
  return {
    wind,
    gust,
    dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
    // a partly-covered corner set still gives a height, just from what it had
    wave: waveW > 0 ? wave / waveW : null,
  }
}

/**
 * The lattice spacing: the grid's own step, halved until the arrows sit no
 * further apart than ARROW_SPACING_PX asks for, and never coarser than the
 * grid itself. Halving rather than fitting the viewport exactly is what keeps
 * the lattice on fixed ground — a step derived from the live bounds re-spaces
 * on every pan, and the whole field crawls across the map with you.
 */
function latticeStep(native: number, want: number): number {
  const steps = Math.max(0, Math.round(Math.log2(Math.abs(native) / want)))
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
  const wantX = Math.max(2, Math.round(cv.clientWidth / ARROW_SPACING_PX))
  const wantY = Math.max(2, Math.round(cv.clientHeight / ARROW_SPACING_PX))
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
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function render(map: MlMap) {
  if (layersOn !== map) return
  const { layers, planTimeMs, windUnit } = useAppStore.getState()
  const src = map.getSource('wx') as GeoJSONSource | undefined
  if (!src) return
  src.setData(
    grid && layers.weather
      ? fcForView(map, grid, planTimeMs ?? floorHourMs(), windUnit)
      : emptyFc(),
  )
  const vis = layers.weather ? 'visible' : 'none'
  map.setLayoutProperty('wx-wave', 'visibility', vis)
  map.setLayoutProperty('wx-wind', 'visibility', vis)
}

let refreshing: Promise<{ fetchedAt: number; stale: boolean } | null> | null = null

export function refreshWeatherGrid(): Promise<{ fetchedAt: number; stale: boolean } | null> {
  // share one in-flight fetch across callers (strip taps, panel open)
  refreshing ??= (async () => {
    try {
      const { grid: g, stale } = await fetchGridForecast()
      grid = g
      gridStale = stale
      withMap((map) => {
        addLayers(map)
        render(map)
      })
      return { fetchedAt: g.fetchedAt, stale }
    } catch {
      return null
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function weatherGridInfo(): { fetchedAt: number; stale: boolean } | null {
  return grid ? { fetchedAt: grid.fetchedAt, stale: gridStale } : null
}

export interface GridConditions {
  windKn: number
  gustKn: number
  windDir: number
  waveM: number | null
  wavePeriodS: number | null
}

/** Wind + waves at the grid cell nearest a point, at the hour containing `ms`.
 *  Null until the grid has loaded — ensureWeatherGrid() populates it. */
export function gridConditionsAt(lon: number, lat: number, ms: number): GridConditions | null {
  if (!grid || grid.time.length === 0) return null
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
  const i = hourIndexAt(grid.time, ms)
  const windKn = best.windKn[i]
  if (windKn == null) return null
  return {
    windKn,
    gustKn: best.gustKn[i] ?? windKn,
    windDir: best.windDir[i] ?? 0,
    waveM: best.waveM[i] ?? null,
    // optional-chained: a grid cached before periods were fetched has no array
    wavePeriodS: best.wavePeriodS?.[i] ?? null,
  }
}

/** Resolves immediately when the grid is already fresh, otherwise (re)fetches it. */
export function ensureWeatherGrid(): Promise<unknown> {
  if (grid && Date.now() - grid.fetchedAt <= GRID_MAX_AGE_MS) return Promise.resolve(null)
  return refreshWeatherGrid()
}

let inited = false

/** Wire the layer into the map + store. Call once at startup. */
export function initWeatherLayer() {
  if (inited) return // React StrictMode double effect-run in dev
  inited = true

  onEachMap((map) => {
    addLayers(map)
    render(map)
  })

  // layer persisted on from a previous session → fetch without waiting for a toggle
  if (useAppStore.getState().layers.weather) void refreshWeatherGrid()

  useAppStore.subscribe((s, prev) => {
    if (s.windUnit !== prev.windUnit) withMap(render) // arrow labels carry the unit
    if (s.layers.weather !== prev.layers.weather || s.planTimeMs !== prev.planTimeMs) {
      withMap(render)
      // fetch on first enable, refresh a stale grid on interaction
      if (s.layers.weather && (!grid || Date.now() - grid.fetchedAt > GRID_MAX_AGE_MS)) {
        void refreshWeatherGrid()
      }
    }
  })
}
