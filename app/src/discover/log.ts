import { db, type Arrival, type Outing } from '../tracking/db'
import { seasonOf } from './season'

/**
 * The log: arrivals, outings and the tracks' season totals, read from Dexie
 * once and kept in memory so the achievement checks stay synchronous.
 */

export interface LogView {
  arrivals: Arrival[]
  outings: Outing[]
  trackCount: number
  /** Nautical miles recorded this season. */
  seasonNm: number
}

let view: LogView = { arrivals: [], outings: [], trackCount: 0, seasonNm: 0 }
const listeners = new Set<() => void>()

export function logView(): LogView {
  return view
}

export function onLog(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit() {
  for (const l of listeners) l()
}

export async function loadLog(): Promise<void> {
  const [arrivals, outings] = await Promise.all([
    db.arrivals.orderBy('at').toArray(),
    db.outings.orderBy('startedAt').toArray(),
  ])
  view = { ...view, arrivals, outings }
  await refreshTracks()
}

export async function refreshTracks(): Promise<void> {
  const tracks = await db.tracks.toArray()
  const year = seasonOf(Date.now())
  const finished = tracks.filter((t) => t.endedAt != null)
  const seasonNm = finished
    .filter((t) => seasonOf(t.startedAt) === year)
    .reduce((a, t) => a + (t.distanceNm || 0), 0)
  view = { ...view, trackCount: finished.length, seasonNm }
  emit()
}

/** Record being at a place — once per place per calendar day. */
export async function addArrival(name: string, lon: number, lat: number, at: number): Promise<boolean> {
  const day = new Date(at).toDateString()
  if (view.arrivals.some((a) => a.name === name && new Date(a.at).toDateString() === day)) return false
  const row: Arrival = { name, lon, lat, at }
  row.id = (await db.arrivals.add(row)) as number
  view = { ...view, arrivals: [...view.arrivals, row] }
  emit()
  return true
}

export async function saveOuting(o: Outing): Promise<void> {
  if (o.id == null) o.id = (await db.outings.add(o)) as number
  else await db.outings.put(o)
  const rest = view.outings.filter((x) => x.id !== o.id)
  view = { ...view, outings: [...rest, o].sort((a, b) => a.startedAt - b.startedAt) }
  emit()
}

/** How many days the boat has been at a named place. */
export function arrivalsAt(name: string): number {
  return view.arrivals.filter((a) => a.name === name).length
}
