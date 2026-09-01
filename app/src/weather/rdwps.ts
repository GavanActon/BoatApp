import { REGION_BBOX } from '../config'
import { db } from '../tracking/db'
import { GRID_SHAPE, type GridForecast } from './openMeteo'

/**
 * ECCC RDWPS Lake Superior overlay — the better waves.
 *
 * The Open-Meteo grid's wave fields come from global models (~8–25 km) that
 * barely resolve Whitefish Bay. A scheduled pipeline job decodes ECCC's
 * dedicated ~1 km Lake Superior wave model (HRDPS-forced, ice-aware, the
 * most accurate operational model for this water) at the app's own 8×7
 * lattice and publishes `data/waves-superior.json` alongside the charts.
 *
 * This module fetches that file and overwrites the grid's waveM /
 * wavePeriodS / waveDir cell arrays for every hour the RDWPS run covers
 * (~48 h out). Beyond the horizon — and whenever the file is missing or its
 * run has gone stale — the Open-Meteo values simply remain: the overlay
 * only ever replaces numbers it has better versions of.
 *
 * Cached in IndexedDB like every forecast, so the last overlay keeps
 * upgrading the grid offline, with the same honesty rule (stale run = no
 * overlay) applied at merge time rather than fetch time.
 */

interface WaveOverlay {
  model: string
  run: string // ISO, Z-suffixed
  generated: string
  bbox: { west: number; south: number; east: number; north: number }
  cols: number
  rows: number
  time: string[] // UTC hourly, Open-Meteo format (no Z)
  cells: {
    waveM: (number | null)[]
    wavePeriodS: (number | null)[]
    waveDir: (number | null)[]
  }[]
}

/** A run older than this has been superseded twice over — let it go. */
const MAX_RUN_AGE_MS = 18 * 3600_000
const CACHE_KEY = 'rdwps:superior'

let overlay: WaveOverlay | null = null
let fetchedAt = 0

function usable(o: WaveOverlay | null): o is WaveOverlay {
  if (!o || !Array.isArray(o.cells) || !Array.isArray(o.time)) return false
  // the lattice contract: same shape, same bbox, same row-major order as
  // gridPoints() — a mismatch means a stale build somewhere, so stand down
  if (o.cols !== GRID_SHAPE.cols || o.rows !== GRID_SHAPE.rows) return false
  if (o.cells.length !== o.cols * o.rows) return false
  const b = o.bbox
  if (
    !b ||
    Math.abs(b.west - REGION_BBOX.west) > 1e-6 ||
    Math.abs(b.east - REGION_BBOX.east) > 1e-6 ||
    Math.abs(b.south - REGION_BBOX.south) > 1e-6 ||
    Math.abs(b.north - REGION_BBOX.north) > 1e-6
  ) {
    return false
  }
  return Date.now() - Date.parse(o.run) < MAX_RUN_AGE_MS
}

/** How long ago the overlay was last (re)fetched — the weather clock uses
 *  this to refetch it on its own cadence (the model runs 4×/day). */
export function waveOverlayAgeMs(): number {
  return fetchedAt ? Date.now() - fetchedAt : Infinity
}

/** The overlay's provenance, for anything that wants to say so. Null while
 *  the grid's waves are Open-Meteo's alone. */
export function waveOverlayInfo(): { model: string; run: string } | null {
  return usable(overlay) ? { model: overlay.model, run: overlay.run } : null
}

/**
 * The full health picture, for the Settings data rows — built to answer
 * "did the pipeline go down?" from the phone:
 *  - 'active':    RDWPS waves are on the grid right now.
 *  - 'stale-run': the file arrived but its run is too old to trust — the CI
 *                 job or the Datamart has missed at least two cycles, and the
 *                 app has quietly fallen back to the global model.
 *  - 'missing':   no file at all (first run offline, or Pages unreachable).
 */
export function waveOverlayStatus(): {
  state: 'active' | 'stale-run' | 'missing'
  /** ms since the model run this data came from (Infinity when missing). */
  runAgeMs: number
  /** ms since we last tried to fetch the file (Infinity before first try). */
  checkedAgoMs: number
} {
  const checkedAgoMs = fetchedAt ? Date.now() - fetchedAt : Infinity
  if (!overlay) return { state: 'missing', runAgeMs: Infinity, checkedAgoMs }
  return {
    state: usable(overlay) ? 'active' : 'stale-run',
    runAgeMs: Date.now() - Date.parse(overlay.run),
    checkedAgoMs,
  }
}

// Where the file lives. In production it deploys beside the app and CI
// refreshes it 4×/day. A dev checkout only has whatever run was last
// committed or generated locally — usually stale within a day — so dev
// drinks from the DEPLOYED site first (Pages serves it with CORS *), and
// only falls back to the local copy when offline.
const WAVES_FILE = 'data/waves-superior.json'
const DEPLOYED_WAVES = `https://sandies.app/${WAVES_FILE}`

/** Fetch (or refresh) the overlay file; falls back to the cached copy. */
export async function refreshWaveOverlay(): Promise<void> {
  fetchedAt = Date.now()
  // cache-bust hourly: the file changes 4×/day and Pages caches hard
  const bust = Math.floor(Date.now() / 3600_000)
  const local = `${import.meta.env.BASE_URL}${WAVES_FILE}?t=${bust}`
  const urls = import.meta.env.DEV ? [`${DEPLOYED_WAVES}?t=${bust}`, local] : [local]
  for (const url of urls) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) continue
      const o = (await resp.json()) as WaveOverlay
      if (!o || o.cols == null) continue // not even the right file
      // Keep it EVEN IF the run is too old to apply — usable() gates every
      // application, and holding the file is what lets the status row say
      // "run too old" (the pipeline's down) instead of "unavailable" (the
      // fetch failed), which are different problems with different fixes.
      overlay = o
      if (usable(o)) {
        try {
          await db.forecasts.put({ key: CACHE_KEY, fetchedAt: Date.now(), payload: o })
        } catch {
          /* cache is best-effort */
        }
      }
      return
    } catch {
      /* try the next source */
    }
  }
  if (!overlay) {
    try {
      const row = await db.forecasts.get(CACHE_KEY)
      if (row) overlay = row.payload as WaveOverlay
    } catch {
      /* stay on Open-Meteo */
    }
  }
}

/** Fetch the overlay once, ever — the lazy door for the point-forecast
 *  paths, which can run before the weather layer's first refresh. */
let ensured: Promise<void> | null = null
export function ensureWaveOverlay(): Promise<void> {
  ensured ??= refreshWaveOverlay()
  return ensured
}

/**
 * Bilinear sample of the overlay at a point for one hour index — the same
 * corner-weighted, null-aware, vector-averaged-direction arithmetic the
 * grid's own sampler uses, so a strip cell and the map never disagree.
 */
function sampleOverlay(
  o: WaveOverlay,
  i: number,
  lon: number,
  lat: number,
): { h: number; T: number | null; dir: number | null } | null {
  const b = o.bbox
  const dLon = (b.east - b.west) / o.cols
  const dLat = (b.north - b.south) / o.rows
  const fx = (lon - (b.west + dLon / 2)) / dLon
  const fy = (lat - (b.south + dLat / 2)) / dLat
  const x0 = Math.min(o.cols - 2, Math.max(0, Math.floor(fx)))
  const y0 = Math.min(o.rows - 2, Math.max(0, Math.floor(fy)))
  const tx = Math.min(1, Math.max(0, fx - x0))
  const ty = Math.min(1, Math.max(0, fy - y0))
  const corners: [number, number][] = [
    [y0 * o.cols + x0, (1 - tx) * (1 - ty)],
    [y0 * o.cols + x0 + 1, tx * (1 - ty)],
    [(y0 + 1) * o.cols + x0, (1 - tx) * ty],
    [(y0 + 1) * o.cols + x0 + 1, tx * ty],
  ]
  let h = 0
  let hw = 0
  let T = 0
  let Tw = 0
  let u = 0
  let v = 0
  let dw = 0
  for (const [k, w] of corners) {
    if (!w) continue
    const c = o.cells[k]
    const ch = c.waveM[i]
    if (ch == null) continue
    h += ch * w
    hw += w
    const ct = c.wavePeriodS[i]
    if (ct != null) {
      T += ct * w
      Tw += w
    }
    const cd = c.waveDir[i]
    if (cd != null) {
      const r = (cd * Math.PI) / 180
      u += Math.sin(r) * w
      v += Math.cos(r) * w
      dw += w
    }
  }
  if (hw <= 0) return null
  return {
    h: h / hw,
    T: Tw > 0 ? T / Tw : null,
    dir: dw > 0 ? ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 : null,
  }
}

/**
 * Overwrite a point forecast's wave series in place for the hours the
 * overlay covers. `t0Ms` is the epoch of the series' first hour (the caller
 * knows its own time format); hours are assumed contiguous.
 */
export function applyWaveOverlayToSeries(
  lon: number,
  lat: number,
  t0Ms: number,
  n: number,
  waveM: (number | null)[],
  wavePeriodS: (number | null)[],
  waveDir?: (number | null)[],
): void {
  const o = overlay
  if (!usable(o)) return
  const o0 = Date.parse(`${o.time[0]}Z`)
  const shift = Math.round((o0 - t0Ms) / 3600_000)
  for (let i = 0; i < o.time.length; i++) {
    const gi = i + shift
    if (gi < 0 || gi >= n) continue
    const s = sampleOverlay(o, i, lon, lat)
    if (!s) continue // overlay has no water here: the global model's word stands
    waveM[gi] = Math.round(s.h * 100) / 100
    if (s.T != null) wavePeriodS[gi] = Math.round(s.T * 10) / 10
    if (waveDir && s.dir != null) waveDir[gi] = Math.round(s.dir)
  }
}

/**
 * Overwrite `grid`'s wave fields with the overlay's, hour by hour, in place.
 * Idempotent and cheap — safe to run after every grid land or overlay
 * refresh. Returns true when anything was upgraded.
 */
export function applyWaveOverlay(grid: GridForecast): boolean {
  if (!usable(overlay)) return false
  if (grid.cells.length !== overlay.cells.length) return false
  if (grid.time.length === 0) return false

  // both time axes are contiguous UTC hours — align by arithmetic, not search
  const g0 = Date.parse(`${grid.time[0]}Z`)
  const o0 = Date.parse(`${overlay.time[0]}Z`)
  const shift = Math.round((o0 - g0) / 3600_000)

  let touched = false
  for (let k = 0; k < grid.cells.length; k++) {
    const gc = grid.cells[k]
    const oc = overlay.cells[k]
    for (let i = 0; i < overlay.time.length; i++) {
      const gi = i + shift
      if (gi < 0 || gi >= grid.time.length) continue
      const h = oc.waveM[i]
      if (h == null) continue // RDWPS land/no-data: Open-Meteo's word stands
      gc.waveM[gi] = h
      if (oc.wavePeriodS[i] != null) {
        ;(gc.wavePeriodS ??= [])[gi] = oc.wavePeriodS[i]
      }
      if (oc.waveDir[i] != null) {
        ;(gc.waveDir ??= [])[gi] = oc.waveDir[i]
      }
      touched = true
    }
  }
  return touched
}
