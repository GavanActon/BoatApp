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

// ---------- grid forecast (48 h, for the map layer) ----------

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
      `&wind_speed_unit=kn&forecast_days=3&timezone=UTC`
    const marineUrl =
      `${MARINE_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wave_height&forecast_days=3&timezone=UTC`

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

/** Index into grid.time closest to now + hourOffset. */
export function timeIndexFor(grid: GridForecast, hourOffset: number): number {
  const target = Date.now() + hourOffset * 3600_000
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < grid.time.length; i++) {
    const t = Date.parse(`${grid.time[i]}Z`)
    const diff = Math.abs(t - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}
