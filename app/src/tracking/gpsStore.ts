import { create } from 'zustand'

export interface Fix {
  lon: number
  lat: number
  accuracy: number // metres
  sogKn: number | null // speed over ground, knots
  cog: number | null // course over ground, degrees true
  ts: number
}

// 'insecure' is its own answer, not a denial: browsers refuse geolocation
// outright on a plain-http origin that isn't localhost, and no amount of
// granting permission changes that
export type GpsStatus = 'off' | 'acquiring' | 'on' | 'denied' | 'error' | 'insecure'

interface GpsState {
  status: GpsStatus
  fix: Fix | null
  recording: boolean
  recordingSince: number | null
  recordingDistanceNm: number
  /**
   * Speed over ground, averaged over the last couple of minutes.
   *
   * Raw SOG is far too twitchy to divide a distance by: on a chop it swings
   * enough to make "time left" flicker between 22 and 31 minutes, and a
   * number that changes while you are looking at it is worse than one
   * slightly stale. Null until there's enough movement to mean anything.
   */
  avgSogKn: number | null
  /** Why the last attempt failed, in the browser's own words. "No GPS fix"
   *  is not a diagnosis; "location services are off" is. */
  lastError: string | null
  setStatus: (s: GpsStatus, lastError?: string | null) => void
  setFix: (f: Fix | null) => void
  setRecording: (on: boolean, since?: number | null) => void
  addDistance: (nm: number) => void
}

export const useGpsStore = create<GpsState>((set) => ({
  status: 'off',
  fix: null,
  lastError: null,
  recording: false,
  recordingSince: null,
  recordingDistanceNm: 0,
  avgSogKn: null,
  setStatus: (status, lastError) => set(lastError === undefined ? { status } : { status, lastError }),
  setFix: (fix) => set({ fix, avgSogKn: pushSog(fix) }),
  setRecording: (recording, since = null) =>
    set({ recording, recordingSince: since, ...(recording ? { recordingDistanceNm: 0 } : {}) }),
  addDistance: (nm) => set((s) => ({ recordingDistanceNm: s.recordingDistanceNm + nm })),
}))

// rolling SOG window — module state, because it's a smoothing detail of the
// signal rather than something any component should see mid-flight
const SOG_WINDOW_MS = 120_000
const MOVING_KN = 0.8 // below this the boat is drifting, not running
let sogHistory: { ts: number; kn: number }[] = []

function pushSog(fix: Fix | null): number | null {
  if (!fix || fix.sogKn == null) return null
  const now = fix.ts
  sogHistory.push({ ts: now, kn: fix.sogKn })
  sogHistory = sogHistory.filter((h) => now - h.ts <= SOG_WINDOW_MS)
  const moving = sogHistory.filter((h) => h.kn >= MOVING_KN)
  // stopped for the whole window is a real answer: null, so callers fall back
  // to planned cruise rather than reporting an ETA of infinity
  if (moving.length === 0) return null
  return moving.reduce((a, h) => a + h.kn, 0) / moving.length
}

// dev-only handle, as with window.__map — the harness spoofs positions and
// needs to see whether the watch actually delivered them
if (import.meta.env.DEV) {
  ;(window as unknown as { __gps?: unknown }).__gps = useGpsStore
}

/** Forget the rolling speed — call when a trip ends or recording stops. */
// dev-only handle, the same convention as MapView's window.__map and the
// route store's window.__route — lets the verify harness read the live fix
if (import.meta.env.DEV) {
  ;(window as unknown as { __gps?: unknown }).__gps = useGpsStore
}

export function resetSogAverage() {
  sogHistory = []
  useGpsStore.setState({ avgSogKn: null })
}

/** Haversine distance in nautical miles. */
export function distanceNm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 3440.065 // earth radius in nm
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLon = (bLon - aLon) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
