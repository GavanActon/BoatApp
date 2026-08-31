import { HOME } from '../config'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { dayLabel, floorHourMs } from '../time'
import { speedUnitLabel, windSpeed } from '../units'
import { useGpsStore } from '../tracking/gpsStore'
import { gridConditionsAt, onWeatherGrid } from './weatherLayer'

/**
 * The forecast watch: notices when a fresh model run says something
 * SUBSTANTIALLY different from what the user last saw, for the hours they
 * actually care about — and says so, once, as a topbar chip.
 *
 * A forecast app that silently re-renders is quietly dangerous: you pick
 * Saturday on Tuesday's model run, and by Thursday the wind has doubled but
 * every surface just... shows the new numbers, as if it always had. The
 * watch keeps a baseline of what was on screen (persisted, so an overnight
 * shift greets you at open), compares each refresh against it, and speaks
 * only past real thresholds — a knot of drift is weather being weather.
 *
 * What it watches: the planned window at the trip's destination when one is
 * picked, otherwise tomorrow's daytime hours where the boat is. The baseline
 * rebases when the context changes (new destination, new time — you're
 * asking a new question) and when the chip is acknowledged.
 */

const WIND_SHIFT_KN = 5 // ~9 km/h — enough to change the afternoon
const WAVE_SHIFT_M = 0.25 // half a band on the sea-state ramp
const STORE_KEY = 'sandies-wx-seen'

interface WatchHour {
  ms: number
  windKn: number
  gustKn: number
  waveM: number | null
}

interface Baseline {
  key: string
  hours: WatchHour[]
}

/** Where the watched weather lives: the trip's destination when one is
 *  planned, else the boat, else home waters. */
function target(): { lon: number; lat: number } {
  const dest = useRouteStore.getState().destination
  if (dest) return { lon: dest.lon, lat: dest.lat }
  const fix = useGpsStore.getState().fix
  if (fix) return { lon: fix.lon, lat: fix.lat }
  return { lon: HOME.center[0], lat: HOME.center[1] }
}

/** The hours that matter: the planned window, else tomorrow's boating day. */
function watchWindow(): number[] {
  const { planTimeMs, planEndMs } = useAppStore.getState()
  const out: number[] = []
  if (planTimeMs != null && planTimeMs > Date.now()) {
    const from = floorHourMs(planTimeMs)
    const to = Math.min(planEndMs ?? from + 4 * 3600_000, from + 12 * 3600_000)
    for (let ms = from; ms <= to; ms += 3600_000) out.push(ms)
    return out
  }
  const d = new Date()
  const tomorrow8 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8).getTime()
  for (let h = 0; h <= 10; h++) out.push(tomorrow8 + h * 3600_000)
  return out
}

function sampleNow(): Baseline | null {
  const t = target()
  const hours: WatchHour[] = []
  for (const ms of watchWindow()) {
    const c = gridConditionsAt(t.lon, t.lat, ms)
    if (!c) return null // no grid yet — nothing to compare
    hours.push({ ms, windKn: c.windKn, gustKn: c.gustKn, waveM: c.waveM })
  }
  if (!hours.length) return null
  // context signature: a different place or different hours = a new question
  const key = `${t.lon.toFixed(2)},${t.lat.toFixed(2)}:${hours[0].ms}:${hours.length}`
  return { key, hours }
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Baseline | null
  } catch {
    return null
  }
}

function saveBaseline(b: Baseline) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(b))
  } catch {
    /* best-effort */
  }
}

/** The biggest disagreement between then and now, in the user's units, or
 *  null when the forecast has held. */
function shiftText(base: Baseline, cur: Baseline): string | null {
  let dWind = 0
  let windAt = 0
  let dWave = 0
  let waveAt = 0
  for (let i = 0; i < cur.hours.length; i++) {
    const b = base.hours[i]
    const c = cur.hours[i]
    if (!b || b.ms !== c.ms) return null // hours rolled — stale baseline
    const dw = Math.max(Math.abs(c.windKn - b.windKn), Math.abs(c.gustKn - b.gustKn))
    if (dw > dWind) {
      dWind = dw
      windAt = i
    }
    if (b.waveM != null && c.waveM != null) {
      const dv = Math.abs(c.waveM - b.waveM)
      if (dv > dWave) {
        dWave = dv
        waveAt = i
      }
    }
  }
  const unit = useAppStore.getState().windUnit
  if (dWave >= WAVE_SHIFT_M) {
    const b = base.hours[waveAt]
    const c = cur.hours[waveAt]
    return `waves ${b.waveM!.toFixed(1)}→${c.waveM!.toFixed(1)} m`
  }
  if (dWind >= WIND_SHIFT_KN) {
    const b = base.hours[windAt]
    const c = cur.hours[windAt]
    return `wind ${windSpeed(unit, b.windKn)}→${windSpeed(unit, c.windKn)} ${speedUnitLabel(unit)}`
  }
  return null
}

function check() {
  const cur = sampleNow()
  if (!cur) return
  const base = loadBaseline()
  if (!base || base.key !== cur.key) {
    // first look, or a new question — this IS what the user is seeing now
    saveBaseline(cur)
    useAppStore.getState().setWxShift(null)
    return
  }
  const text = shiftText(base, cur)
  const when = dayLabel(cur.hours[0].ms)
  useAppStore.getState().setWxShift(text ? `Forecast shifted · ${when}: ${text}` : null)
}

/** The chip was seen: what's on screen becomes the new baseline. */
export function acknowledgeWxShift() {
  const cur = sampleNow()
  if (cur) saveBaseline(cur)
  useAppStore.getState().setWxShift(null)
}

let wired = false

/** Call once at startup. */
export function initForecastWatch() {
  if (wired) return
  wired = true
  onWeatherGrid(check)
  useAppStore.subscribe((s, prev) => {
    // a new time is a new question — rebase silently rather than "alerting"
    // about a difference the user just asked for
    if (s.planTimeMs !== prev.planTimeMs || s.planEndMs !== prev.planEndMs) {
      const cur = sampleNow()
      if (cur) saveBaseline(cur)
      s.setWxShift(null)
    }
  })
  useRouteStore.subscribe((s, prev) => {
    if (s.destination !== prev.destination) {
      const cur = sampleNow()
      if (cur) saveBaseline(cur)
      useAppStore.getState().setWxShift(null)
    }
  })
}
