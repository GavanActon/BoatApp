import { create } from 'zustand'

export interface Fix {
  lon: number
  lat: number
  accuracy: number // metres
  sogKn: number | null // speed over ground, knots
  cog: number | null // course over ground, degrees true
  ts: number
}

export type GpsStatus = 'off' | 'acquiring' | 'on' | 'denied' | 'error'

interface GpsState {
  status: GpsStatus
  fix: Fix | null
  recording: boolean
  recordingSince: number | null
  recordingDistanceNm: number
  setStatus: (s: GpsStatus) => void
  setFix: (f: Fix | null) => void
  setRecording: (on: boolean, since?: number | null) => void
  addDistance: (nm: number) => void
}

export const useGpsStore = create<GpsState>((set) => ({
  status: 'off',
  fix: null,
  recording: false,
  recordingSince: null,
  recordingDistanceNm: 0,
  setStatus: (status) => set({ status }),
  setFix: (fix) => set({ fix }),
  setRecording: (recording, since = null) =>
    set({ recording, recordingSince: since, ...(recording ? { recordingDistanceNm: 0 } : {}) }),
  addDistance: (nm) => set((s) => ({ recordingDistanceNm: s.recordingDistanceNm + nm })),
}))

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
