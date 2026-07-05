import { dayTimeLabel, timeLabel } from '../time'
import {
  conditionFor,
  fetchRouteForecast,
  hourIndexAt,
  type Condition,
  type RouteForecast,
} from '../weather/openMeteo'
import type { RouteResult } from './waterRouter'

/**
 * Turns a plotted route into a timed itinerary, attaches the forecast at the
 * place AND time the boat will actually be there, and boils it down to a
 * go / caution / no-go verdict plus a "weather turns bad at …" heads-up.
 *
 * The same evaluation, swept across every daytime departure hour of the next
 * week, produces per-day departure windows — "which day can we do this trip,
 * and when should we leave" — with zero extra network cost: one route
 * forecast covers all of it.
 */

export interface TripOptions {
  cruiseKn: number
  departMs: number
  roundTrip: boolean
  stayMin: number // planned time at destination before heading back
  destName: string | null
  /** Reuse a cached route forecast younger than this (progress updates while
   *  under way re-time the trip every couple of minutes without refetching). */
  maxWxCacheMs?: number
  /** Skip the 7-day departure-window sweep (meaningless once under way). */
  windows?: boolean
  /** Sweep constraints: shortest stay worth going for (defaults to stayMin)
   *  and the latest hour-of-day to be back / off the water (null = no limit). */
  minStayMin?: number
  backByHour?: number | null
}

export type TripPhase = 'depart' | 'outbound' | 'arrive' | 'return' | 'home'

export interface TripSample {
  lon: number
  lat: number
  atMs: number
  distNm: number // cumulative over the whole trip
  phase: TripPhase
  windKn: number
  gustKn: number
  windDir: number
  waveM: number | null
  weatherCode: number
  cond: Condition
}

export type Verdict = 'go' | 'caution' | 'nogo'

/** One concrete schedule the sweep found: leave then, get that long there,
 *  home by then. Represents a run of workable departures (windowStart..End). */
export interface TripOption {
  departMs: number
  homeMs: number // back home (round trip) or at the destination (one way)
  stayMin: number | null // maximized time at the destination; null = one way
  verdict: 'go' | 'caution'
  windowStartMs: number // departures anywhere in this range also work
  windowEndMs: number
}

export interface DayWindows {
  dayStartMs: number
  best: Verdict | null // null = the trip would run past the end of the forecast
  options: TripOption[]
}

export interface TripPlan {
  samples: TripSample[]
  destName: string | null // what the far end is called (flips to "Home" on the ride back)
  wx: RouteForecast // hourly forecast at the route's sample points (time-scrub preview)
  days: DayWindows[] // departure windows for the next 7 days (empty under way)
  oneWayNm: number
  totalNm: number
  departMs: number
  arriveMs: number
  homeMs: number | null
  verdict: Verdict
  headline: string
  turnsBadMs: number | null
  turnsBadText: string | null
  fetchedAt: number
  stale: boolean
}

const SAMPLE_SPACING_NM = 2.5
const MAX_SAMPLES_ONE_WAY = 6
const BAD_WX_HORIZON_H = 14 // how far ahead the "turns bad" scan looks

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compass(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16]
}

/** Point at cumulative distance `s` nm along the route polyline. */
function pointAt(coords: [number, number][], cum: number[], s: number): [number, number] {
  if (s <= 0) return coords[0]
  const total = cum[cum.length - 1]
  if (s >= total) return coords[coords.length - 1]
  let i = 1
  while (cum[i] < s) i++
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1])
  return [
    coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
    coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
  ]
}

function cumulativeNm(coords: [number, number][]): number[] {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    const [aLon, aLat] = coords[i - 1]
    const [bLon, bLat] = coords[i]
    const toRad = Math.PI / 180
    const dLat = (bLat - aLat) * toRad
    const dLon = (bLon - aLon) * toRad
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2
    cum.push(cum[i - 1] + 2 * 3440.065 * Math.asin(Math.sqrt(h)))
  }
  return cum
}

interface ItinerarySample {
  lon: number
  lat: number
  atMs: number
  distNm: number
  phase: TripPhase
}

type TripShape = Pick<TripOptions, 'cruiseKn' | 'roundTrip' | 'stayMin'>

function buildItinerary(
  route: RouteResult,
  o: TripShape,
  departMs: number,
  cumPre?: number[], // precomputed by the sweep, which builds thousands of these
): ItinerarySample[] {
  const cum = cumPre ?? cumulativeNm(route.coords)
  const oneWay = cum[cum.length - 1]
  const nPos = Math.min(MAX_SAMPLES_ONE_WAY, Math.max(2, Math.ceil(oneWay / SAMPLE_SPACING_NM) + 1))
  const msPerNm = 3600_000 / o.cruiseKn

  const out: ItinerarySample[] = []
  for (let i = 0; i < nPos; i++) {
    const s = (i / (nPos - 1)) * oneWay
    const [lon, lat] = pointAt(route.coords, cum, s)
    out.push({
      lon,
      lat,
      atMs: departMs + s * msPerNm,
      distNm: s,
      phase: i === 0 ? 'depart' : i === nPos - 1 ? 'arrive' : 'outbound',
    })
  }

  if (o.roundTrip) {
    const leaveMs = departMs + oneWay * msPerNm + o.stayMin * 60_000
    for (let i = nPos - 2; i >= 0; i--) {
      const s = (i / (nPos - 1)) * oneWay
      const [lon, lat] = pointAt(route.coords, cum, s)
      out.push({
        lon,
        lat,
        atMs: leaveMs + (oneWay - s) * msPerNm,
        distNm: oneWay + (oneWay - s),
        phase: i === 0 ? 'home' : 'return',
      })
    }
  }
  return out
}

function phaseText(phase: TripPhase, destName: string | null): string {
  const dest = destName ?? 'the destination'
  switch (phase) {
    case 'depart':
      return 'leaving'
    case 'outbound':
      return 'on the way out'
    case 'arrive':
      return `at ${dest}`
    case 'return':
      return 'on the way back'
    case 'home':
      return 'getting back'
  }
}

export function condRank(c: Condition): number {
  return c === 'rough' ? 2 : c === 'mod' ? 1 : 0
}

/** Index of the forecast point closest to a position. */
export function nearestPoint(f: RouteForecast, lon: number, lat: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < f.points.length; i++) {
    const d = (f.points[i].lon - lon) ** 2 + (f.points[i].lat - lat) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** The evaluation core: forecast at each itinerary point at the hour the boat is there. */
function attachWx(itinerary: ItinerarySample[], forecast: RouteForecast): TripSample[] {
  return itinerary.map((s) => {
    const p = forecast.points[nearestPoint(forecast, s.lon, s.lat)]
    const i = hourIndexAt(p.time, s.atMs)
    const windKn = p.windKn[i] ?? 0
    const gustKn = p.gustKn[i] ?? 0
    const windDir = p.windDir[i] ?? 0
    const waveM = p.waveM[i] ?? null
    const weatherCode = p.weatherCode[i] ?? 0
    const cond: Condition = weatherCode >= 95 ? 'rough' : conditionFor(windKn, gustKn, waveM)
    return { ...s, windKn, gustKn, windDir, waveM, weatherCode, cond }
  })
}

/** Verdict = worst conditions anywhere on the timed trip. */
function verdictFor(samples: TripSample[]): Verdict {
  let worst = 0
  for (const s of samples) worst = Math.max(worst, condRank(s.cond))
  return worst === 2 ? 'nogo' : worst === 1 ? 'caution' : 'go'
}

// ---------- the 7-day trip-option sweep ----------

const SWEEP_FIRST_H = 6 // earliest departure candidate: 6 am
const SWEEP_LAST_H = 20 // latest: 8 pm
const SWEEP_DAYS = 7
const STAY_STEP_MIN = 30 // stay-time granularity when maximizing time there
const MAX_STAY_MIN = 480 // nobody plans more than a full day at the beach
const MAX_OPTIONS_PER_DAY = 3

export interface SweepCfg {
  cruiseKn: number
  roundTrip: boolean
  minStayMin: number // shortest stay worth going for
  backByHour: number | null // latest hour-of-day to be home, null = no limit
}

type Rated =
  | { verdict: 'go' | 'caution'; stayMin: number | null; homeMs: number }
  | 'nogo'
  | 'nodata'

/** Rate one departure: for round trips, find the LONGEST stay (within the
 *  back-by limit and the forecast) that keeps every leg workable. */
function rateDeparture(
  route: RouteResult,
  cum: number[],
  forecast: RouteForecast,
  cfg: SweepCfg,
  departMs: number,
  wxEndMs: number,
  backByMs: number,
  oneWayMs: number,
): Rated {
  const slack = 30 * 60_000 // half an hour of forecast overhang is fine
  const arriveMs = departMs + oneWayMs

  if (!cfg.roundTrip) {
    if (arriveMs > wxEndMs + slack) return 'nodata'
    if (arriveMs > backByMs) return 'nogo' // can't make it in time
    const itin = buildItinerary(route, { cruiseKn: cfg.cruiseKn, roundTrip: false, stayMin: 0 }, departMs, cum)
    const v = verdictFor(attachWx(itin, forecast))
    return v === 'nogo' ? 'nogo' : { verdict: v, stayMin: null, homeMs: arriveMs }
  }

  if (arriveMs + cfg.minStayMin * 60_000 + oneWayMs > wxEndMs + slack) return 'nodata'

  // rough on the way out kills every stay length — check once
  const outItin = buildItinerary(route, { cruiseKn: cfg.cruiseKn, roundTrip: false, stayMin: 0 }, departMs, cum)
  if (verdictFor(attachWx(outItin, forecast)) === 'nogo') return 'nogo'

  const capMs = Math.min(backByMs, wxEndMs + slack)
  const capStay = Math.min(
    MAX_STAY_MIN,
    Math.floor((capMs - departMs - 2 * oneWayMs) / (STAY_STEP_MIN * 60_000)) * STAY_STEP_MIN,
  )
  if (capStay < cfg.minStayMin) return 'nogo'

  // scan stays longest-first: the first 'go' is the longest good stay;
  // remember the longest 'caution' as the fallback
  let caution: number | null = null
  for (let S = capStay; S >= cfg.minStayMin; S -= STAY_STEP_MIN) {
    const itin = buildItinerary(route, { cruiseKn: cfg.cruiseKn, roundTrip: true, stayMin: S }, departMs, cum)
    const v = verdictFor(attachWx(itin, forecast))
    if (v === 'go') return { verdict: 'go', stayMin: S, homeMs: departMs + 2 * oneWayMs + S * 60_000 }
    if (v === 'caution' && caution == null) caution = S
  }
  if (caution != null) {
    return { verdict: 'caution', stayMin: caution, homeMs: departMs + 2 * oneWayMs + caution * 60_000 }
  }
  return 'nogo'
}

/**
 * Sweeps every daytime departure hour of the next week, maximizing time at
 * the destination for each, and boils each day down to a few concrete
 * options: "Sat: leave 8a, 4½h there, home 3:10p". Pure math on the
 * already-fetched forecast — no extra requests.
 */
export function computeDepartureWindows(
  route: RouteResult,
  forecast: RouteForecast,
  cfg: SweepCfg,
): DayWindows[] {
  const p0 = forecast.points[0]
  const wxEndMs = Date.parse(`${p0.time[p0.time.length - 1]}Z`)
  const now = Date.now()
  const t0 = new Date()
  const cum = cumulativeNm(route.coords)
  const oneWayMs = (cum[cum.length - 1] / cfg.cruiseKn) * 3600_000
  const days: DayWindows[] = []

  for (let d = 0; d < SWEEP_DAYS; d++) {
    const dayStartMs = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + d).getTime()
    const backByMs = cfg.backByHour == null ? Infinity : dayStartMs + cfg.backByHour * 3600_000

    const rated: { ms: number; verdict: 'go' | 'caution'; stayMin: number | null; homeMs: number }[] = []
    let anyData = false
    let anyNogo = false
    for (let h = SWEEP_FIRST_H; h <= SWEEP_LAST_H; h++) {
      const departMs = dayStartMs + h * 3600_000
      if (departMs < now - 30 * 60_000) continue // that boat has sailed
      const r = rateDeparture(route, cum, forecast, cfg, departMs, wxEndMs, backByMs, oneWayMs)
      if (r === 'nodata') continue
      anyData = true
      if (r === 'nogo') anyNogo = true
      else rated.push({ ms: departMs, ...r })
    }

    // contiguous same-verdict departures form one window; its option is the
    // departure with the most time there (earliest on ties / one-way trips)
    const options: TripOption[] = []
    let run: typeof rated = []
    const flush = () => {
      if (!run.length) return
      let best = run[0]
      for (const r of run) if ((r.stayMin ?? 0) > (best.stayMin ?? 0)) best = r
      options.push({
        departMs: best.ms,
        homeMs: best.homeMs,
        stayMin: best.stayMin,
        verdict: best.verdict,
        windowStartMs: run[0].ms,
        windowEndMs: run[run.length - 1].ms,
      })
      run = []
    }
    for (const r of rated) {
      const prev = run[run.length - 1]
      if (prev && (r.ms - prev.ms !== 3600_000 || r.verdict !== prev.verdict)) flush()
      run.push(r)
    }
    flush()

    // too many windows: keep the 'go' ones first, then re-sort chronologically
    let shown = options
    if (options.length > MAX_OPTIONS_PER_DAY) {
      shown = [...options]
        .sort((a, b) => (a.verdict === b.verdict ? a.departMs - b.departMs : a.verdict === 'go' ? -1 : 1))
        .slice(0, MAX_OPTIONS_PER_DAY)
        .sort((a, b) => a.departMs - b.departMs)
    }

    const best: Verdict | null = !anyData
      ? null
      : rated.some((r) => r.verdict === 'go')
        ? 'go'
        : rated.some((r) => r.verdict === 'caution')
          ? 'caution'
          : anyNogo
            ? 'nogo'
            : null

    days.push({ dayStartMs, best, options: shown })
  }
  return days
}

export async function planTrip(route: RouteResult, opts: TripOptions): Promise<TripPlan> {
  const itinerary = buildItinerary(route, opts, opts.departMs)

  // dedupe itinerary positions into forecast fetch points (~5 km bins,
  // matching the forecast model resolution; return leg reuses outbound points)
  const binKey = (lon: number, lat: number) => `${Math.round(lon * 20)},${Math.round(lat * 20)}`
  const bins = new Set<string>()
  const pts: [number, number][] = []
  for (const s of itinerary) {
    const k = binKey(s.lon, s.lat)
    if (!bins.has(k)) {
      bins.add(k)
      pts.push([s.lon, s.lat])
    }
  }

  // keyed on destination + sample count only, so the cache keeps hitting as
  // the start point moves with the boat; samples match by nearest point below
  const last = route.coords[route.coords.length - 1]
  const cacheKey = `${binKey(last[0], last[1])}|${pts.length}`
  const { forecast, stale } = await fetchRouteForecast(pts, cacheKey, opts.maxWxCacheMs ?? 0)

  const samples = attachWx(itinerary, forecast)
  const verdict = verdictFor(samples)

  const oneWayNm = route.distanceNm
  const totalNm = opts.roundTrip ? oneWayNm * 2 : oneWayNm
  const msPerNm = 3600_000 / opts.cruiseKn
  const arriveMs = opts.departMs + oneWayNm * msPerNm
  const homeMs = opts.roundTrip ? arriveMs + opts.stayMin * 60_000 + oneWayNm * msPerNm : null

  let worst = samples[0]
  for (const s of samples) if (condRank(s.cond) > condRank(worst.cond)) worst = s

  const where = phaseText(worst.phase, opts.destName)
  const wx = `${Math.round(worst.windKn)} kn ${compass(worst.windDir)}, gusts ${Math.round(worst.gustKn)}` +
    (worst.waveM != null ? `, ${worst.waveM.toFixed(1)} m waves` : '')
  let headline: string
  if (verdict === 'nogo') {
    headline =
      worst.weatherCode >= 95
        ? `Not recommended — thunderstorms ${where} around ${dayTimeLabel(worst.atMs)}.`
        : `Not recommended — ${wx} ${where} around ${dayTimeLabel(worst.atMs)}.`
  } else if (verdict === 'caution') {
    headline = `Doable but expect some chop — ${wx} ${where} around ${dayTimeLabel(worst.atMs)}.`
  } else {
    const maxWind = Math.max(...samples.map((s) => s.windKn))
    const maxWave = Math.max(...samples.map((s) => s.waveM ?? 0))
    headline = `Good to go — wind under ${Math.ceil(maxWind + 1)} kn and waves under ${(Math.ceil(maxWave * 10) / 10 + 0.1).toFixed(1)} m the whole trip.`
  }

  // heads-up scan: first rough hour at either end of the route within the horizon
  let turnsBadMs: number | null = null
  let turnsBadText: string | null = null
  const horizonMs = opts.departMs + BAD_WX_HORIZON_H * 3600_000
  const s0 = itinerary[0]
  const sN = itinerary[itinerary.length - 1]
  const scanPts = [nearestPoint(forecast, s0.lon, s0.lat), nearestPoint(forecast, sN.lon, sN.lat)]
  for (const pi of new Set(scanPts)) {
    const p = forecast.points[pi]
    for (let i = 0; i < p.time.length; i++) {
      const t = Date.parse(`${p.time[i]}Z`)
      if (t < opts.departMs || t > horizonMs) continue
      const rough =
        (p.weatherCode[i] ?? 0) >= 95 ||
        conditionFor(p.windKn[i] ?? 0, p.gustKn[i] ?? 0, p.waveM[i] ?? null) === 'rough'
      if (rough && (turnsBadMs == null || t < turnsBadMs)) {
        turnsBadMs = t
        turnsBadText =
          (p.weatherCode[i] ?? 0) >= 95
            ? `Thunderstorms possible around ${dayTimeLabel(t)}`
            : `Turns rough around ${dayTimeLabel(t)} — ${Math.round(p.windKn[i])} kn ${compass(p.windDir[i] ?? 0)}` +
              (p.waveM[i] != null ? `, ${(p.waveM[i] as number).toFixed(1)} m waves` : '')
        break
      }
    }
  }

  const days =
    opts.windows === false
      ? []
      : computeDepartureWindows(route, forecast, {
          cruiseKn: opts.cruiseKn,
          roundTrip: opts.roundTrip,
          minStayMin: opts.minStayMin ?? opts.stayMin,
          backByHour: opts.backByHour ?? null,
        })

  return {
    samples,
    destName: opts.destName,
    wx: forecast,
    days,
    oneWayNm,
    totalNm,
    departMs: opts.departMs,
    arriveMs,
    homeMs,
    verdict,
    headline,
    turnsBadMs,
    turnsBadText,
    fetchedAt: forecast.fetchedAt,
    stale,
  }
}

export { phaseText, timeLabel }
