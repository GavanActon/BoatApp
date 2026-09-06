import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { create } from 'zustand'
import { depthAt, depthGridLoaded } from '../map/depthGrid'
import { getMap, withMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import type { Fix } from './gpsStore'

/**
 * The cone ahead. Every fix, the depth grid is read along a fan of rays
 * from the boat over the course it is making good — two minutes of water
 * at the speed it is doing, never less than 300 m — and the shallowest
 * cell is reported: its depth, how far, and which side of the bow. When
 * that depth is under the skipper's own shallow-water figure (Settings ›
 * Boat; null until they set it, per §1.4) the reading wears amber, on the
 * instrument bar and as marks on the chart inside the cone. Numbers and
 * colour, no verdict: the app says what the chart shows ahead, and the
 * skipper decides.
 *
 * The chart's grid is ~65–90 m cells read bilinearly, so this is a
 * sounding of the SURVEY ahead, not a sonar — a rock the survey missed
 * is still a rock.
 */

export interface AheadShallow {
  depthM: number
  distM: number
  /** Where it lies off the bow. */
  side: 'port' | 'ahead' | 'starboard'
  lon: number
  lat: number
}

export interface LookAhead {
  rangeM: number
  courseDeg: number
  /** Shallowest sounding in the cone, and where. Null when nothing charted. */
  minM: number | null
  minLon: number
  minLat: number
  /** The nearest sample under the skipper's limit, if any. */
  shallow: AheadShallow | null
  /** Every sample under the limit, for the chart. */
  marks: { lon: number; lat: number; depthM: number }[]
  wedge: [number, number][]
}

interface LookAheadState {
  ahead: LookAhead | null
  setAhead: (a: LookAhead | null) => void
}

export const useLookAhead = create<LookAheadState>()((set) => ({ ahead: null, setAhead: (ahead) => set({ ahead }) }))

const HALF_ANGLE_DEG = 20
const RAY_STEP_DEG = 5
const STEP_M = 30
const MIN_RANGE_M = 300
const MAX_RANGE_M = 1500
const LOOK_S = 120
const MIN_SPEED_KN = 0.5
/** A course derived from two fixes needs this much water between them. */
const COURSE_MIN_M = 12
const DRAW_EVERY_MS = 700

/** The last few fixes, oldest first — a course needs a run, not a pair. */
let recent: Fix[] = []
const RECENT_MAX = 20
const RECENT_MAX_AGE_MS = 20_000
let lastDrawAt = 0

function metresPerDegree(lat: number): { x: number; y: number } {
  return { x: 111_320 * Math.cos((lat * Math.PI) / 180), y: 111_320 }
}

function bearingDeg(a: Fix, b: Fix): { deg: number; distM: number } {
  const m = metresPerDegree((a.lat + b.lat) / 2)
  const dx = (b.lon - a.lon) * m.x
  const dy = (b.lat - a.lat) * m.y
  return { deg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, distM: Math.hypot(dx, dy) }
}

/** The most recent earlier fix far enough back to give a course: a run of
 *  at least COURSE_MIN_M, within the last few seconds. */
function runFrom(fix: Fix): Fix | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    const f = recent[i]
    if (f.ts >= fix.ts || fix.ts - f.ts > RECENT_MAX_AGE_MS) continue
    if (bearingDeg(f, fix).distM >= COURSE_MIN_M) return f
  }
  return null
}

/** The course to look along: the fix's own, else the run of recent fixes
 *  when the phone gave none (slow, or a phone with no heading). */
function courseOf(fix: Fix): number | null {
  if (fix.cog != null) return fix.cog
  const from = runFrom(fix)
  return from ? bearingDeg(from, fix).deg : null
}

function speedKnOf(fix: Fix): number | null {
  if (fix.sogKn != null) return fix.sogKn
  const from = runFrom(fix)
  if (!from) return null
  return (bearingDeg(from, fix).distM / ((fix.ts - from.ts) / 1000)) * 1.94384
}

export function computeLookAhead(fix: Fix, courseDeg: number, speedKn: number, limitM: number | null): LookAhead {
  const rangeM = Math.max(MIN_RANGE_M, Math.min(MAX_RANGE_M, speedKn * 0.514444 * LOOK_S))
  const m = metresPerDegree(fix.lat)
  const at = (deg: number, distM: number): [number, number] => {
    const r = (deg * Math.PI) / 180
    return [fix.lon + (Math.sin(r) * distM) / m.x, fix.lat + (Math.cos(r) * distM) / m.y]
  }
  let minM: number | null = null
  let minLon = fix.lon
  let minLat = fix.lat
  let shallow: AheadShallow | null = null
  const marks: LookAhead['marks'] = []
  for (let off = -HALF_ANGLE_DEG; off <= HALF_ANGLE_DEG; off += RAY_STEP_DEG) {
    const deg = (courseDeg + off + 360) % 360
    for (let d = STEP_M; d <= rangeM; d += STEP_M) {
      const [lon, lat] = at(deg, d)
      const z = depthAt(lon, lat)
      if (z == null) continue
      if (minM == null || z < minM) {
        minM = z
        minLon = lon
        minLat = lat
      }
      if (limitM != null && z < limitM) {
        marks.push({ lon, lat, depthM: z })
        if (!shallow || d < shallow.distM) {
          shallow = { depthM: z, distM: d, side: off < -7 ? 'port' : off > 7 ? 'starboard' : 'ahead', lon, lat }
        }
      }
    }
  }
  // the wedge: the boat, the far arc, back to the boat
  const wedge: [number, number][] = [[fix.lon, fix.lat]]
  for (let off = -HALF_ANGLE_DEG; off <= HALF_ANGLE_DEG; off += 2.5) wedge.push(at((courseDeg + off + 360) % 360, rangeM))
  wedge.push([fix.lon, fix.lat])
  return { rangeM, courseDeg, minM, minLon, minLat, shallow, marks, wedge }
}

/** Called with every good fix. */
export function updateLookAhead(fix: Fix): void {
  const course = courseOf(fix)
  const speed = speedKnOf(fix)
  recent.push(fix)
  if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX)
  if (!depthGridLoaded() || course == null || speed == null || speed < MIN_SPEED_KN) {
    if (useLookAhead.getState().ahead) {
      useLookAhead.getState().setAhead(null)
      draw(null)
    }
    return
  }
  const ahead = computeLookAhead(fix, course, speed, useAppStore.getState().shallowM)
  useLookAhead.getState().setAhead(ahead)
  const now = Date.now()
  if (now - lastDrawAt >= DRAW_EVERY_MS) {
    lastDrawAt = now
    draw(ahead)
  }
}

export function clearLookAhead(): void {
  recent = []
  useLookAhead.getState().setAhead(null)
  draw(null)
}

// ---------- the chart ----------

const SOURCE = 'lookahead'
const MARKS = 'lookahead-marks'
const BLUE = '#3fc8ff'
const AMBER = '#ffb454'

function ensureLayers(map: MlMap) {
  if (map.getSource(SOURCE)) return
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addSource(MARKS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const before = map.getLayer('track-live-line') ? 'track-live-line' : undefined
  map.addLayer(
    { id: 'lookahead-fill', type: 'fill', source: SOURCE, paint: { 'fill-color': BLUE, 'fill-opacity': 0.07 } },
    before,
  )
  map.addLayer(
    {
      id: 'lookahead-edge',
      type: 'line',
      source: SOURCE,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': BLUE, 'line-width': 1, 'line-opacity': 0.35 },
    },
    before,
  )
  map.addLayer({
    id: 'lookahead-shallow',
    type: 'circle',
    source: MARKS,
    paint: {
      'circle-radius': 3.5,
      'circle-color': AMBER,
      'circle-opacity': 0.75,
      'circle-stroke-color': 'rgba(8, 20, 34, 0.6)',
      'circle-stroke-width': 1,
    },
  })
}

function draw(ahead: LookAhead | null) {
  const paint = (map: MlMap) => {
    ensureLayers(map)
    const wedge = map.getSource(SOURCE) as GeoJSONSource
    const marks = map.getSource(MARKS) as GeoJSONSource
    if (!ahead) {
      wedge.setData({ type: 'FeatureCollection', features: [] })
      marks.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    wedge.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ahead.wedge] }, properties: {} })
    marks.setData({
      type: 'FeatureCollection',
      features: ahead.marks.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { depthM: p.depthM },
      })),
    })
  }
  const live = getMap()
  if (live && live.getStyle()) paint(live)
  else withMap(paint)
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__ahead = { store: useLookAhead, compute: computeLookAhead }
}
