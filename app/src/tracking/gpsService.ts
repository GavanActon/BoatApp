import maplibregl from 'maplibre-gl'
import { withMap, getMap } from '../map/mapController'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { db } from './db'
import { judge, newGate, type GateState } from './fixGate'
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
let lastFixAt = 0
let watchdogId: number | null = null

// iOS Safari silently kills a geolocation watch while the page is hidden or the
// screen is locked, and a dead watch fires no error callback — the only remedy
// is tearing it down and starting a fresh one
const STALE_RESTART_MS = 15000
const STALE_ERROR_MS = 30000

/** The gate every fix passes before the boat moves, the track takes it or
 *  the crew hears it — see fixGate.ts. */
let gate: GateState<Fix> = newGate<Fix>()
/** A coarse fix may still nudge the marker once the good ones have been
 *  silent this long — a rough place beats a frozen boat — but never the
 *  store, the track or the crew. */
const COARSE_MARKER_AFTER_MS = 20_000
const COARSE_MARKER_MAX_M = 200
let lastGoodAt = 0

// recording state
let activeTrackId: number | null = null
let lastRecorded: Fix | null = null
let maxSog = 0
/** The live trail, in segments: a new one starts after a silence. */
let liveSegs: [number, number][][] = []
/** Silence longer than this breaks the track line. */
const GAP_MS = 60_000

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
  if (document.visibilityState === 'visible' && watchId != null) {
    void acquireWakeLock()
    restartWatch()
  }
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
  // any fix at all keeps the watchdog quiet: the watch is alive, even if
  // what it says is not worth keeping
  lastFixAt = Date.now()
  const gps = useGpsStore.getState()
  if (gps.status !== 'on') gps.setStatus('on')

  const { verdict, keep } = judge(fix, gate)
  if (verdict !== 'good') {
    gps.setDropped(gate.dropped)
    if (verdict === 'coarse' && fix.accuracy <= COARSE_MARKER_MAX_M && Date.now() - lastGoodAt > COARSE_MARKER_AFTER_MS) {
      placeMarker(fix, false)
    }
    return
  }
  lastGoodAt = Date.now()
  for (const f of keep) {
    gps.setFix(f)
    void recordPoint(f)
  }
  placeMarker(keep[keep.length - 1], true)
}

/** Move the boat on the chart; `steer` lets the camera follow it too. */
function placeMarker(fix: Fix, steer: boolean) {
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
    if (!steer) return
    const { follow, headingUp, helm } = useAppStore.getState()
    if (follow && Date.now() >= cameraHoldUntil) followCamera(map, fix, headingUp || helm)
  }
  if (liveMap) update(liveMap)
  else withMap(update)
}

// A fix lands about once a second, and the camera used to answer every one of
// them with a 900 ms easeTo. That meant the map was animating roughly all the
// time while following — and moored, where the boat goes nowhere, GPS jitter
// alone kept restarting it. The render loop never went idle.
const MICRO_PX = 0.75 // below this the screen cannot show the move at all
const STEP_PX = 12 // small enough to place instantly without reading as a jump
const TURN_DEG = 3 // a course change, not the wander of a steady heading
const COG_MIN_KN = 1.5 // below steerage way COG is noise, not a course

/**
 * Keep the boat centred without animating for movement nobody can see.
 *
 * The unit is screen pixels, not metres: at the zoom a trip is framed at, a
 * boat doing 15 kn crosses well under a pixel a second, so "how far has it
 * moved" only means anything on screen. Sub-pixel, do nothing. A few pixels,
 * place it — instant is both cheaper than a 54-frame ease and truer, since
 * the ease was always 900 ms behind. Only a real jump (a GPS correction, or
 * coming back to follow after panning) is worth animating.
 *
 * Bearing gets the same treatment for a second reason: the wind and sea
 * engines key their canvas on it, so every tenth of a degree threw the flow
 * field away and rebuilt it. Heading-up used to hand them COG noise once a
 * second, which is what made the field blink while sitting still.
 */
function followCamera(map: maplibregl.Map, fix: Fix, courseUp: boolean) {
  const from = map.project(map.getCenter())
  const to = map.project([fix.lon, fix.lat])
  const movedPx = Math.hypot(to.x - from.x, to.y - from.y)

  // Course-up holds its heading when the boat is not making way. COG is
  // derived from successive fixes, so tied up or drifting it is not a course
  // at all — it swings through whatever the noise says, and every swing threw
  // the flow field away. A plotter behaves the same: stopped, the chart holds
  // — unless a trip is under way at the helm, when the run's own course from
  // here is the direction of travel, known before the boat has moved.
  const now = map.getBearing()
  const steering = courseUp && fix.cog != null && (fix.sogKn ?? 0) >= COG_MIN_KN
  const want = steering ? fix.cog! : (courseUp ? plannedCourse(fix.lon, fix.lat) : null) ?? now
  const turnedDeg = Math.abs(((want - now + 540) % 360) - 180)
  const bearing = turnedDeg >= TURN_DEG ? want : now
  const turning = bearing !== now

  if (movedPx < MICRO_PX && !turning) return // jitter: leave the camera alone
  const center: [number, number] = [fix.lon, fix.lat]
  if (movedPx <= STEP_PX && !turning) {
    map.jumpTo({ center })
    return
  }
  map.easeTo({ center, bearing, duration: 900, essential: true })
}

function onError(err: GeolocationPositionError) {
  const gps = useGpsStore.getState()
  // the browser's own words, which say far more than we can guess: a PC with
  // Windows location services switched off reports POSITION_UNAVAILABLE, and
  // that is a different problem from a slow fix on the water
  const why =
    err.code === err.POSITION_UNAVAILABLE
      ? 'no position source — check location services'
      : err.code === err.TIMEOUT
        ? 'timed out'
        : (err.message ?? 'unknown')
  if (err.code === err.PERMISSION_DENIED) {
    gps.setStatus('denied', err.message || null)
    return
  }
  // a watch keeps trying after TIMEOUT/POSITION_UNAVAILABLE; if we already
  // have a fix, keep showing it instead of flashing a warning every 30 s
  if (err.code === err.TIMEOUT && gps.fix) return
  gps.setStatus('error', why)
}

function beginWatch() {
  watchId = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: true,
    // never a cached position: a fresh watch after the lock screen used to
    // open with the last one it had, and the gate would only have to drop it
    maximumAge: 0,
    timeout: 30000,
  })
}

function restartWatch() {
  if (watchId == null) return
  navigator.geolocation.clearWatch(watchId)
  beginWatch()
}

export function startGps() {
  if (watchId != null || !('geolocation' in navigator)) return
  // every call reaches here from a user gesture (locate, the onboarding
  // row, recording, helm) or from startGpsIfAllowed's granted check — so
  // from now on launches may start GPS without being asked again
  useAppStore.getState().setGpsWanted(true)
  // A plain-http page served over the LAN is not a secure context, and every
  // browser refuses geolocation there — Chrome reports it as PERMISSION_DENIED,
  // which had the app telling people to allow location for a site where
  // allowing it cannot help. Say the real thing instead. (npm run dev:phone
  // exists for this: it serves the same tree over https.)
  if (!window.isSecureContext) {
    useGpsStore.getState().setStatus('insecure')
    return
  }
  useGpsStore.getState().setStatus('acquiring')
  beginWatch()
  // a dead watch is indistinguishable from a slow one from the outside, so
  // watch the fix age ourselves: restart when stale, and stop pretending the
  // instruments are live once the fix is old enough to be dangerous
  watchdogId = window.setInterval(() => {
    if (watchId == null || lastFixAt === 0 || document.visibilityState !== 'visible') return
    const age = Date.now() - lastFixAt
    if (age > STALE_RESTART_MS) restartWatch()
    if (age > STALE_ERROR_MS && useGpsStore.getState().status === 'on') {
      useGpsStore.getState().setStatus('error')
    }
  }, 10000)
  void acquireWakeLock()
}

export function stopGps() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId)
    watchId = null
  }
  if (watchdogId != null) {
    clearInterval(watchdogId)
    watchdogId = null
  }
  lastFixAt = 0
  lastGoodAt = 0
  gate = newGate<Fix>()
  marker?.remove()
  marker = null
  markerAdded = false
  wakeLock?.release().catch(() => {})
  wakeLock = null
  useGpsStore.getState().setStatus('off')
  useGpsStore.getState().setFix(null)
}

/**
 * The launch-time start: never the one that PROMPTS. The first location
 * prompt belongs to the onboarding card's "Allow location" row (§10.2), so
 * a cold open only starts the watch when the user has asked for GPS before
 * (gpsWanted) or the OS reports permission already granted — covering
 * installs that predate the flag. Browsers without the Permissions API
 * simply wait for the first tap on locate.
 */
export function startGpsIfAllowed() {
  if (useAppStore.getState().gpsWanted) {
    startGps()
    return
  }
  navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => {
      if (p.state === 'granted') startGps()
    })
    .catch(() => {})
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
    // direct when possible — easeTo needs no style, so don't make the tap wait
    // on the style parsing
    const map = getMap()
    if (map) ease(map)
    else withMap(ease)
  }
}

// Helm view geometry. The pitch matches the map's maxPitch, so the gesture
// and the toggle land on the same horizon. The padding pushes the camera's
// center point (the boat, while following) down the screen: MapLibre places
// the center in the middle of the UNPADDED area, so reserving everything
// above the bottom cards but a sliver renders the boat just clear of them —
// the whole screen above is what's coming up ahead, and the cards never
// cover the boat.
const HELM_PITCH = 60
const HELM_AHEAD_PX = 44 // water between the boat and the top of the cards
const HELM_MIN_ZOOM = 13 // "what's coming up" scale, not the passage overview

const flatPadding = { top: 0, bottom: 0, left: 0, right: 0 }

function helmPadding(map: maplibregl.Map) {
  const h = map.getContainer().clientHeight
  const bar = document.querySelector('.bottombar')?.getBoundingClientRect().height ?? 0
  const bottom = Math.round(bar)
  const top = Math.max(0, h - bottom - HELM_AHEAD_PX * 2)
  return { ...flatPadding, top, bottom }
}

// the cards under the boat change height — the live card minimised, the
// arrival strip arriving — and the boat has to stay clear of them
let helmRo: ResizeObserver | null = null

function watchHelmPadding() {
  helmRo?.disconnect()
  helmRo = null
  if (typeof ResizeObserver === 'undefined') return
  const bar = document.querySelector('.bottombar')
  if (!bar) return
  // seeded with the height the helm ease already used: an observer fires
  // once on observe, and an ease from that callback cancelled the pitch
  let last = Math.round(bar.getBoundingClientRect().height)
  helmRo = new ResizeObserver(() => {
    const map = getMap()
    if (!map || !useAppStore.getState().helm) return
    const p = helmPadding(map)
    if (p.bottom === last) return
    last = p.bottom
    map.easeTo({ padding: p, duration: 400 })
  })
  helmRo.observe(bar)
}

const KM_LAT = 111.2

/** Bearing (° true) from a to b — the flat-earth version is plenty at bay scale. */
function bearingDeg(a: [number, number], b: [number, number]): number {
  const kx = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  const dx = (b[0] - a[0]) * kx
  const dy = b[1] - a[1]
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
}

/**
 * The plotted run's course from where the boat is: from the nearest route
 * point to the one about 300 m on. Only while a trip is under way at the
 * helm — that is when the run IS the direction of travel, before the boat
 * has moved enough for COG to say so. Null otherwise.
 */
function plannedCourse(lon: number, lat: number): number | null {
  const app = useAppStore.getState()
  const rs = useRouteStore.getState()
  if (!app.helm || rs.tripStartedAt == null) return null
  const coords = rs.route?.coords
  if (!coords || coords.length < 2) return null
  const kx = Math.cos((lat * Math.PI) / 180)
  let bi = 0
  let bd = Infinity
  for (let i = 0; i < coords.length; i++) {
    const d = ((coords[i][0] - lon) * kx) ** 2 + (coords[i][1] - lat) ** 2
    if (d < bd) {
      bd = d
      bi = i
    }
  }
  if (bi >= coords.length - 1) return null // at the far end: nowhere on to point
  // far enough on that a sharp corner right at the boat doesn't set the course
  let j = bi + 1
  let km = 0
  while (j < coords.length - 1 && km < 0.3) {
    km += Math.hypot((coords[j][0] - coords[j - 1][0]) * kx * KM_LAT, (coords[j][1] - coords[j - 1][1]) * KM_LAT)
    j++
  }
  return bearingDeg(coords[bi], coords[j])
}

/**
 * Pitch the chart into helm view and follow the boat course-up. A camera
 * stance layered on follow: dragging still breaks follow as always, but the
 * pitch and padding stay put, so the locate button drops you straight back
 * at the helm. Exiting is what flattens the chart.
 */
export function enterHelmView() {
  startGps()
  useAppStore.getState().setFollow(true)
  useAppStore.getState().setHelm(true)
  const fix = useGpsStore.getState().fix
  const ease = (map: maplibregl.Map) => {
    cameraHoldUntil = Date.now() + 1600
    const steering = fix?.cog != null && (fix.sogKn ?? 0) >= COG_MIN_KN
    const planned = fix ? plannedCourse(fix.lon, fix.lat) : null
    map.easeTo({
      ...(fix ? { center: [fix.lon, fix.lat] } : {}),
      zoom: Math.max(map.getZoom(), HELM_MIN_ZOOM),
      pitch: HELM_PITCH,
      bearing: steering ? fix.cog! : (planned ?? map.getBearing()),
      padding: helmPadding(map),
      duration: 1400,
      essential: true,
    })
    watchHelmPadding()
  }
  const map = getMap()
  if (map) ease(map)
  else withMap(ease)
}

/**
 * Heading-up — the flat chart rotated to the course while following. A camera
 * stance layered on follow the same way helm view is: switching it on starts
 * following, and the camera answers the tap now rather than on the next fix.
 */
export function setHeadingUpMode(on: boolean) {
  useAppStore.getState().setHeadingUp(on)
  if (on) {
    startGps()
    useAppStore.getState().setFollow(true)
    const fix = useGpsStore.getState().fix
    const ease = (map: maplibregl.Map) => {
      cameraHoldUntil = Date.now() + 1200
      const steering = fix?.cog != null && (fix.sogKn ?? 0) >= COG_MIN_KN
      map.easeTo({
        ...(fix ? { center: [fix.lon, fix.lat] } : {}),
        ...(steering ? { bearing: fix!.cog! } : {}),
        duration: 900,
        essential: true,
      })
    }
    const map = getMap()
    if (map) ease(map)
    else withMap(ease)
  } else if (!useAppStore.getState().helm) {
    // the rotation was this mode's doing, so take it back — unless helm view
    // still owns the bearing, in which case leave the course where it is
    withMap((map) => map.easeTo({ bearing: 0, duration: 800 }))
  }
}

/** Flatten back to the top-down chart. Follow stays however it was. */
export function exitHelmView() {
  useAppStore.getState().setHelm(false)
  helmRo?.disconnect()
  helmRo = null
  withMap((map) => map.easeTo({ pitch: 0, padding: flatPadding, duration: 800 }))
}

// ---------- track recording ----------

const MIN_DIST_NM = 0.003 // ~5.5 m
const MIN_INTERVAL_MS = 2000

const LIVE_SOURCE = 'track-live'

// withMap, not map.loaded() — loaded() waits on every tile source, and a fix
// arriving while tiles stream (or never finish) would drop the trail update
function updateLiveTrail() {
  withMap(updateLiveTrailOn)
}

function updateLiveTrailOn(map: maplibregl.Map) {
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
  const segs = liveSegs.filter((c) => c.length > 1)
  src.setData(
    segs.length
      ? { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: segs }, properties: {} }
      : { type: 'FeatureCollection', features: [] },
  )
}

async function recordPoint(fix: Fix) {
  if (activeTrackId == null) return
  let gap = false
  if (lastRecorded) {
    const d = distanceNm(lastRecorded.lon, lastRecorded.lat, fix.lon, fix.lat)
    if (d < MIN_DIST_NM && fix.ts - lastRecorded.ts < MIN_INTERVAL_MS) return
    // the distance across a silence is the straight line — an underestimate,
    // never a fiction; the LINE breaks there, since the path is unknown
    useGpsStore.getState().addDistance(d)
    gap = fix.ts - lastRecorded.ts > GAP_MS
  }
  lastRecorded = fix
  if (fix.sogKn != null && fix.sogKn > maxSog) maxSog = fix.sogKn
  if (gap || !liveSegs.length) liveSegs.push([])
  liveSegs[liveSegs.length - 1].push([fix.lon, fix.lat])
  updateLiveTrail()
  await db.points.add({
    trackId: activeTrackId,
    ts: fix.ts,
    lon: fix.lon,
    lat: fix.lat,
    sogKn: fix.sogKn,
    cog: fix.cog,
    ...(gap ? { gap: true } : {}),
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
  liveSegs = []
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

/** The track being recorded right now, for a mark to belong to. */
export function activeTrack(): number | null {
  return activeTrackId
}
