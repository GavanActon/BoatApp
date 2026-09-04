import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { depthAt } from '../map/depthGrid'
import { withMap } from '../map/mapController'
import { db, type Mark } from './db'
import { activeTrack } from './gpsService'
import { useGpsStore } from './gpsStore'

/**
 * Marks: one tap under way drops a pin at the boat with the time and the
 * chart's depth there — "fish here", "rock", "nice drift". A mark belongs
 * to the track being recorded, so it shows up in the log entry; on the
 * chart it is an amber ring, drawn while the track records and whenever a
 * log entry is open.
 */

const SOURCE = 'marks'
const AMBER = '#ffb454'

function ensureLayer(map: MlMap) {
  if (map.getSource(SOURCE)) return
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'mark-ring',
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-radius': 6,
      'circle-color': 'rgba(255, 180, 84, 0.18)',
      'circle-stroke-color': AMBER,
      'circle-stroke-width': 2,
    },
  })
}

/** Draw these marks (and only these). */
export function showMarksOnMap(marks: Mark[]): void {
  withMap((map) => {
    ensureLayer(map)
    const src = map.getSource(SOURCE) as GeoJSONSource
    src.setData({
      type: 'FeatureCollection',
      features: marks.map((m) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        properties: { id: m.id, ts: m.ts },
      })),
    })
  })
}

export function clearMarksOnMap(): void {
  withMap((map) => {
    const src = map.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: [] })
  })
}

export async function marksFor(trackId: number): Promise<Mark[]> {
  return db.marks.where('trackId').equals(trackId).sortBy('ts')
}

/** Drop a mark at the boat. Null when there is no fix or no track. */
export async function addMark(): Promise<Mark | null> {
  const fix = useGpsStore.getState().fix
  const trackId = activeTrack()
  if (!fix || trackId == null) return null
  const mark: Mark = {
    trackId,
    ts: Date.now(),
    lon: fix.lon,
    lat: fix.lat,
    depthM: depthAt(fix.lon, fix.lat),
    note: '',
  }
  mark.id = (await db.marks.add(mark)) as number
  showMarksOnMap(await marksFor(trackId))
  return mark
}

export async function setMarkNote(id: number, note: string): Promise<void> {
  await db.marks.update(id, { note: note.trim().slice(0, 80) })
}

export async function deleteMark(id: number): Promise<void> {
  await db.marks.delete(id)
}

// the live marks leave the chart with the recording; the log draws its own
let wired = false
export function initMarks(): void {
  if (wired) return
  wired = true
  useGpsStore.subscribe((s, prev) => {
    if (prev.recording && !s.recording) clearMarksOnMap()
  })
}
