import type { GeoJSONSource, LngLatBounds, Map as MlMap } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import { withMap } from '../map/mapController'
import { db, type Line, type Track } from './db'

/**
 * Lines: a track the skipper keeps — saved from a log entry under a name,
 * listed in Places beside the spots, drawn on the chart when tapped and
 * kept there until tapped again. The points are copied, so the log entry
 * can go and the line stays.
 */

const SOURCE = 'saved-lines'
const MAX_POINTS = 300
const GREEN = '#59e0b8'
const listeners = new Set<() => void>()
const shown = new Set<number>()

export function onLines(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit() {
  for (const l of listeners) l()
}

export async function listLines(): Promise<Line[]> {
  return db.lines.orderBy('createdAt').reverse().toArray()
}

/** Keep this track as a line: its points thinned to a few hundred. */
export async function saveLine(track: Track, name: string): Promise<Line> {
  const pts = await db.points.where('trackId').equals(track.id!).sortBy('ts')
  const step = Math.max(1, Math.ceil(pts.length / MAX_POINTS))
  const coords = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [p.lon, p.lat] as [number, number])
  const line: Line = {
    name: name.trim().slice(0, 40) || 'Line',
    coords,
    distanceNm: track.distanceNm,
    createdAt: Date.now(),
    fromTrackId: track.id ?? null,
  }
  line.id = (await db.lines.add(line)) as number
  emit()
  return line
}

export async function deleteLine(id: number): Promise<void> {
  await db.lines.delete(id)
  shown.delete(id)
  await redraw()
  emit()
}

function ensureLayer(map: MlMap) {
  if (map.getSource(SOURCE)) return
  map.addSource(SOURCE, { type: 'geojson', maxzoom: 13, data: { type: 'FeatureCollection', features: [] } })
  const before = map.getLayer('route-line-casing') ? 'route-line-casing' : undefined
  map.addLayer(
    {
      id: 'saved-line',
      type: 'line',
      source: SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': GREEN, 'line-width': 2.5, 'line-opacity': 0.85 },
    },
    before,
  )
}

async function redraw(): Promise<void> {
  const lines = (await listLines()).filter((l) => l.id != null && shown.has(l.id))
  withMap((map) => {
    ensureLayer(map)
    const src = map.getSource(SOURCE) as GeoJSONSource
    src.setData({
      type: 'FeatureCollection',
      features: lines.map((l) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: l.coords },
        properties: { id: l.id, name: l.name },
      })),
    })
  })
}

export function isLineShown(id: number): boolean {
  return shown.has(id)
}

/** Tap: draw it and frame it; tap again: take it off the chart. */
export async function toggleLine(line: Line): Promise<boolean> {
  const id = line.id!
  if (shown.has(id)) {
    shown.delete(id)
    await redraw()
    emit()
    return false
  }
  shown.add(id)
  await redraw()
  withMap((map) => {
    const bounds = line.coords.reduce(
      (b: LngLatBounds, c) => b.extend(c),
      new maplibregl.LngLatBounds(line.coords[0], line.coords[0]),
    )
    map.fitBounds(bounds, { padding: 80, duration: 600 })
  })
  emit()
  return true
}
