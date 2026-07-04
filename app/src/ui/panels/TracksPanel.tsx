import { useEffect, useState } from 'react'
import type { GeoJSONSource, LngLatBounds } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import { withMap } from '../../map/mapController'
import { useAppStore } from '../../state/appStore'
import { db, type Track } from '../../tracking/db'
import { exportTrackGpx } from '../../tracking/gpx'
import { useGpsStore } from '../../tracking/gpsStore'
import { IconShare, IconTrash } from '../icons'

const VIEW_SOURCE = 'track-view'

function ensureViewLayer(map: maplibregl.Map) {
  if (!map.getSource(VIEW_SOURCE)) {
    map.addSource(VIEW_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: 'track-view-line',
      type: 'line',
      source: VIEW_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#59e0b8',
        'line-width': 3,
        'line-opacity': 0.9,
      },
    })
  }
}

async function showTrackOnMap(track: Track) {
  const pts = await db.points.where('trackId').equals(track.id!).sortBy('ts')
  if (!pts.length) return
  const coords = pts.map((p) => [p.lon, p.lat] as [number, number])
  withMap((map) => {
    ensureViewLayer(map)
    const src = map.getSource(VIEW_SOURCE) as GeoJSONSource
    src.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    })
    const bounds = coords.reduce(
      (b: LngLatBounds, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    )
    map.fitBounds(bounds, { padding: 80, duration: 600 })
  })
}

function clearTrackOnMap() {
  withMap((map) => {
    const src = map.getSource(VIEW_SOURCE) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: [] })
  })
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

export default function TracksPanel() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [shownId, setShownId] = useState<number | null>(null)
  const recording = useGpsStore((s) => s.recording)
  const setSheetTab = useAppStore((s) => s.setSheetTab)

  useEffect(() => {
    void db.tracks.orderBy('startedAt').reverse().toArray().then(setTracks)
  }, [recording])

  async function remove(t: Track) {
    if (!confirm(`Delete "${t.name}"?`)) return
    await db.points.where('trackId').equals(t.id!).delete()
    await db.tracks.delete(t.id!)
    if (shownId === t.id) {
      clearTrackOnMap()
      setShownId(null)
    }
    setTracks(await db.tracks.orderBy('startedAt').reverse().toArray())
  }

  async function toggleShow(t: Track) {
    if (shownId === t.id) {
      clearTrackOnMap()
      setShownId(null)
    } else {
      await showTrackOnMap(t)
      setShownId(t.id!)
      setSheetTab(null) // reveal the map
    }
  }

  if (!tracks.length) {
    return (
      <div className="panel">
        <div className="empty">
          <p>No tracks yet.</p>
          <p className="row-desc">
            Tap <strong>REC</strong> in the instrument bar to start recording your route.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      {tracks.map((t) => (
        <div key={t.id} className={`row track-row ${shownId === t.id ? 'track-shown' : ''}`}>
          <button className="row-text" onClick={() => void toggleShow(t)}>
            <span className="row-title">{t.name}</span>
            <span className="row-desc">
              {t.distanceNm.toFixed(1)} nm
              {t.endedAt ? ` · ${fmtDuration(t.endedAt - t.startedAt)}` : ' · recording…'}
              {t.maxSogKn > 0 ? ` · max ${t.maxSogKn.toFixed(1)} kn` : ''}
            </span>
          </button>
          <button className="icon-btn" onClick={() => void exportTrackGpx(t)} aria-label="Export GPX">
            <IconShare size={19} />
          </button>
          <button className="icon-btn danger" onClick={() => void remove(t)} aria-label="Delete">
            <IconTrash size={19} />
          </button>
        </div>
      ))}
    </div>
  )
}
