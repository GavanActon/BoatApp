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

const db = new Dexie('sandies') as Dexie & {
  tracks: EntityTable<Track, 'id'>
  points: EntityTable<TrackPoint, 'id'>
  forecasts: EntityTable<CachedForecast, 'key'>
}

db.version(1).stores({
  tracks: '++id, startedAt',
  points: '++id, trackId, ts',
  forecasts: 'key, fetchedAt',
})

export { db }
