import { REGION_BBOX } from '../config'
import { db } from '../tracking/db'
import { fetchTimeout, GRID_SHAPE, type GridForecast } from './openMeteo'

/**
 * ECCC HRDPS wind overlay — the wind straight from the source.
 *
 * The grid's wind already comes from HRDPS (ECCC's 2.5 km model, the one
 * that forces the RDWPS waves) — but by way of Open-Meteo, which re-serves
 * ECCC's runs and has its own outages. This module fetches the same model
 * from ECCC's GeoMet service instead, for the ~48 h each run covers, and
 * overwrites the grid's windKn / windDir cell arrays hour by hour. Beyond
 * the horizon, and whenever GeoMet is unreachable or the run has gone
 * stale, the Open-Meteo values simply remain — the overlay only ever
 * replaces numbers it has a better copy of. Gusts, temperature, sky and
 * rain chance stay Open-Meteo's (GeoMet publishes no HRDPS gust field);
 * the gust is clamped to at least the overlaid wind so the two can never
 * disagree about which is bigger.
 *
 * How it fetches: one small WMS GetCapabilities call names the newest run
 * and its hour range; then one WCS GetCoverage per hour per field, each a
 * bbox subset SCALED TO THE APP'S OWN LATTICE (SCALESIZE 9×9), so a reply
 * is a 742-byte float32 GeoTIFF whose pixels ARE the grid cells — no
 * resampling on this side. ~100 requests, ~70 KB, ~10 s on a phone; only
 * paid when the run changes (the run is checked hourly, the data refetched
 * once per run). CORS is open (Access-Control-Allow-Origin: *), so the
 * phone talks to ECCC directly — no pipeline, no CI lag.
 *
 * Cached in IndexedDB like every forecast, so the last overlay keeps
 * upgrading the grid offline, with the same honesty rule (stale run = no
 * overlay) applied at merge time rather than fetch time.
 */

interface WindOverlay {
  model: string
  run: string // ISO, Z-suffixed
  generated: string
  bbox: { west: number; south: number; east: number; north: number }
  cols: number
  rows: number
  time: string[] // UTC hourly, Open-Meteo format (no Z)
  cells: {
    windKn: (number | null)[]
    windDir: (number | null)[]
  }[]
  /** False when some hours failed to fetch (they hold null) — a later
   *  refresh of the same run fills them in. */
  complete: boolean
}

/** A run older than this has been superseded twice over — let it go. */
const MAX_RUN_AGE_MS = 18 * 3600_000
const CACHE_KEY = 'hrdps:wind'
const MODEL = 'HRDPS 2.5 km'

const GEOMET = 'https://geo.weather.gc.ca/geomet'
const LAYER_SPEED = 'HRDPS.CONTINENTAL_WSPD' // m/s at 10 m
const LAYER_DIR = 'HRDPS.CONTINENTAL_WD' // degrees true, blowing FROM
const CONCURRENCY = 6
const MS_TO_KN = 1.943844

let overlay: WindOverlay | null = null
let fetchedAt = 0

function usable(o: WindOverlay | null): o is WindOverlay {
  if (!o || !Array.isArray(o.cells) || !Array.isArray(o.time)) return false
  // the lattice contract: same shape, same bbox, same row-major order as
  // gridPoints() — a mismatch means a stale cache somewhere, so stand down
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

/** How long ago the overlay was last checked — the weather clock uses this
 *  to re-check on its own cadence (the model runs 4×/day). */
export function windOverlayAgeMs(): number {
  return fetchedAt ? Date.now() - fetchedAt : Infinity
}

/** The overlay's provenance, for anything that wants to say so. Null while
 *  the grid's wind is Open-Meteo's alone. */
export function windOverlayInfo(): { model: string; run: string } | null {
  return usable(overlay) ? { model: overlay.model, run: overlay.run } : null
}

/**
 * The full health picture, for the Weather tab's data rows:
 *  - 'active':    HRDPS wind from GeoMet is on the grid right now.
 *  - 'stale-run': we hold a run too old to trust — GeoMet has stopped
 *                 publishing new ones (or we've been offline that long) and
 *                 the grid has quietly fallen back to Open-Meteo's wind.
 *  - 'missing':   nothing fetched yet, ever (first run offline, GeoMet down).
 */
export function windOverlayStatus(): {
  state: 'active' | 'stale-run' | 'missing'
  /** ms since the model run this data came from (Infinity when missing). */
  runAgeMs: number
  /** ms since we last checked GeoMet (Infinity before first try). */
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

// ---------- GeoMet ----------

/** The newest run GeoMet is serving and the hours it covers, read off the
 *  layer's WMS capabilities (one layer at a time — the service rejects a
 *  list). ~20 KB, sub-second. */
async function discoverRun(): Promise<{ run: string; startMs: number; endMs: number } | null> {
  const url = `${GEOMET}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&LAYER=${LAYER_SPEED}`
  const resp = await fetch(url, { signal: fetchTimeout() })
  if (!resp.ok) return null
  const xml = await resp.text()
  const time = /<Dimension name="time"[^>]*>([^<]*)</.exec(xml)?.[1]
  const run = /<Dimension name="reference_time"[^>]*default="([^"]+)"/.exec(xml)?.[1]
  if (!time || !run) return null
  const [start, end] = time.split('/')
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null
  return { run, startMs, endMs }
}

function coverageUrl(layer: string, run: string, isoHour: string): string {
  const b = REGION_BBOX
  return (
    `${GEOMET}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=${layer}` +
    `&FORMAT=image/tiff&SUBSETTINGCRS=EPSG:4326` +
    `&SUBSET=x(${b.west},${b.east})&SUBSET=y(${b.south},${b.north})` +
    `&SCALESIZE=x(${GRID_SHAPE.cols}),y(${GRID_SHAPE.rows})` +
    `&TIME=${isoHour}&DIM_REFERENCE_TIME=${run}`
  )
}

/**
 * The little-endian float32 GeoTIFF GeoMet returns, read just far enough to
 * get the pixels and prove they sit on our lattice. Returns the samples in
 * the app's cell order (row 0 = SOUTH, row-major) or null when anything
 * about the file is not what we asked for.
 */
function parseLatticeTiff(buf: ArrayBuffer): Float32Array | null {
  const dv = new DataView(buf)
  if (buf.byteLength < 8 || dv.getUint16(0, true) !== 0x4949 || dv.getUint16(2, true) !== 42) {
    return null
  }
  const ifd = dv.getUint32(4, true)
  if (ifd + 2 > buf.byteLength) return null
  const n = dv.getUint16(ifd, true)
  const tags = new Map<number, number[]>()
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 }
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > buf.byteLength) return null
    const tag = dv.getUint16(e, true)
    const type = dv.getUint16(e + 2, true)
    const count = dv.getUint32(e + 4, true)
    const size = typeSize[type]
    if (!size) continue // ASCII etc. — not needed
    const total = size * count
    const at = total <= 4 ? e + 8 : dv.getUint32(e + 8, true)
    if (at + total > buf.byteLength) return null
    const vals: number[] = []
    for (let k = 0; k < count; k++) {
      const p = at + k * size
      vals.push(
        type === 3 ? dv.getUint16(p, true) : type === 4 ? dv.getUint32(p, true) : type === 12 ? dv.getFloat64(p, true) : dv.getUint8(p),
      )
    }
    tags.set(tag, vals)
  }
  const w = tags.get(256)?.[0]
  const h = tags.get(257)?.[0]
  const bits = tags.get(258)?.[0]
  const compression = tags.get(259)?.[0] ?? 1
  const offsets = tags.get(273)
  const counts = tags.get(279)
  const format = tags.get(339)?.[0] ?? 1
  const scale = tags.get(33550)
  const tie = tags.get(33922)
  if (w !== GRID_SHAPE.cols || h !== GRID_SHAPE.rows) return null
  if (bits !== 32 || compression !== 1 || format !== 3) return null
  if (!offsets || !counts || offsets.length !== counts.length) return null
  // georeference: the top-left corner must be our bbox's NW corner and each
  // pixel exactly one lattice cell — anything else and pixel k ≠ cell k
  if (!scale || !tie) return null
  const b = REGION_BBOX
  const dLon = (b.east - b.west) / GRID_SHAPE.cols
  const dLat = (b.north - b.south) / GRID_SHAPE.rows
  if (Math.abs(tie[3] - b.west) > 1e-3 || Math.abs(tie[4] - b.north) > 1e-3) return null
  if (Math.abs(scale[0] - dLon) > 1e-3 || Math.abs(scale[1] - dLat) > 1e-3) return null

  const bytes = new Uint8Array(w * h * 4)
  let filled = 0
  for (let s = 0; s < offsets.length; s++) {
    const take = Math.min(counts[s], bytes.length - filled)
    if (offsets[s] + take > buf.byteLength) return null
    bytes.set(new Uint8Array(buf, offsets[s], take), filled)
    filled += take
  }
  if (filled !== bytes.length) return null
  const north = new Float32Array(bytes.buffer) // row 0 = north, as the file has it
  const out = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    out.set(north.subarray((h - 1 - r) * w, (h - r) * w), r * w)
  }
  return out
}

/** One field for one hour, as 81 samples in cell order — or null when the
 *  request failed or the file wasn't ours (that hour stays Open-Meteo's). */
async function fetchHour(layer: string, run: string, isoHour: string): Promise<Float32Array | null> {
  try {
    // a sub-second request normally; a hung one must not stall the pool
    const resp = await fetch(coverageUrl(layer, run, isoHour), { signal: fetchTimeout(15_000) })
    if (!resp.ok) return null
    const buf = await resp.arrayBuffer()
    return parseLatticeTiff(buf)
  } catch {
    return null
  }
}

/** Run `jobs` with at most CONCURRENCY in flight — a phone on a cell link
 *  gains nothing from a hundred simultaneous sockets. */
async function pool<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  async function worker() {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))
  return out
}

/** "2026-09-03T04:00" — the grid's own UTC hour format. */
function hourLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16)
}

async function fetchRun(run: string, startMs: number, endMs: number): Promise<WindOverlay | null> {
  const hours: number[] = []
  for (let ms = startMs; ms <= endMs; ms += 3600_000) hours.push(ms)
  const jobs = hours.flatMap((ms) => {
    const iso = `${hourLabel(ms)}:00Z`
    return [() => fetchHour(LAYER_SPEED, run, iso), () => fetchHour(LAYER_DIR, run, iso)]
  })
  const results = await pool(jobs)
  const nCells = GRID_SHAPE.cols * GRID_SHAPE.rows
  const cells = Array.from({ length: nCells }, () => ({
    windKn: new Array<number | null>(hours.length).fill(null),
    windDir: new Array<number | null>(hours.length).fill(null),
  }))
  let got = 0
  for (let i = 0; i < hours.length; i++) {
    const spd = results[i * 2]
    const dir = results[i * 2 + 1]
    if (!spd || !dir) continue
    got++
    for (let k = 0; k < nCells; k++) {
      const s = spd[k]
      const d = dir[k]
      // GeoMet's nodata is a huge sentinel; a lake cell inside the domain is
      // never that, and never negative
      if (!Number.isFinite(s) || s < 0 || s > 200 || !Number.isFinite(d) || d < 0 || d > 360) continue
      cells[k].windKn[i] = Math.round(s * MS_TO_KN * 10) / 10
      cells[k].windDir[i] = Math.round(d) % 360
    }
  }
  if (got === 0) return null // GeoMet answered the catalogue but no data — a fetch failure, not a run
  return {
    model: MODEL,
    run,
    generated: new Date().toISOString(),
    bbox: { ...REGION_BBOX },
    cols: GRID_SHAPE.cols,
    rows: GRID_SHAPE.rows,
    time: hours.map(hourLabel),
    cells,
    complete: got === hours.length,
  }
}

let refreshing: Promise<void> | null = null

// The ~100 fetches take seconds, and nothing waits on them: the strip
// paints Open-Meteo's copy of the same model and the grid lands on its own
// clock. Whoever holds a forecast re-dresses it when this fires — the
// weather layer for the grid, the strip for its point forecast.
const landListeners = new Set<() => void>()

/** Run `cb` whenever a (re)fetched or cache-loaded overlay is in hand. */
export function onWindOverlay(cb: () => void): () => void {
  landListeners.add(cb)
  return () => landListeners.delete(cb)
}

function landed() {
  for (const cb of landListeners) cb()
}

/**
 * Check GeoMet for a newer run and fetch it when there is one (or when the
 * copy in hand has holes); falls back to the cached copy when GeoMet is
 * unreachable. Shared across callers — the weather clock, the grid refresh
 * and the point-forecast paths all land on one in-flight check.
 */
export function refreshWindOverlay(): Promise<void> {
  refreshing ??= (async () => {
    fetchedAt = Date.now()
    try {
      const latest = await discoverRun()
      if (latest) {
        const have = overlay
        if (have && have.run === latest.run && have.complete && usable(have)) return // nothing new
        const fresh = await fetchRun(latest.run, latest.startMs, latest.endMs)
        if (fresh) {
          overlay = fresh
          landed()
          if (usable(fresh)) {
            try {
              await db.forecasts.put({ key: CACHE_KEY, fetchedAt: Date.now(), payload: fresh })
            } catch {
              /* cache is best-effort */
            }
          }
          return
        }
      }
    } catch {
      /* fall through to the cache */
    }
    if (!overlay) {
      try {
        const row = await db.forecasts.get(CACHE_KEY)
        if (row) {
          overlay = row.payload as WindOverlay
          landed()
        }
      } catch {
        /* stay on Open-Meteo */
      }
    }
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** Fetch the overlay once, ever — the lazy door for the point-forecast
 *  paths, which can run before the weather layer's first refresh. */
let ensured: Promise<void> | null = null
export function ensureWindOverlay(): Promise<void> {
  ensured ??= refreshWindOverlay()
  return ensured
}

// ---------- applying it ----------

/**
 * Bilinear sample of the overlay at a point for one hour index — the same
 * corner-weighted, null-aware, vector-averaged-direction arithmetic the
 * grid's own sampler uses, so a strip cell and the map never disagree.
 */
function sampleOverlay(
  o: WindOverlay,
  i: number,
  lon: number,
  lat: number,
): { kn: number; dir: number | null } | null {
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
  let kn = 0
  let kw = 0
  let u = 0
  let v = 0
  let dw = 0
  for (const [k, w] of corners) {
    if (!w) continue
    const c = o.cells[k]
    const ck = c.windKn[i]
    if (ck == null) continue
    kn += ck * w
    kw += w
    const cd = c.windDir[i]
    if (cd != null) {
      const r = (cd * Math.PI) / 180
      u += Math.sin(r) * w
      v += Math.cos(r) * w
      dw += w
    }
  }
  if (kw <= 0) return null
  return {
    kn: kn / kw,
    dir: dw > 0 ? ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 : null,
  }
}

/**
 * Overwrite a point forecast's wind series in place for the hours the
 * overlay covers. `t0Ms` is the epoch of the series' first hour (the caller
 * knows its own time format); hours are assumed contiguous. The gust is
 * raised to the overlaid wind where it would otherwise sit below it.
 */
export function applyWindOverlayToSeries(
  lon: number,
  lat: number,
  t0Ms: number,
  n: number,
  windKn: number[],
  gustKn: number[],
  windDir: number[],
): void {
  const o = overlay
  if (!usable(o)) return
  const o0 = Date.parse(`${o.time[0]}Z`)
  const shift = Math.round((o0 - t0Ms) / 3600_000)
  for (let i = 0; i < o.time.length; i++) {
    const gi = i + shift
    if (gi < 0 || gi >= n) continue
    const s = sampleOverlay(o, i, lon, lat)
    if (!s) continue // no data this hour: Open-Meteo's word stands
    windKn[gi] = Math.round(s.kn * 10) / 10
    if (s.dir != null) windDir[gi] = Math.round(s.dir)
    if (gustKn[gi] < windKn[gi]) gustKn[gi] = windKn[gi]
  }
}

/**
 * Overwrite `grid`'s wind fields with the overlay's, hour by hour, in place.
 * Idempotent and cheap — safe to run after every grid land or overlay
 * refresh. Returns true when anything was upgraded.
 */
export function applyWindOverlay(grid: GridForecast): boolean {
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
      const kn = oc.windKn[i]
      if (kn == null) continue
      gc.windKn[gi] = kn
      const dir = oc.windDir[i]
      if (dir != null) gc.windDir[gi] = dir
      if (gc.gustKn[gi] < kn) gc.gustKn[gi] = kn
      touched = true
    }
  }
  return touched
}
