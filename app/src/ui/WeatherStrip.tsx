import { useEffect, useMemo, useRef, useState } from 'react'
import { HOME } from '../config'
import { homeCenter } from '../state/placesStore'
import { getMap } from '../map/mapController'
import { adoptWindow } from '../routing/planner'
import { useRouteStore } from '../routing/routeStore'
import type { HourRating } from '../routing/tripPlan'
import { useAppStore } from '../state/appStore'
import { dayLabel, durationLabel, floorHourMs, startOfDayMs } from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import {
  dailyOutlook,
  dayHours,
  fetchPointForecast,
  formatPeriod,
  skyLabel,
  type HourRow,
  type PointForecast,
} from '../weather/openMeteo'
import { speedUnitLabel, windSpeed } from '../units'
import { seaColor, seaName } from '../weather/seaState'
import { onWeatherHour } from '../weather/weatherLayer'
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
 * Hour row: every remaining hour of the selected day (all 24 on a future
 * day), ten visible at a time and the rest a swipe away. With a trip planned
 * each cell answers "what if we LEFT at this hour" — colored by that
 * departure's verdict from the sweep — and tapping
 * one adopts it, stay time and all. Without a trip a cell is just conditions
 * at the boat. Either way the tap sets the app-wide planning time and the
 * wind & wave layer previews that moment.
 *
 * Tapping a dot on a planned route points the strip at that leg instead —
 * hour-by-hour conditions at the exact spot, never trip-rated.
 */

// Ten cells VISIBLE, not ten cells total: at phone width more than ten leave
// under 28 px each, too narrow for "0.2 · 3s" to read as numbers rather than
// texture. The row scrolls, so any hour of the day is still pickable — a dawn
// launch or an evening cruise is a swipe away, not off the menu.
const DAY_FROM_H = 8 // where a future day's row opens (scrolled, not clipped)
const REFRESH_MS = 30 * 60_000

function hourLabel(d: Date): string {
  const h = d.getHours()
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`
}

export default function WeatherStrip() {
  const enabled = useAppStore((s) => s.wxStrip)
  const weatherOn = useAppStore((s) => s.layers.weather)
  const setLayer = useAppStore((s) => s.setLayer)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)
  const planEndMs = useAppStore((s) => s.planEndMs)
  const setPlanWindow = useAppStore((s) => s.setPlanWindow)
  // set on the trip card; while it's set this strip is that chip's keypad
  const setPlanPicked = useAppStore((s) => s.setPlanPicked)
  const armedEnd = useAppStore((s) => s.armedEnd)
  const setArmedEnd = useAppStore((s) => s.setArmedEnd)
  const showPeriod = useAppStore((s) => s.wavePeriod)
  const windUnit = useAppStore((s) => s.windUnit)
  const online = useAppStore((s) => s.online)
  // the first fix arrives after mount; without a pinned start it IS the
  // trip's start, so the strip has to come off home waters when it lands
  const hasFix = useGpsStore((s) => s.fix != null)
  const focusPoint = useRouteStore((s) => s.focusPoint)
  const setFocusPoint = useRouteStore((s) => s.setFocusPoint)
  const destination = useRouteStore((s) => s.destination)
  const startPoint = useRouteStore((s) => s.startPoint)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const plan = useRouteStore((s) => s.plan)

  const [forecast, setForecast] = useState<PointForecast | null>(null)
  const [stale, setStale] = useState(false)

  // While a window chip is armed, day taps steer the KEYPAD — which day's
  // hours are offered — without touching the plan. That is what makes a
  // multi-day window possible: arm Back, tap Sunday, pick an hour.
  const [armDayMs, setArmDayMs] = useState<number | null>(null)
  useEffect(() => {
    if (!armedEnd) setArmDayMs(null) // disarming forgets the keypad's day
  }, [armedEnd])

  const show = enabled || focusPoint != null // a focused dot always surfaces the strip

  // A trip planned from a pinned start (launch ramp, marina) is rated at the
  // RAMP's weather, not the phone's — the two are often an hour apart by road,
  // and the strip's numbers have to be the ones the sweep colored the cells
  // with. Under way the boat IS the departure point, so GPS is right again.
  const departFrom =
    destination != null && tripStartedAt == null && startPoint != null ? startPoint : null

  useEffect(() => {
    if (!show) return
    let alive = true
    const load = async () => {
      const fix = useGpsStore.getState().fix
      const c = getMap()?.getCenter()
      const home = homeCenter() ?? HOME.center
      const lon = focusPoint?.lon ?? departFrom?.lon ?? fix?.lon ?? c?.lng ?? home[0]
      const lat = focusPoint?.lat ?? departFrom?.lat ?? fix?.lat ?? c?.lat ?? home[1]
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
    // and at each top of the hour: the Now cell floors to the current hour,
    // so the boundary is when yesterday's row would otherwise linger
    const offHour = onWeatherHour(() => void load())
    return () => {
      alive = false
      clearInterval(t)
      offHour()
    }
    // re-fetch when connectivity returns so a stale strip heals itself
  }, [show, online, focusPoint, departFrom, hasFix])

  const todayMs = startOfDayMs(Date.now())
  const selDayMs =
    armedEnd && armDayMs != null ? armDayMs : startOfDayMs(planTimeMs ?? Date.now())

  // temp + sky per day always come from the point forecast, whatever rates the chips
  const outlook = useMemo(() => (forecast ? dailyOutlook(forecast) : []), [forecast])
  const wxByDay = useMemo(() => new Map(outlook.map((o) => [o.dayStartMs, o])), [outlook])

  // day chips: rated against the planned trip when there is one, else generic
  const tripRated = destination != null && plan != null && plan.days.length > 0
  const days = useMemo(() => {
    if (tripRated) {
      // the chip carries the day, not a grade of it — the outlook's own
      // conditions decide its colour, the same as when no trip is planned
      return plan.days.map((d) => ({ dayStartMs: d.dayStartMs }))
    }
    return outlook.map((o) => ({ dayStartMs: o.dayStartMs }))
  }, [tripRated, plan, outlook])

  // the whole day is on offer — today from the current hour, a future day
  // from midnight — and the row scrolls to reach it all. Late evening has
  // its own rule: at 22:00 "the rest of today" is two lonely cells, so the
  // row keeps at least eight hours in hand by continuing into tomorrow —
  // the water doesn't stop at midnight, and neither does leaving.
  const rows: HourRow[] = useMemo(() => {
    if (!forecast) return []
    if (selDayMs !== todayMs) return dayHours(forecast, selDayMs, 0, 23)
    const today = dayHours(forecast, todayMs, new Date().getHours(), 23)
    const deficit = 8 - today.length
    return deficit > 0
      ? [...today, ...dayHours(forecast, todayMs + 24 * 3600_000, 0, deficit - 1)]
      : today
  }, [forecast, selDayMs, todayMs])

  // with a trip planned (and the strip on the boat, not a focused leg) each
  // hour cell is rated as a DEPARTURE: "what if we left then"
  const tripHours = useMemo(() => {
    if (!tripRated || focusPoint) return null
    const m = new Map<number, HourRating>()
    for (const d of plan!.days) for (const h of d.hours) m.set(h.ms, h)
    return m
  }, [tripRated, focusPoint, plan])

  // When a day's row first shows, it opens scrolled to the hour that matters
  // — the planned hour if it's on this day, "now" for today, morning for a
  // future day. Placed once per day so a forecast refresh (or a tap on an
  // already-visible hour) never yanks the row back.
  const cellsRef = useRef<HTMLDivElement | null>(null)
  const placedDayRef = useRef<number | null>(null)
  useEffect(() => {
    const el = cellsRef.current
    if (!el || rows.length === 0) return
    if (placedDayRef.current === selDayMs) return
    placedDayRef.current = selDayMs
    const planMs = useAppStore.getState().planTimeMs
    const planHour = planMs == null ? null : floorHourMs(planMs)
    let idx =
      planHour != null ? rows.findIndex((r) => r.time.getTime() === planHour) : -1
    if (idx < 0 && selDayMs !== todayMs) {
      idx = rows.findIndex((r) => r.time.getHours() === DAY_FROM_H)
    }
    const cell = el.children[Math.max(0, idx)] as HTMLElement | undefined
    const first = el.children[0] as HTMLElement | undefined
    if (cell && first) el.scrollLeft = Math.max(0, cell.offsetLeft - first.offsetLeft)
  }, [selDayMs, todayMs, rows])

  if (!show || (rows.length === 0 && days.length === 0)) return null

  const planHourMs = planTimeMs == null ? null : floorHourMs(planTimeMs)

  function pickDay(dayStartMs: number) {
    // with a chip armed the day tap only turns the keypad's page — the plan
    // moves when an HOUR is picked, and only the armed end of it
    if (armedEnd) {
      setArmDayMs(dayStartMs)
      return
    }
    setPlanPicked(true)
    if (dayStartMs === todayMs) {
      setPlanTime(null)
      return
    }
    // adopt the trip's best option for that day if there is one, else mid-morning
    const opts = tripRated ? plan!.days.find((d) => d.dayStartMs === dayStartMs)?.options : undefined
    const best = opts?.find((o) => o.verdict === 'go') ?? opts?.[0]
    if (best) {
      adoptWindow(best.departMs, best.stayMin)
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

      {!focusPoint && departFrom && (
        <span className="wxstrip-focus wxstrip-from">
          <IconPin size={11} />
          <span>{departFrom.name ?? 'Pinned start'}</span>
        </span>
      )}

      <div className="wxstrip-days" role="tablist" aria-label="Pick a day">
        {days.map((d) => {
          const sel = d.dayStartMs === selDayMs
          const wx = wxByDay.get(d.dayStartMs)
          const wxCode = wx?.weatherCode ?? null
          const wxTemp = wx?.tempMaxC ?? null
          // rain and lightning live in the SKY ICON (§0.6): the day's code is
          // its worst hour, so a thunder day wears the storm icon and a wet
          // day the rain cloud. The 💧/⚡ marks that used to ride alongside
          // told the same story twice and went. Hour cells keep their ⚡ —
          // they carry no sky icon. These stay for the spoken label:
          const wet = wx?.precipMaxPct != null && wx.precipMaxPct >= 40
          const thunder = wx?.thunder === true
          return (
            <button
              key={d.dayStartMs}
              className={`wxday${sel ? ' wxday-on' : ''}`}
              style={{ borderTopColor: seaColor(wx?.waveMaxM ?? null) }}
              onClick={() => pickDay(d.dayStartMs)}
              role="tab"
              aria-selected={sel}
              aria-label={`${dayLabel(d.dayStartMs)}: ${
                wx?.waveMaxM != null ? `${seaName(wx.waveMaxM)}, ${wx.waveMaxM.toFixed(1)} metres` : 'no wave data'
              }${
                wxCode != null && wxTemp != null
                  ? `, ${skyLabel(wxCode)}, high ${Math.round(wxTemp)} degrees`
                  : ''
              }${wet ? ', rain likely' : ''}${thunder ? ', thunder' : ''}`}
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
        <div className="wxstrip-cells" ref={cellsRef}>
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
            // The cell shows the WATER at that hour, on the sea-state ramp.
            // It used to be recoloured by the trip's verdict for that departure
            // — the strip grading your options — which is exactly what the ramp
            // replaced.
            const active = planTimeMs == null ? isNowCell : cellMs === planHourMs
            // With a chip armed, only the hours that would still leave a
            // window are offered — so a tap can never produce a nonsense one,
            // and the other end holds still.
            const armable =
              armedEnd === 'out'
                ? planEndMs == null || cellMs < planEndMs
                : armedEnd === 'back'
                  // no departure picked yet means "leaving now", so the ride
                  // home is still choosable — this used to disable all ten
                  // cells and leave cancel as the only way out
                  ? cellMs > (planTimeMs ?? Date.now())
                  : false
            const period = showPeriod ? formatPeriod(r.wavePeriodS) : null
            const wxText =
              `wind ${windSpeed(windUnit, r.windKn)} ${speedUnitLabel(windUnit)}, waves ${r.waveM != null ? r.waveM.toFixed(1) : 'unknown'} metres` +
              (showPeriod && r.wavePeriodS != null ? ` at ${Math.round(r.wavePeriodS)} seconds` : '') +
              (r.weatherCode >= 95 ? ', thunder' : '')
            return (
              <button
                key={cellMs}
                className={
                  `wxcell${active ? ' wx-active' : ''}` +
                  (armedEnd ? (armable ? ' wx-armable' : ' wx-unarmable') : '')
                }
                style={{ borderTopColor: seaColor(r.waveM) }}
                onClick={() => {
                  // any accepted time-tap moves the app from exploring to
                  // planning — including "Now", which is a choice, not a default
                  setPlanPicked(true)
                  if (armedEnd) {
                    if (!armable) return
                    if (armedEnd === 'out') setPlanWindow(cellMs, planEndMs)
                    else setPlanWindow(planTimeMs, cellMs)
                    setArmedEnd(null)
                    return
                  }
                  if (active) {
                    // second tap on the selected hour toggles the map preview
                    setLayer('weather', !weatherOn)
                    return
                  }
                  // leaving then gets that departure's maximized time there —
                  // as a window, so the ride home lands where it should
                  if (isNowCell) setPlanTime(null)
                  else if (tripHours) adoptWindow(cellMs, rating?.stayMin ?? null)
                  else setPlanTime(cellMs)
                  if (!weatherOn) setLayer('weather', true)
                }}
                aria-label={
                  `${isNowCell ? 'Now' : hourLabel(r.time)}: ${wxText}` +
                  (rating?.stayMin != null ? `, ${durationLabel(rating.stayMin)} there` : '')
                }
              >
                <span className="wxcell-h numeral">{isNowCell ? 'Now' : hourLabel(r.time)}</span>
                {r.weatherCode >= 95 && (
                  // an hour that calls thunder wears the one loud mark (§0.6)
                  <i className="wx-bolt wxcell-bolt" aria-hidden="true">
                    ⚡
                  </i>
                )}
                <IconWindArrow deg={r.windDir + 180} size={12} />
                <b className="numeral">{windSpeed(windUnit, r.windKn)}</b>
                <span className="wxcell-wave numeral">
                  {r.waveM != null ? r.waveM.toFixed(1) : '–'}
                  {period && <em>{period}</em>}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="wxstrip-empty">—</div>
      )}

      {armedEnd && (
        <button className="wxstrip-arm" onClick={() => setArmedEnd(null)}>
          Pick an hour · cancel
        </button>
      )}

      {stale && <i className="wxstrip-stale" title="Offline copy" />}
    </div>
  )
}
