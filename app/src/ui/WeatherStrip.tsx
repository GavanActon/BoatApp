import { useEffect, useMemo, useState } from 'react'
import { HOME } from '../config'
import { getMap } from '../map/mapController'
import { useRouteStore } from '../routing/routeStore'
import type { HourRating } from '../routing/tripPlan'
import { useAppStore } from '../state/appStore'
import { dayLabel, durationLabel, floorHourMs, startOfDayMs } from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import {
  conditionFor,
  dailyOutlook,
  dayHours,
  fetchPointForecast,
  formatPeriod,
  nextHours,
  skyLabel,
  type Condition,
  type HourRow,
  type PointForecast,
} from '../weather/openMeteo'
import { IconClose, IconPin, IconSky, IconWindArrow } from './icons'

/**
 * Two-level outlook strip pinned to the top of the map — the app's clock AND,
 * with a trip planned, the whole when-to-go picker.
 *
 * Day row: the next 7 days, colored by how boatable each looks. When a trip
 * is planned the rating comes from the trip's own departure-window sweep
 * ("can we do THIS run that day"); otherwise it's generic conditions at the
 * boat. Tap a day to look at it (with a trip: adopt its best departure).
 *
 * Hour row: the hours of the selected day (the next 12 hours when that's
 * today). With a trip planned each cell answers "what if we LEFT at this
 * hour" — colored by that departure's verdict from the sweep — and tapping
 * one adopts it, stay time and all. Without a trip a cell is just conditions
 * at the boat. Either way the tap sets the app-wide planning time and the
 * wind & wave layer previews that moment.
 *
 * Tapping a dot on a planned route points the strip at that leg instead —
 * hour-by-hour conditions at the exact spot, never trip-rated.
 */

// Ten cells, not twelve: at phone width twelve cells leave 28 px each, too
// narrow for "0.2 · 3s" to read as numbers rather than texture. Future days
// span the same ten hours so every day is the same shape.
const STRIP_HOURS = 10
const DAY_FROM_H = 8 // future-day cells span 8 am … 5 pm
const DAY_TO_H = 17
const REFRESH_MS = 30 * 60_000

function hourLabel(d: Date): string {
  const h = d.getHours()
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`
}

/** A trip verdict on the day chips wears the same colors as hour conditions. */
function verdictCond(v: 'go' | 'caution' | 'nogo'): Condition {
  return v === 'go' ? 'good' : v === 'caution' ? 'mod' : 'rough'
}

export default function WeatherStrip() {
  const enabled = useAppStore((s) => s.wxStrip)
  const weatherOn = useAppStore((s) => s.layers.weather)
  const setLayer = useAppStore((s) => s.setLayer)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)
  const showPeriod = useAppStore((s) => s.wavePeriod)
  const online = useAppStore((s) => s.online)
  const focusPoint = useRouteStore((s) => s.focusPoint)
  const setFocusPoint = useRouteStore((s) => s.setFocusPoint)
  const destination = useRouteStore((s) => s.destination)
  const plan = useRouteStore((s) => s.plan)
  const setPlannedStay = useRouteStore((s) => s.setPlannedStay)

  const [forecast, setForecast] = useState<PointForecast | null>(null)
  const [stale, setStale] = useState(false)

  const show = enabled || focusPoint != null // a focused dot always surfaces the strip

  useEffect(() => {
    if (!show) return
    let alive = true
    const load = async () => {
      const fix = useGpsStore.getState().fix
      const c = getMap()?.getCenter()
      const lon = focusPoint?.lon ?? fix?.lon ?? c?.lng ?? HOME.center[0]
      const lat = focusPoint?.lat ?? fix?.lat ?? c?.lat ?? HOME.center[1]
      try {
        const { forecast: fc, stale: st } = await fetchPointForecast(lon, lat)
        if (alive) {
          setForecast(fc)
          setStale(st)
        }
      } catch {
        /* keep whatever we had */
      }
    }
    void load()
    const t = setInterval(() => void load(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
    // re-fetch when connectivity returns so a stale strip heals itself
  }, [show, online, focusPoint])

  const todayMs = startOfDayMs(Date.now())
  const selDayMs = startOfDayMs(planTimeMs ?? Date.now())

  // temp + sky per day always come from the point forecast, whatever rates the chips
  const outlook = useMemo(() => (forecast ? dailyOutlook(forecast) : []), [forecast])
  const wxByDay = useMemo(() => new Map(outlook.map((o) => [o.dayStartMs, o])), [outlook])

  // day chips: rated against the planned trip when there is one, else generic
  const tripRated = destination != null && plan != null && plan.days.length > 0
  const days = useMemo(() => {
    if (tripRated) {
      return plan.days.map((d) => ({
        dayStartMs: d.dayStartMs,
        cond: d.best == null ? null : verdictCond(d.best),
      }))
    }
    return outlook
  }, [tripRated, plan, outlook])

  const rows: HourRow[] = useMemo(() => {
    if (!forecast) return []
    return selDayMs === todayMs
      ? nextHours(forecast, STRIP_HOURS)
      : dayHours(forecast, selDayMs, DAY_FROM_H, DAY_TO_H)
  }, [forecast, selDayMs, todayMs])

  // with a trip planned (and the strip on the boat, not a focused leg) each
  // hour cell is rated as a DEPARTURE: "what if we left then"
  const tripHours = useMemo(() => {
    if (!tripRated || focusPoint) return null
    const m = new Map<number, HourRating>()
    for (const d of plan!.days) for (const h of d.hours) m.set(h.ms, h)
    return m
  }, [tripRated, focusPoint, plan])

  if (!show || (rows.length === 0 && days.length === 0)) return null

  const planHourMs = planTimeMs == null ? null : floorHourMs(planTimeMs)

  function pickDay(dayStartMs: number) {
    if (dayStartMs === todayMs) {
      setPlanTime(null)
      return
    }
    // adopt the trip's best option for that day if there is one, else mid-morning
    const opts = tripRated ? plan!.days.find((d) => d.dayStartMs === dayStartMs)?.options : undefined
    const best = opts?.find((o) => o.verdict === 'go') ?? opts?.[0]
    if (best) {
      setPlanTime(best.departMs)
      setPlannedStay(best.stayMin)
    } else {
      setPlanTime(dayStartMs + 9 * 3600_000)
    }
  }

  return (
    <div className="wxstrip glass" role="group" aria-label="7-day weather outlook">
      {focusPoint && (
        <button
          className="wxstrip-focus"
          onClick={() => setFocusPoint(null)}
          aria-label={`Showing forecast at ${focusPoint.label} — tap to return to my position`}
        >
          <IconPin size={11} />
          <span>{focusPoint.label}</span>
          <IconClose size={11} />
        </button>
      )}

      <div className="wxstrip-days" role="tablist" aria-label="Pick a day">
        {days.map((d) => {
          const sel = d.dayStartMs === selDayMs
          const wx = wxByDay.get(d.dayStartMs)
          const wxCode = wx?.weatherCode ?? null
          const wxTemp = wx?.tempMaxC ?? null
          return (
            <button
              key={d.dayStartMs}
              className={`wxday wx-${d.cond ?? 'na'}${sel ? ' wxday-on' : ''}`}
              onClick={() => pickDay(d.dayStartMs)}
              role="tab"
              aria-selected={sel}
              aria-label={`${dayLabel(d.dayStartMs)}: ${
                d.cond == null
                  ? 'beyond the forecast'
                  : d.cond === 'good'
                    ? tripRated
                      ? 'good day for this trip'
                      : 'good boating day'
                    : d.cond === 'mod'
                      ? 'usable with caution'
                      : 'rough'
              }${
                wxCode != null && wxTemp != null
                  ? `, ${skyLabel(wxCode)}, high ${Math.round(wxTemp)} degrees`
                  : ''
              }`}
            >
              <span className="wxday-name">{dayLabel(d.dayStartMs)}</span>
              {wxCode != null && wxTemp != null && (
                <span className="wxday-wx">
                  <IconSky code={wxCode} size={11} />
                  <b className="numeral">{Math.round(wxTemp)}°</b>
                </span>
              )}
            </button>
          )
        })}
      </div>

      {rows.length > 0 ? (
        <div className="wxstrip-cells">
          {rows.map((r, k) => {
            const cellMs = r.time.getTime()
            const isNowCell = selDayMs === todayMs && k === 0
            // the now-cell sits at the floor of the hour, which the sweep
            // counts as sailed (it rates it, but with no verdict) — leaving
            // "now" is really leaving within the hour, so the next hour's
            // rating stands in for it
            const ratedAt = (ms: number) => {
              const h = tripHours?.get(ms)
              return h?.verdict != null ? h : undefined
            }
            const rating = tripHours
              ? (ratedAt(cellMs) ?? (isNowCell ? ratedAt(cellMs + 3600_000) : undefined))
              : undefined
            const cond: Condition | 'na' = tripHours
              ? isNowCell && planTimeMs == null && plan
                ? verdictCond(plan.verdict) // the current plan IS "leave now"
                : rating?.verdict != null
                  ? verdictCond(rating.verdict)
                  : 'na'
              : conditionFor(r.windKn, r.gustKn, r.waveM)
            const active = planTimeMs == null ? isNowCell : cellMs === planHourMs
            const period = showPeriod ? formatPeriod(r.wavePeriodS) : null
            const wxText =
              `wind ${Math.round(r.windKn)} knots, waves ${r.waveM != null ? r.waveM.toFixed(1) : 'unknown'} metres` +
              (showPeriod && r.wavePeriodS != null ? ` at ${Math.round(r.wavePeriodS)} seconds` : '')
            return (
              <button
                key={cellMs}
                className={`wxcell wx-${cond}${active ? ' wx-active' : ''}`}
                onClick={() => {
                  if (active) {
                    // second tap on the selected hour toggles the map preview
                    setLayer('weather', !weatherOn)
                    return
                  }
                  setPlanTime(isNowCell ? null : cellMs)
                  // leaving then gets that departure's maximized time there
                  if (tripHours) setPlannedStay(isNowCell ? null : (rating?.stayMin ?? null))
                  if (!weatherOn) setLayer('weather', true)
                }}
                aria-label={
                  tripHours
                    ? `Leave ${isNowCell ? 'now' : `at ${hourLabel(r.time)}`}: ${
                        cond === 'good'
                          ? 'good for this trip'
                          : cond === 'mod'
                            ? 'usable with caution'
                            : cond === 'rough'
                              ? 'not recommended'
                              : 'beyond what can be rated'
                      }${rating?.stayMin != null ? `, ${durationLabel(rating.stayMin)} there` : ''}, ${wxText}`
                    : `${isNowCell ? 'Now' : hourLabel(r.time)}: ${wxText}`
                }
              >
                <span className="wxcell-h numeral">{isNowCell ? 'Now' : hourLabel(r.time)}</span>
                <IconWindArrow deg={r.windDir + 180} size={12} />
                <b className="numeral">{Math.round(r.windKn)}</b>
                <span className="wxcell-wave numeral">
                  {r.waveM != null ? r.waveM.toFixed(1) : '–'}
                  {period && <em>{period}</em>}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="wxstrip-empty">No forecast this far out yet</div>
      )}

      {stale && <i className="wxstrip-stale" title="Offline copy" />}
    </div>
  )
}
