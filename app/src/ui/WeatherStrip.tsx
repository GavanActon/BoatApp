import { useEffect, useMemo, useState } from 'react'
import { HOME } from '../config'
import { getMap } from '../map/mapController'
import { useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { dayLabel, floorHourMs, startOfDayMs } from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import {
  conditionFor,
  dailyOutlook,
  dayHours,
  fetchPointForecast,
  nextHours,
  type Condition,
  type HourRow,
  type PointForecast,
} from '../weather/openMeteo'
import { IconClose, IconPin, IconWindArrow } from './icons'

/**
 * Two-level outlook strip pinned to the top of the map — the app's clock.
 *
 * Day row: the next 7 days, colored by how boatable each looks. When a trip
 * is planned the rating comes from the trip's own departure-window sweep
 * ("can we do THIS run that day"); otherwise it's generic conditions at the
 * boat. Tap a day to look at it.
 *
 * Hour row: the hours of the selected day (the next 12 hours when that's
 * today). Tapping an hour sets the app-wide planning time — the wind & wave
 * map layer previews that moment and a planned trip re-times to depart then.
 *
 * Tapping a dot on a planned route points the strip at that leg instead —
 * hour-by-hour conditions at the exact spot.
 */

const STRIP_HOURS = 12
const DAY_FROM_H = 7 // future-day cells span 7 am … 6 pm
const DAY_TO_H = 18
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

  // day chips: rated against the planned trip when there is one, else generic
  const tripRated = destination != null && plan != null && plan.days.length > 0
  const days = useMemo(() => {
    if (tripRated) {
      return plan.days.map((d) => ({
        dayStartMs: d.dayStartMs,
        cond: d.best == null ? null : verdictCond(d.best),
      }))
    }
    return forecast ? dailyOutlook(forecast) : []
  }, [tripRated, plan, forecast])

  const rows: HourRow[] = useMemo(() => {
    if (!forecast) return []
    return selDayMs === todayMs
      ? nextHours(forecast, STRIP_HOURS)
      : dayHours(forecast, selDayMs, DAY_FROM_H, DAY_TO_H)
  }, [forecast, selDayMs, todayMs])

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
              }`}
            >
              {dayLabel(d.dayStartMs)}
            </button>
          )
        })}
      </div>

      {rows.length > 0 ? (
        <div className="wxstrip-cells">
          {rows.map((r, k) => {
            const cellMs = r.time.getTime()
            const isNowCell = selDayMs === todayMs && k === 0
            const cond = conditionFor(r.windKn, r.gustKn, r.waveM)
            const active = planTimeMs == null ? isNowCell : cellMs === planHourMs
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
                  if (!weatherOn) setLayer('weather', true)
                }}
                aria-label={`${isNowCell ? 'Now' : hourLabel(r.time)}: wind ${Math.round(r.windKn)} knots, waves ${r.waveM != null ? r.waveM.toFixed(1) : 'unknown'} metres`}
              >
                <span className="wxcell-h numeral">{isNowCell ? 'Now' : hourLabel(r.time)}</span>
                <IconWindArrow deg={r.windDir + 180} size={12} />
                <b className="numeral">{Math.round(r.windKn)}</b>
                <span className="wxcell-wave numeral">
                  {r.waveM != null ? r.waveM.toFixed(1) : '–'}
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
