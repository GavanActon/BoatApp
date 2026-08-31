import { REGION_BBOX } from '../config'
import { db } from '../tracking/db'
import { applyWaveOverlayToSeries, ensureWaveOverlay } from './rdwps'

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
    /** Chance of precipitation, 0–100. Optional so a forecast cached before
     *  this field was requested still loads. */
    precipProbPct?: (number | null)[]
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
  wavePeriodS: (number | null)[]
  /** Optional so a grid cached before rain chance was fetched still loads. */
  precipProbPct?: (number | null)[]
  /** Optional: a grid cached before the field was fetched has none. */
  waterTempC?: (number | null)[]
  weatherCode?: (number | null)[]
  waveDir?: (number | null)[]
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
  precipProbPct: number | null
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
      // optional-chained: a forecast cached before rain chance was fetched
      // has no array
      precipProbPct: h.precipProbPct?.[i] ?? null,
      waveM: h.waveM[i] ?? null,
      wavePeriodS: h.wavePeriodS[i] ?? null,
    }
  })
}

/**
 * Wave period, rounded, for display beside a height. Period is what separates a
 * 0.8 m long swell you barely feel from a 0.8 m 3-second chop that stops the
 * boat — deep-water wavelength is ~1.56·T², so short periods mean steep seas.
 * Returns null when the wave model has no data for the point.
 */
export function formatPeriod(s: number | null | undefined): string | null {
  return s == null ? null : `${Math.round(s)}s`
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
      // optional-chained: a forecast cached before rain chance was fetched
      // has no array
      precipProbPct: h.precipProbPct?.[i] ?? null,
      waveM: h.waveM[i] ?? null,
      wavePeriodS: h.wavePeriodS[i] ?? null,
    })
  }
  return rows
}

export interface DayOutlook {
  dayStartMs: number
  cond: Condition | null // null = beyond the forecast (or the day is over)
  tempMinC: number | null // daytime low (remaining hours for today)
  tempMaxC: number | null // daytime high (remaining hours for today)
  weatherCode: number | null // most severe daytime code, like Open-Meteo's daily summary
  windMinKn: number | null
  windMaxKn: number | null
  gustMaxKn: number | null
  windDir: number | null // speed-weighted mean direction the wind blows FROM
  waveMaxM: number | null
  /** Highest chance of precipitation across the day's daytime hours. Null
   *  when the cached forecast predates the field. */
  precipMaxPct: number | null
  /** Any daytime hour calls thunder (weather code 95+). The one thing the
   *  interface is allowed to be loud about — see §0.6. */
  thunder: boolean
  /** The stretch that earned the day its rating, half-open [fromMs, toMs) —
   *  the answer to "when do we go". Null on a day with no usable stretch. */
  window: { fromMs: number; toMs: number } | null
}

/** Human name for an Open-Meteo weather code. */
export function skyLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mostly clear'
  if (code === 2) return 'Part cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code === 85 || code === 86) return 'Snow shwrs'
  if (code >= 95) return 'Thunder'
  return '—'
}

export const OUTLOOK_FROM_H = 7
export const OUTLOOK_TO_H = 19
const MIN_WINDOW_H = 3 // shortest stretch that counts as a usable boating window

interface RatedHour {
  ms: number
  cond: Condition
}

/** Longest run of hours passing `ok`, as a half-open [fromMs, toMs) span — an
 *  hour's conditions hold right through to the next one, so a run ending on
 *  the 12:00 hour is usable until 13:00. */
function longestRun(
  hours: RatedHour[],
  ok: (c: Condition) => boolean,
): { len: number; fromMs: number; toMs: number } {
  let best = { len: 0, fromMs: 0, toMs: 0 }
  let len = 0
  for (let i = 0; i <= hours.length; i++) {
    if (i < hours.length && ok(hours[i].cond)) {
      len++
      continue
    }
    if (len > best.len) {
      best = { len, fromMs: hours[i - len].ms, toMs: hours[i - 1].ms + 3600_000 }
    }
    len = 0
  }
  return best
}

/**
 * Rates each of the next `days` calendar days for boatability: the longest
 * decent stretch during daytime hours decides the color. A day with a calm
 * morning and a rough afternoon is still a boating day.
 *
 * The roll-up beside the rating (temperature, sky, wind range and direction,
 * biggest wave, and the window itself) covers the same daytime hours, so the
 * numbers a day chip or an outlook row shows are the ones that earned it its
 * color — never an overnight low or a 3 am gale nobody was going to boat in.
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
    const hours: RatedHour[] = []
    let tempMin: number | null = null
    let tempMax: number | null = null
    let wxMax: number | null = null
    let windMin: number | null = null
    let windMax: number | null = null
    let gustMax: number | null = null
    let waveMax: number | null = null
    let precipMax: number | null = null
    let thunder = false
    // direction is averaged as a vector weighted by speed, so a calm hour
    // swinging through north can't drag the day's arrow off the real wind
    let dirX = 0
    let dirY = 0
    for (let i = 0; i < h.time.length; i++) {
      const t = Date.parse(h.time[i])
      if (t < from || t > to || t < now - 3600_000) continue
      const tc = h.tempC[i]
      if (tc != null) {
        tempMin = tempMin == null ? tc : Math.min(tempMin, tc)
        tempMax = tempMax == null ? tc : Math.max(tempMax, tc)
      }
      const wc = h.weatherCode[i]
      if (wc != null) wxMax = wxMax == null ? wc : Math.max(wxMax, wc)
      if (wc != null && wc >= 95) thunder = true
      // optional-chained: a forecast cached before rain chance was fetched
      // has no array
      const pp = h.precipProbPct?.[i]
      if (pp != null) precipMax = precipMax == null ? pp : Math.max(precipMax, pp)
      const wk = h.windKn[i]
      if (wk != null) {
        windMin = windMin == null ? wk : Math.min(windMin, wk)
        windMax = windMax == null ? wk : Math.max(windMax, wk)
        const rad = ((h.windDir[i] ?? 0) * Math.PI) / 180
        dirX += Math.sin(rad) * wk
        dirY += Math.cos(rad) * wk
      }
      const gk = h.gustKn[i]
      if (gk != null) gustMax = gustMax == null ? gk : Math.max(gustMax, gk)
      const wv = h.waveM[i] ?? null
      if (wv != null) waveMax = waveMax == null ? wv : Math.max(waveMax, wv)
      hours.push({
        ms: t,
        cond: (h.weatherCode[i] ?? 0) >= 95 ? 'rough' : conditionFor(h.windKn[i], h.gustKn[i], wv),
      })
    }

    const good = longestRun(hours, (c) => c === 'good')
    const ok = longestRun(hours, (c) => c !== 'rough')
    const cond: Condition | null = !hours.length
      ? null
      : good.len >= MIN_WINDOW_H
        ? 'good'
        : ok.len >= MIN_WINDOW_H
          ? 'mod'
          : 'rough'
    const win = cond === 'good' ? good : cond === 'mod' ? ok : null

    out.push({
      dayStartMs,
      cond,
      tempMinC: tempMin,
      tempMaxC: tempMax,
      weatherCode: wxMax,
      windMinKn: windMin,
      windMaxKn: windMax,
      gustMaxKn: gustMax,
      windDir: windMax == null ? null : ((Math.atan2(dirX, dirY) * 180) / Math.PI + 360) % 360,
      waveMaxM: waveMax,
      precipMaxPct: precipMax,
      thunder,
      window: win && { fromMs: win.fromMs, toMs: win.toMs },
    })
  }
  return out
}

// In dev, requests go through the vite server's disk cache (see omCache in
// vite.config.ts) so repeated reloads and browser-driven tests don't hammer
// Open-Meteo — the API rate-limits bursts. Production talks to it directly.
const DEV = import.meta.env.DEV
const WIND_BASE = DEV
  ? '/__om/api.open-meteo.com/v1/forecast'
  : 'https://api.open-meteo.com/v1/forecast'
const MARINE_BASE = DEV
  ? '/__om/marine-api.open-meteo.com/v1/marine'
  : 'https://marine-api.open-meteo.com/v1/marine'

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

/**
 * Two models in one call, blended per FIELD.
 *
 * Wind and direction come from HRDPS (gem_seamless: ECCC's 2.5 km model —
 * the same physics family that forces the RDWPS waves, and the hyper-local
 * signal a lake with headlands actually has). Gusts stay with best_match:
 * HRDPS gusts through this API are degenerate — gust/wind ratio 1.00 across
 * every hour checked, the sustained wind echoed back — and the comfort
 * ratings live on gusts. Temperature, sky and rain chance also stay with
 * best_match. The gust is clamped to at least the HRDPS wind so the blend
 * can never claim gusts below the sustained breeze.
 */
const WIND_MODELS = '&models=best_match,gem_seamless'

type ModelHourly = Record<string, (number | null)[] | undefined> & { time: string[] }

function blendWind(h: ModelHourly): {
  windKn: number[]
  gustKn: number[]
  windDir: number[]
} {
  const n = h.time.length
  const gemW = h.wind_speed_10m_gem_seamless ?? []
  const bmW = h.wind_speed_10m_best_match ?? h.wind_speed_10m ?? []
  const gemD = h.wind_direction_10m_gem_seamless ?? []
  const bmD = h.wind_direction_10m_best_match ?? h.wind_direction_10m ?? []
  const bmG = h.wind_gusts_10m_best_match ?? h.wind_gusts_10m ?? []
  const windKn: number[] = new Array(n)
  const gustKn: number[] = new Array(n)
  const windDir: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const w = gemW[i] ?? bmW[i] ?? 0
    windKn[i] = w
    windDir[i] = gemD[i] ?? bmD[i] ?? 0
    gustKn[i] = Math.max(bmG[i] ?? w, w)
  }
  return { windKn, gustKn, windDir }
}

/** A best_match field under the two-model call, tolerant of the unsuffixed
 *  name so an old cached response still parses. */
function bm(h: ModelHourly, key: string): (number | null)[] {
  return h[`${key}_best_match`] ?? h[key] ?? []
}

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
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,weather_code,precipitation_probability` +
      `&wind_speed_unit=kn&forecast_days=7&timezone=auto${WIND_MODELS}`
    const marineUrl =
      `${MARINE_BASE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&hourly=wave_height,wave_period,wave_direction&forecast_days=7&timezone=auto`

    const [wind, marine] = (await Promise.all([getJson(windUrl), getJson(marineUrl)])) as [
      Record<string, { time: string[]; [k: string]: unknown }>,
      Record<string, { time: string[]; [k: string]: unknown }>,
    ]
    const wh = wind.hourly as unknown as ModelHourly
    const mh = marine.hourly as unknown as Record<string, (number | null)[]> & { time: string[] }

    const blended = blendWind(wh)
    const forecast: PointForecast = {
      lon,
      lat,
      fetchedAt: Date.now(),
      hourly: {
        time: wh.time,
        windKn: blended.windKn,
        gustKn: blended.gustKn,
        windDir: blended.windDir,
        tempC: bm(wh, 'temperature_2m') as number[],
        weatherCode: bm(wh, 'weather_code') as number[],
        precipProbPct: bm(wh, 'precipitation_probability'),
        waveM: mh.wave_height ?? [],
        wavePeriodS: mh.wave_period ?? [],
        waveDir: mh.wave_direction ?? [],
      },
    }
    // upgrade the wave series to RDWPS 1 km where its run covers — the strip
    // and the map must never quote two different seas for the same hour
    await ensureWaveOverlay()
    const h = forecast.hourly
    applyWaveOverlayToSeries(
      lon,
      lat,
      Date.parse(h.time[0]), // timezone=auto strings parse as local time
      h.time.length,
      h.waveM,
      h.wavePeriodS,
      h.waveDir,
    )
    await cachePut(key, forecast)
    return { forecast, stale: false }
  } catch (e) {
    const cached = await cacheGet<PointForecast>(key)
    if (cached) return { forecast: cached.payload, stale: true }
    throw e
  }
}

// ---------- grid forecast (7 days, for the map layer) ----------

/** Shape of the regional grid, so the map layer can read it as a lattice
 *  and interpolate between cells. */
export const GRID_SHAPE = { cols: 8, rows: 7 }

const GRID_COLS = GRID_SHAPE.cols
const GRID_ROWS = GRID_SHAPE.rows
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
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability,weather_code` +
      `&wind_speed_unit=kn&forecast_days=7&timezone=UTC${WIND_MODELS}`
    const marineUrl =
      `${MARINE_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wave_height,wave_period,wave_direction,sea_surface_temperature&forecast_days=7&timezone=UTC`

    const [windRaw, marineRaw] = await Promise.all([getJson(windUrl), getJson(marineUrl)])
    const windArr = (Array.isArray(windRaw) ? windRaw : [windRaw]) as Array<{
      latitude: number
      longitude: number
      hourly: ModelHourly
    }>
    const marineArr = (Array.isArray(marineRaw) ? marineRaw : [marineRaw]) as Array<{
      hourly?: {
        wave_height: (number | null)[]
        wave_period: (number | null)[]
        wave_direction: (number | null)[]
        sea_surface_temperature?: (number | null)[]
      }
    }>

    const cells: GridCell[] = windArr.map((w, i) => {
      const blended = blendWind(w.hourly)
      return {
        lon: lons[i],
        lat: lats[i],
        windKn: blended.windKn,
        gustKn: blended.gustKn,
        windDir: blended.windDir,
        waveM: marineArr[i]?.hourly?.wave_height ?? [],
        wavePeriodS: marineArr[i]?.hourly?.wave_period ?? [],
        precipProbPct: bm(w.hourly, 'precipitation_probability'),
        weatherCode: bm(w.hourly, 'weather_code'),
        waveDir: marineArr[i]?.hourly?.wave_direction ?? [],
        waterTempC: marineArr[i]?.hourly?.sea_surface_temperature ?? [],
      }
    })

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
  wavePeriodS: (number | null)[]
  /** Where the sea is running FROM, degrees true. Optional so a forecast
   *  cached before this field was requested still loads. */
  waveDir?: (number | null)[]
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
      `&wind_speed_unit=kn&forecast_days=7&timezone=UTC${WIND_MODELS}`
    const marineUrl =
      `${MARINE_BASE}?latitude=${latStr}&longitude=${lonStr}` +
      `&hourly=wave_height,wave_period,wave_direction&forecast_days=7&timezone=UTC`

    const [windRaw, marineRaw] = await Promise.all([getJson(windUrl), getJson(marineUrl)])
    const windArr = (Array.isArray(windRaw) ? windRaw : [windRaw]) as Array<{
      hourly: ModelHourly
    }>
    const marineArr = (Array.isArray(marineRaw) ? marineRaw : [marineRaw]) as Array<{
      hourly?: {
        wave_height: (number | null)[]
        wave_period: (number | null)[]
        wave_direction: (number | null)[]
      }
    }>

    const forecast: RouteForecast = {
      fetchedAt: Date.now(),
      points: windArr.map((w, i) => ({
        lon: pts[i][0],
        lat: pts[i][1],
        time: w.hourly.time,
        ...blendWind(w.hourly),
        weatherCode: bm(w.hourly, 'weather_code') as number[],
        waveM: marineArr[i]?.hourly?.wave_height ?? [],
        wavePeriodS: marineArr[i]?.hourly?.wave_period ?? [],
        // where the sea is running FROM — a separate field from the wind's,
        // and on this lake often twenty or thirty degrees off it when the
        // wind has shifted and the old sea is still up
        waveDir: marineArr[i]?.hourly?.wave_direction ?? [],
      })),
    }
    // the trip sweep rates departures on these — RDWPS where it covers
    await ensureWaveOverlay()
    for (const p of forecast.points) {
      applyWaveOverlayToSeries(
        p.lon,
        p.lat,
        Date.parse(`${p.time[0]}Z`), // timezone=UTC strings need the Z back
        p.time.length,
        p.waveM,
        p.wavePeriodS,
        p.waveDir,
      )
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
