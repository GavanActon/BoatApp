import { REGION_BBOX } from '../config'
import { db } from '../tracking/db'

/**
 * Open-Meteo client. Free, no API key, CORS-enabled.
 * Wind:  api.open-meteo.com/v1/forecast   (works everywhere)
 * Waves: marine-api.open-meteo.com/v1/marine (verified working on Lake Superior)
 *
 * Every successful fetch is cached in IndexedDB so the last forecast remains
 * viewable offline, with its age shown in the UI.
 */

export interface PointForecast {
  lon: number
  lat: number
  fetchedAt: number
  hourly: {
    time: string[]
    windKn: number[]
    gustKn: number[]
    windDir: number[]
    tempC: number[]
    weatherCode: number[]
    waveM: (number | null)[]
    wavePeriodS: (number | null)[]
    waveDir: (number | null)[]
  }
}

export interface GridCell {
  lon: number
  lat: number
  windKn: number[]
  gustKn: number[]
  windDir: number[]
  waveM: (number | null)[]
}

export interface GridForecast {
  fetchedAt: number
  time: string[]
  cells: GridCell[]
}

/** One hour of a point forecast, unpacked for display. */
export interface HourRow {
  time: Date
  windKn: number
  gustKn: number
  windDir: number
  tempC: number
  weatherCode: number
  waveM: number | null
  wavePeriodS: number | null
}

/** The next `n` hours starting at the top of the current hour. */
export function nextHours(f: PointForecast, n: number): HourRow[] {
  const h = f.hourly
  const floorNow = new Date()
  floorNow.setMinutes(0, 0, 0)
  let start = h.time.findIndex((t) => Date.parse(t) >= floorNow.getTime())
  if (start < 0) start = Math.max(0, h.time.length - n)
  return Array.from({ length: Math.min(n, h.time.length - start) }, (_, k) => {
    const i = start + k
    return {
      time: new Date(h.time[i]),
      windKn: h.windKn[i],
      gustKn: h.gustKn[i],
      windDir: h.windDir[i],
      tempC: h.tempC[i],
      weatherCode: h.weatherCode[i],
      waveM: h.waveM[i] ?? null,
      wavePeriodS: h.wavePeriodS[i] ?? null,
    }
  })
}

export type Condition = 'good' | 'mod' | 'rough'

/** Small-boat comfort rating for one hour (drives good/bad coloring). */
export function conditionFor(windKn: number, gustKn: number, waveM: number | null): Condition {
  if (windKn >= 18 || gustKn >= 25 || (waveM ?? 0) >= 1) return 'rough'
  if (windKn >= 12 || gustKn >= 18 || (waveM ?? 0) >= 0.5) return 'mod'
  return 'good'
}

/** Hour rows within one local calendar day, `fromH`..`toH` inclusive. */
export function dayHours(f: PointForecast, dayStartMs: number, fromH = 7, toH = 18): HourRow[] {
  const h = f.hourly
  const from = dayStartMs + fromH * 3600_000
  const to = dayStartMs + toH * 3600_000
  const rows: HourRow[] = []
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i])
    if (t < from || t > to) continue
    rows.push({
      time: new Date(t),
      windKn: h.windKn[i],
      gustKn: h.gustKn[i],
      windDir: h.windDir[i],
      tempC: h.tempC[i],
      weatherCode: h.weatherCode[i],
      waveM: h.waveM[i] ?? null,
      wavePeriodS: h.wavePeriodS[i] ?? null,
    })
  }
  return rows
}

export interface DayOutlook {
  dayStartMs: number
  cond: Condition | null // null = beyond the forecast (or the day is over)
}

const OUTLOOK_FROM_H = 7
const OUTLOOK_TO_H = 19
const MIN_WINDOW_H = 3 // shortest stretch that counts as a usable boating window

/**
 * Rates each of the next `days` calendar days for boatability: the longest
 * decent stretch during daytime hours decides the color. A day with a calm
 * morning and a rough afternoon is still a boating day.
 */
export function dailyOutlook(f: PointForecast, days = 7): DayOutlook[] {
  const h = f.hourly
  const now = Date.now()
  const t0 = new Date()
  const out: DayOutlook[] = []
  for (let d = 0; d < days; d++) {
    const dayStartMs = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + d).getTime()
    const from = dayStartMs + OUTLOOK_FROM_H * 3600_000
    const to = dayStartMs + OUTLOOK_TO_H * 3600_000
    let runGood = 0
    let runOk = 0
    let bestGood = 0
    let bestOk = 0
    let any = false
    for (let i = 0; i < h.time.length; i++) {
      const t = Date.parse(h.time[i])
      if (t < from || t > to || t < now - 3600_000) continue
      any = true
      const c =
        (h.weatherCode[i] ?? 0) >= 95
          ? 'rough'
          : conditionFor(h.windKn[i], h.gustKn[i], h.waveM[i] ?? null)
      runGood = c === 'good' ? runGood + 1 : 0
      runOk = c !== 'rough' ? runOk + 1 : 0
      bestGood = Math.max(bestGood, runGood)
      bestOk = Math.max(bestOk, runOk)
    }
    out.push({
      dayStartMs,
      cond: !any ? null : bestGood >= MIN_WINDOW_H ? 'good' : bestOk >= MIN_WINDOW_H ? 'mod' : 'rough',
    })
  }
  return out
}

const WIND_BASE = 'https://api.open-meteo.com/v1/forecast'
const MARINE_BASE = 'https://marine-api.open-meteo.com/v1/marine'

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`)
  return resp.json()
}

async function cachePut(key: string, payload: unknown) {
  try {
    await db.forecasts.put({ key, fetchedAt: Date.now(), payload })
  } catch {
    /* cache is best-effort */
  }
}

async function cacheGet<T>(key: string): Promise<{ fetchedAt: number; payload: T } | null> {
  try {
    const row = await db.forecasts.get(key)
    return row ? { fetchedAt: row.fetchedAt, payload: row.payload as T } : null
  } catch {
    return null
  }
}

// ---------- point forecast (7 days, for the forecast panel) ----------

function pointKey(lon: number, lat: number): string {
  return `point:${lon.toFixed(2)},${lat.toFixed(2)}`
}

export async function fetchPointForecast(
  lon: number,
  lat: number,
): Promise<{ forecast: PointForecast; stale: boolean }> {
  const key = pointKey(lon, lat)
  try {
    const windUrl =
      `${WIND_BASE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,weather_code` +
      `&wind_speed_unit=kn&forecast_days=7&timezone=auto`
    const marineUrl =
      `${MARINE_BASE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&hourly=wave_height,wave_period,wave_direction&forecast_days=7&timezone=auto`

    const [wind, marine] = (await Promise.all([getJson(windUrl), getJson(marineUrl)])) as [
      Record<string, { time: string[]; [k: string]: unknown }>,
      Record<string, { time: string[]; [k: string]: unknown }>,
    ]
    const wh = wind.hourly as unknown as Record<string, number[]> & { time: string[] }
    const mh = marine.hourly as unknown as Record<string, (number | null)[]> & { time: string[] }

    const forecast: PointForecast = {
      lon,
      lat,
      fetchedAt: Date.now(),
      hourly: {
        time: wh.time,
        windKn: wh.wind_speed_10m,
        gustKn: wh.wind_gusts_10m,
        windDir: wh.wind_direction_10m,
        tempC: wh.temperature_2m,
        weatherCode: wh.weather_code,
        waveM: mh.wave_height ?? [],
        wavePeriodS: mh.wave_period ?? [],
        waveDir: mh.wave_direction ?? [],
      },
    }
    await cachePut(key, forecast)
    return { forecast, stale: false }
  } catch (e) {
    const cached = await cacheGet<PointForecast>(key)
    if (cached) return { forecast: cached.payload, stale: true }
    throw e
  }
}

// ---------- grid forecast (7 days, for the map layer) ----------

const GRID_COLS = 8
const GRID_ROWS = 7
const GRID_KEY = 'grid:superior-east:v1'

function gridPoints(): { lats: number[]; lons: number[] } {
  const { west, south, east, north } = REGION_BBOX
  const lats: number[] = []
  const lons: number[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      lats.push(south + ((r + 0.5) / GRID_ROWS) * (north - south))
      lons.push(west + ((c + 0.5) / GRID_COLS) * (east - west))
    }
  }
  return { lats, lons }
}

export async function fetchGridForecast(): Promise<{ grid: GridForecast; stale: boolean }> {
  try {
    const { lats, lons } = gridPoints()
    const latStr = lats.map((v) => v.toFixed(3)).join(',')
    const lonStr = lons.map((v) => v.toFixed(3)).join(',')

    const windUrl =
      `${WIND_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
      `&wind_speed_unit=kn&forecast_days=7&timezone=UTC`
    const marineUrl =
      `${MARINE_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wave_height&forecast_days=7&timezone=UTC`

    const [windRaw, marineRaw] = await Promise.all([getJson(windUrl), getJson(marineUrl)])
    const windArr = (Array.isArray(windRaw) ? windRaw : [windRaw]) as Array<{
      latitude: number
      longitude: number
      hourly: { time: string[]; wind_speed_10m: number[]; wind_gusts_10m: number[]; wind_direction_10m: number[] }
    }>
    const marineArr = (Array.isArray(marineRaw) ? marineRaw : [marineRaw]) as Array<{
      hourly?: { wave_height: (number | null)[] }
    }>

    const cells: GridCell[] = windArr.map((w, i) => ({
      lon: lons[i],
      lat: lats[i],
      windKn: w.hourly.wind_speed_10m,
      gustKn: w.hourly.wind_gusts_10m,
      windDir: w.hourly.wind_direction_10m,
      waveM: marineArr[i]?.hourly?.wave_height ?? [],
    }))

    const grid: GridForecast = {
      fetchedAt: Date.now(),
      time: windArr[0]?.hourly.time ?? [],
      cells,
    }
    await cachePut(GRID_KEY, grid)
    return { grid, stale: false }
  } catch (e) {
    const cached = await cacheGet<GridForecast>(GRID_KEY)
    if (cached) return { grid: cached.payload, stale: true }
    throw e
  }
}

// ---------- route forecast (7 days at sample points along a planned route) ----------

export interface RoutePointWx {
  lon: number
  lat: number
  time: string[] // UTC, no Z suffix (Open-Meteo timezone=UTC format)
  windKn: number[]
  gustKn: number[]
  windDir: number[]
  weatherCode: number[]
  waveM: (number | null)[]
}

export interface RouteForecast {
  fetchedAt: number
  points: RoutePointWx[]
}

export async function fetchRouteForecast(
  pts: [number, number][],
  cacheKey: string,
  maxAgeMs = 0, // reuse the cached forecast if younger than this (0 = always refetch)
): Promise<{ forecast: RouteForecast; stale: boolean }> {
  const key = `route:${cacheKey}`
  if (maxAgeMs > 0) {
    const cached = await cacheGet<RouteForecast>(key)
    if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
      return { forecast: cached.payload, stale: false }
    }
  }
  try {
    const latStr = pts.map((p) => p[1].toFixed(3)).join(',')
    const lonStr = pts.map((p) => p[0].toFixed(3)).join(',')
    const windUrl =
      `${WIND_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code` +
      `&wind_speed_unit=kn&forecast_days=7&timezone=UTC`
    const marineUrl =
      `${MARINE_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wave_height&forecast_days=7&timezone=UTC`

    const [windRaw, marineRaw] = await Promise.all([getJson(windUrl), getJson(marineUrl)])
    const windArr = (Array.isArray(windRaw) ? windRaw : [windRaw]) as Array<{
      hourly: {
        time: string[]
        wind_speed_10m: number[]
        wind_gusts_10m: number[]
        wind_direction_10m: number[]
        weather_code: number[]
      }
    }>
    const marineArr = (Array.isArray(marineRaw) ? marineRaw : [marineRaw]) as Array<{
      hourly?: { wave_height: (number | null)[] }
    }>

    const forecast: RouteForecast = {
      fetchedAt: Date.now(),
      points: windArr.map((w, i) => ({
        lon: pts[i][0],
        lat: pts[i][1],
        time: w.hourly.time,
        windKn: w.hourly.wind_speed_10m,
        gustKn: w.hourly.wind_gusts_10m,
        windDir: w.hourly.wind_direction_10m,
        weatherCode: w.hourly.weather_code,
        waveM: marineArr[i]?.hourly?.wave_height ?? [],
      })),
    }
    await cachePut(key, forecast)
    return { forecast, stale: false }
  } catch (e) {
    const cached = await cacheGet<RouteForecast>(key)
    if (cached) return { forecast: cached.payload, stale: true }
    throw e
  }
}

/** Index of the hour in a UTC time array closest to a timestamp.
 *  Open-Meteo hourly arrays are contiguous, so this is pure arithmetic
 *  (clamped at the ends) — it runs thousands of times in the trip sweep. */
export function hourIndexAt(time: string[], ms: number): number {
  const t0 = Date.parse(`${time[0]}Z`)
  const i = Math.round((ms - t0) / 3600_000)
  return Math.min(time.length - 1, Math.max(0, i))
}
