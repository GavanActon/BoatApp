import maplibregl from 'maplibre-gl'
import { withMap, getMap } from '../map/mapController'
import { useAppStore } from '../state/appStore'
import { db } from './db'
import { distanceNm, useGpsStore, type Fix } from './gpsStore'

/**
 * GPS service: owns the geolocation watch, the vessel marker, follow-mode
 * camera, screen wake lock, and track recording. Framework-free singleton;
 * React reads state via useGpsStore.
 */

const MS_TO_KN = 1.9438445
let watchId: number | null = null
let marker: maplibregl.Marker | null = null
let markerAdded = false
let wakeLock: WakeLockSentinel | null = null
let cameraHoldUntil = 0 // fixes don't steer the camera while a locate zoom-in runs

// recording state
let activeTrackId: number | null = null
let lastRecorded: Fix | null = null
let maxSog = 0
let liveCoords: [number, number][] = []

function vesselElement(): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'vessel'
  el.innerHTML = `
    <svg viewBox="0 0 40 40" width="40" height="40">
      <defs>
        <filter id="vglow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#3fc8ff" flood-opacity="0.65"/>
        </filter>
      </defs>
      <path d="M20 4 L30 32 L20 26 L10 32 Z" fill="#3fc8ff" stroke="#0a1522" stroke-width="1.5" filter="url(#vglow)"/>
    </svg>`
  return el
}

function ensureMarker(): maplibregl.Marker {
  if (!marker) {
    marker = new maplibregl.Marker({ element: vesselElement(), rotationAlignment: 'map' })
    markerAdded = false
  }
  return marker
}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen')
  } catch {
    /* not critical */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId != null) void acquireWakeLock()
})

function onFix(pos: GeolocationPosition) {
  const c = pos.coords
  const fix: Fix = {
    lon: c.longitude,
    lat: c.latitude,
    accuracy: c.accuracy,
    sogKn: c.speed != null && !Number.isNaN(c.speed) ? c.speed * MS_TO_KN : null,
    cog: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null,
    ts: pos.timestamp,
  }
  const gps = useGpsStore.getState()
  gps.setFix(fix)
  if (gps.status !== 'on') gps.setStatus('on')

  // the first fix can arrive before the map instance exists now that GPS
  // starts at app launch — queue it; later fixes take the direct path
  // without waiting for the style to finish loading
  const liveMap = getMap()
  const update = (map: maplibregl.Map) => {
    const m = ensureMarker()
    m.setLngLat([fix.lon, fix.lat])
    if (fix.cog != null) m.setRotation(fix.cog)
    if (!markerAdded) {
      m.addTo(map)
      markerAdded = true
    }

    const { follow, headingUp } = useAppStore.getState()
    if (follow && Date.now() >= cameraHoldUntil) {
      map.easeTo({
        center: [fix.lon, fix.lat],
        bearing: headingUp && fix.cog != null ? fix.cog : map.getBearing(),
        duration: 900,
        essential: true,
      })
    }
  }
  if (liveMap) update(liveMap)
  else withMap(update)

  void recordPoint(fix)
}

function onError(err: GeolocationPositionError) {
  const gps = useGpsStore.getState()
  gps.setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error')
}

export function startGps() {
  if (watchId != null || !('geolocation' in navigator)) return
  useGpsStore.getState().setStatus('acquiring')
  watchId = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 30000,
  })
  void acquireWakeLock()
}

export function stopGps() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId)
    watchId = null
  }
  marker?.remove()
  marker = null
  markerAdded = false
  wakeLock?.release().catch(() => {})
  wakeLock = null
  useGpsStore.getState().setStatus('off')
  useGpsStore.getState().setFix(null)
}

/** Center the map on the current fix (requesting GPS if needed) and enable follow. */
export function locateAndFollow() {
  startGps()
  useAppStore.getState().setFollow(true)
  const fix = useGpsStore.getState().fix
  if (fix) {
    const ease = (map: maplibregl.Map) => {
      cameraHoldUntil = Date.now() + 1200
      map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 12) })
    }
    // direct when possible — withMap's loaded() gate would swallow the tap
    // if some camera animation happens to be running
    const map = getMap()
    if (map) ease(map)
    else withMap(ease)
  }
}

// ---------- track recording ----------

const MIN_DIST_NM = 0.003 // ~5.5 m
const MIN_INTERVAL_MS = 2000

const LIVE_SOURCE = 'track-live'

function updateLiveTrail() {
  const map = getMap()
  if (!map || !map.loaded()) return
  if (!map.getSource(LIVE_SOURCE)) {
    map.addSource(LIVE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: 'track-live-line',
      type: 'line',
      source: LIVE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#59e0b8', 'line-width': 3.5, 'line-opacity': 0.85 },
    })
  }
  const src = map.getSource(LIVE_SOURCE) as maplibregl.GeoJSONSource
  src.setData(
    liveCoords.length > 1
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: liveCoords }, properties: {} }
      : { type: 'FeatureCollection', features: [] },
  )
}

async function recordPoint(fix: Fix) {
  if (activeTrackId == null) return
  if (lastRecorded) {
    const d = distanceNm(lastRecorded.lon, lastRecorded.lat, fix.lon, fix.lat)
    if (d < MIN_DIST_NM && fix.ts - lastRecorded.ts < MIN_INTERVAL_MS) return
    useGpsStore.getState().addDistance(d)
  }
  lastRecorded = fix
  if (fix.sogKn != null && fix.sogKn > maxSog) maxSog = fix.sogKn
  liveCoords.push([fix.lon, fix.lat])
  updateLiveTrail()
  await db.points.add({
    trackId: activeTrackId,
    ts: fix.ts,
    lon: fix.lon,
    lat: fix.lat,
    sogKn: fix.sogKn,
    cog: fix.cog,
  })
}

export async function startRecording() {
  startGps()
  const startedAt = Date.now()
  const name = new Date(startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  maxSog = 0
  lastRecorded = null
  liveCoords = []
  updateLiveTrail()
  activeTrackId = (await db.tracks.add({
    name: `Track — ${name}`,
    startedAt,
    endedAt: null,
    distanceNm: 0,
    maxSogKn: 0,
  })) as number
  useGpsStore.getState().setRecording(true, startedAt)
}

export async function stopRecording() {
  if (activeTrackId == null) return
  const id = activeTrackId
  activeTrackId = null
  const { recordingDistanceNm } = useGpsStore.getState()
  await db.tracks.update(id, {
    endedAt: Date.now(),
    distanceNm: recordingDistanceNm,
    maxSogKn: maxSog,
  })
  useGpsStore.getState().setRecording(false)
  lastRecorded = null
}

export function isRecording(): boolean {
  return activeTrackId != null
}
