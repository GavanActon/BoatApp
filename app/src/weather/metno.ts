import { fetchTimeout, type PointForecast } from './openMeteo'

/**
 * MET Norway Locationforecast — the point forecast's second source.
 *
 * Keyless, CORS-open, one request per point: air temperature, wind, cloud
 * cover, a sky symbol and the hour's precipitation, hourly for ~2½ days
 * and then every six hours out to nine. Used ONLY when Open-Meteo's point
 * call fails (today's kind of outage), for the strip and the Weather
 * panel — never for the 81-cell grid, which would be a bulk fetch their
 * terms ask us not to make. Everything it lacks is left honest: no gust
 * field (the gust is set to the wind, and HRDPS's real gusts overwrite the
 * first 48 h), no rain chance, no waves (RDWPS overwrites the first 48 h).
 *
 * The six-hourly tail is interpolated onto the app's hourly axis: instant
 * values linearly (direction as a vector), the six-hour symbol and rain
 * spread across its hours.
 */

const BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/complete'
const MS_TO_KN = 1.943844
const DAYS = 7

interface Period {
  summary?: { symbol_code?: string }
  details?: { precipitation_amount?: number }
}
interface Entry {
  time: string
  data: {
    instant: { details: Record<string, number | undefined> }
    next_1_hours?: Period
    next_6_hours?: Period
  }
}

/** WMO-style code (the app's sky vocabulary) from a met.no symbol. */
export function codeFromSymbol(sym: string | undefined): number | null {
  if (!sym) return null
  const s = sym.replace(/_(day|night|polartwilight)$/, '')
  if (s.includes('thunder')) return 95
  const map: Record<string, number> = {
    clearsky: 0,
    fair: 1,
    partlycloudy: 2,
    cloudy: 3,
    fog: 45,
    lightrain: 61,
    rain: 63,
    heavyrain: 65,
    lightrainshowers: 80,
    rainshowers: 81,
    heavyrainshowers: 82,
    lightsleet: 66,
    sleet: 67,
    heavysleet: 67,
    lightsleetshowers: 80,
    sleetshowers: 81,
    heavysleetshowers: 82,
    lightsnow: 71,
    snow: 73,
    heavysnow: 75,
    lightsnowshowers: 85,
    snowshowers: 85,
    heavysnowshowers: 86,
  }
  return map[s] ?? 3
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** "2026-09-03T14:00" in LOCAL time — the same shape as Open-Meteo's
 *  timezone=auto strings, which the point-forecast readers parse as local. */
function localLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}

export async function fetchMetNoPoint(lon: number, lat: number): Promise<PointForecast> {
  const resp = await fetch(`${BASE}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, {
    signal: fetchTimeout(),
  })
  if (!resp.ok) throw new Error(`met.no ${resp.status}`)
  const j = (await resp.json()) as { properties?: { timeseries?: Entry[] } }
  const ts = j.properties?.timeseries ?? []
  if (ts.length < 2) throw new Error('met.no: empty timeseries')
  const times = ts.map((e) => Date.parse(e.time))

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const n = DAYS * 24
  const time: string[] = new Array(n)
  const windKn: number[] = new Array(n)
  const gustKn: number[] = new Array(n)
  const windDir: number[] = new Array(n)
  const tempC: number[] = new Array(n)
  const weatherCode: number[] = new Array(n)
  const precipProbPct: (number | null)[] = new Array(n).fill(null)
  const nulls = (): (number | null)[] => new Array<number | null>(n).fill(null)

  let j0 = 0 // index of the last entry at or before the hour (times ascend)
  for (let h = 0; h < n; h++) {
    const ms = start.getTime() + h * 3600_000
    time[h] = localLabel(ms)
    while (j0 + 1 < times.length && times[j0 + 1] <= ms) j0++
    const a = ts[j0]
    const b = ts[Math.min(j0 + 1, ts.length - 1)]
    const ta = times[j0]
    const tb = times[Math.min(j0 + 1, ts.length - 1)]
    // before the first entry or past the last: hold the nearest value
    const f = ms <= ta || tb === ta ? 0 : ms >= tb ? 1 : (ms - ta) / (tb - ta)
    const da = a.data.instant.details
    const dbb = b.data.instant.details
    const lerp = (x?: number, y?: number) => (x == null ? (y ?? NaN) : y == null ? x : x + (y - x) * f)
    const ws = lerp(da.wind_speed, dbb.wind_speed)
    const kn = Number.isFinite(ws) ? Math.round(ws * MS_TO_KN * 10) / 10 : 0
    windKn[h] = kn
    gustKn[h] = kn // no gust field — never claim more than the wind
    // direction: vector-interpolated so 350°→10° doesn't pass through 180°
    const ra = ((da.wind_from_direction ?? 0) * Math.PI) / 180
    const rb = ((dbb.wind_from_direction ?? da.wind_from_direction ?? 0) * Math.PI) / 180
    const u = Math.sin(ra) * (1 - f) + Math.sin(rb) * f
    const v = Math.cos(ra) * (1 - f) + Math.cos(rb) * f
    windDir[h] = Math.round(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360)
    const t = lerp(da.air_temperature, dbb.air_temperature)
    tempC[h] = Number.isFinite(t) ? Math.round(t * 10) / 10 : NaN
    // the sky and the rain come from the period that CONTAINS the hour: the
    // hourly period when there is one, else the six-hour period from `a`
    const period = ms === ta ? (a.data.next_1_hours ?? a.data.next_6_hours) : a.data.next_6_hours
    weatherCode[h] = codeFromSymbol(period?.summary?.symbol_code) ?? 3
  }

  return {
    lon,
    lat,
    fetchedAt: Date.now(),
    source: 'met.no',
    hourly: {
      time,
      windKn,
      gustKn,
      windDir,
      tempC,
      weatherCode,
      precipProbPct,
      waveM: nulls(),
      wavePeriodS: nulls(),
      waveDir: nulls(),
    },
  }
}
