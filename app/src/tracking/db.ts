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
  createdAt: number
}

const db = new Dexie('sandies') as Dexie & {
  tracks: EntityTable<Track, 'id'>
  points: EntityTable<TrackPoint, 'id'>
  forecasts: EntityTable<CachedForecast, 'key'>
  trips: EntityTable<SavedTrip, 'id'>
}

db.version(1).stores({
  tracks: '++id, startedAt',
  points: '++id, trackId, ts',
  forecasts: 'key, fetchedAt',
})

db.version(2).stores({
  trips: '++id, createdAt',
})

export { db }
