import Dexie, { type EntityTable } from 'dexie'

export interface Track {
  id?: number
  name: string
  startedAt: number
  endedAt: number | null
  distanceNm: number
  maxSogKn: number
}

export interface TrackPoint {
  id?: number
  trackId: number
  ts: number
  lon: number
  lat: number
  sogKn: number | null
  cog: number | null
}

export interface CachedForecast {
  key: string // e.g. "grid:<bboxhash>" or "point:<lon>,<lat>"
  fetchedAt: number
  payload: unknown
}

export interface SavedTrip {
  id?: number
  name: string
  destName: string | null // null = pinned point
  lon: number
  lat: number
  roundTrip: boolean
  cruiseKn: number
  stayMin: number // minimum time at the destination
  backBy?: number | null // latest hour-of-day to be home (absent on old rows)
  vias?: [number, number][] // course points the route is steered through (absent on old rows)
  start?: { name: string | null; lon: number; lat: number } | null // fixed start point; null/absent = current location
  createdAt: number
}

/** A reusable trip start point (launch ramp, marina slip, cottage dock). */
export interface SavedStart {
  id?: number
  name: string
  lon: number
  lat: number
  createdAt: number
}

/** The boat was at a named place: within arrival range of it, once per place
 *  per day. The per-place count the log, the season flags and the Discover
 *  achievements all read from — arrival used to be latched per trip only. */
export interface Arrival {
  id?: number
  name: string
  lon: number
  lat: number
  at: number
}

/** One trip, start to end: what was promised as it cast off, what happened,
 *  and the sea the skipper felt (one tap on the ramp at the end). */
export interface Outing {
  id?: number
  startedAt: number
  endedAt: number | null
  /** When the app was opened before this trip started (Last Minute Club). */
  openedAt: number | null
  destName: string | null
  destLon: number
  destLat: number
  originLon: number
  originLat: number
  roundTrip: boolean
  plannedNm: number | null
  plannedArriveMs: number | null
  plannedHomeMs: number | null
  arrivedAt: number | null
  leftDestAt: number | null
  homeAt: number | null
  /** Recorded track distance at the end, nm. */
  trackNm: number | null
  /** Sea-state band the forecast gave at the destination on arrival. */
  forecastBand: number | null
  /** Sea-state band the skipper felt — the ramp tap on the arrival card. */
  feltBand: number | null
  /** Helm view was up on the ride home. */
  helmHome: boolean
  /** The skipper's wave limit and sea-state scale as the trip cast off —
   *  so a judgement about that day is made against that day's settings. */
  limitM?: number | null
  scaleM?: number | null
}

const db = new Dexie('sandies') as Dexie & {
  tracks: EntityTable<Track, 'id'>
  points: EntityTable<TrackPoint, 'id'>
  forecasts: EntityTable<CachedForecast, 'key'>
  trips: EntityTable<SavedTrip, 'id'>
  starts: EntityTable<SavedStart, 'id'>
  arrivals: EntityTable<Arrival, 'id'>
  outings: EntityTable<Outing, 'id'>
}

db.version(1).stores({
  tracks: '++id, startedAt',
  points: '++id, trackId, ts',
  forecasts: 'key, fetchedAt',
})

db.version(2).stores({
  trips: '++id, createdAt',
})

db.version(3).stores({
  starts: '++id, createdAt',
})

db.version(4).stores({
  arrivals: '++id, name, at',
  outings: '++id, startedAt',
})

export { db }
