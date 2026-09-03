import { useEffect, useMemo, useRef, useState } from 'react'
import { HOME } from '../config'
import { nearestWater } from '../map/depthGrid'
import { homeCenter, usePlacesStore } from '../state/placesStore'
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
import { onWindOverlay } from '../weather/hrdps'
import { onWeatherGrid, onWeatherHour, pointForecastCached } from '../weather/weatherLayer'
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
// The visible row holds exactly ten cells (.wxcell is sized at a tenth of the
// row, see ui.css) — so TODAY must keep at least ten hours in hand. With
// fewer, the row stops short of the strip's edge and the leftover width reads
// as missing hours, which is exactly what it is.
const HOURS_IN_HAND = 10
const REFRESH_MS = 30 * 60_000

function hourLabel(d: Date): string {
  const h = d.getHours()
  return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`
}

/** The window's effective ends — the same "asked-for wins over worked-out"
 *  derivation the card's chips show (TripCard.WindowChips), for the effects
 *  that read imperatively. */
function effectiveEnd(end: 'out' | 'back'): number | null {
  const s = useAppStore.getState()
  const plan = useRouteStore.getState().plan
  return end === 'back'
    ? (s.planEndMs ?? plan?.homeMs ?? null)
    : (s.planTimeMs ?? plan?.departMs ?? null)
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
  const picked = useAppStore((s) => s.planPicked)
  const armedEnd = useAppStore((s) => s.armedEnd)
  const setArmedEnd = useAppStore((s) => s.setArmedEnd)
  const showPeriod = useAppStore((s) => s.wavePeriod)
  const windUnit = useAppStore((s) => s.windUnit)
  const online = useAppStore((s) => s.online)
  const seaScale = useAppStore((s) => s.seaScaleM)
  // the first fix arrives after mount; without a pinned start it IS the
  // trip's start, so the strip has to come off home waters when it lands
  const hasFix = useGpsStore((s) => s.fix != null)
  const homeName = usePlacesStore((s) => s.homeName)
  const focusPoint = useRouteStore((s) => s.focusPoint)
  const setFocusPoint = useRouteStore((s) => s.setFocusPoint)
  const destination = useRouteStore((s) => s.destination)
  const startPoint = useRouteStore((s) => s.startPoint)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const plan = useRouteStore((s) => s.plan)

  const [forecast, setForecast] = useState<PointForecast | null>(null)
  const [stale, setStale] = useState(false)
  // for the grid-land retry below: reload only while stale or empty
  const staleRef = useRef(true)
  useEffect(() => {
    staleRef.current = stale || !forecast
  }, [stale, forecast])
  // which coords the strip last painted, so the cache-first paint below runs
  // once per subject rather than flashing the stale dot on every refresh tick
  const paintedKeyRef = useRef<string | null>(null)

  // While a window chip is armed, day taps steer the KEYPAD — which day's
  // hours are offered — without touching the plan. That is what makes a
  // multi-day window possible: arm Back, tap Sunday, pick an hour.
  const [armDayMs, setArmDayMs] = useState<number | null>(null)
  useEffect(() => {
    if (!armedEnd) {
      setArmDayMs(null) // disarming forgets the keypad's day
      return
    }
    // arming opens the keypad on the day holding that end's current pick —
    // the time being moved is the reference, so it must be on screen
    const ms = effectiveEnd(armedEnd)
    if (ms != null) setArmDayMs(startOfDayMs(ms))
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
      // No fix (a desktop, a phone that said no): the HOME DOCK, not the map
      // centre — a centre that happens to sit over land has no sea at all,
      // and the strip read "no wave data" while the map showed it fine.
      const home = homeCenter() ?? HOME.center
      let lon = focusPoint?.lon ?? departFrom?.lon ?? fix?.lon ?? home[0]
      let lat = focusPoint?.lat ?? departFrom?.lat ?? fix?.lat ?? home[1]
      // a fix on land (the phone in town) has no sea of its own: the
      // nearest water is the shore you'd launch from, and has a forecast
      if (!focusPoint && !departFrom && fix) {
        const w = nearestWater(lon, lat)
        if (w) [lon, lat] = w
      }
      const key = `${lon.toFixed(2)},${lat.toFixed(2)}`
      // Last-known first: paint the disk copy for this subject immediately
      // (stale dot showing), so the strip has numbers in the first paint
      // instead of arriving last behind the whole startup fetch queue — and
      // with no disk copy, a point cut from the regional grid, which is the
      // app's last-known truth and carries ECCC's wind and sea. The network
      // result below swaps it out.
      const lastKnown = async (force = false) => {
        const r = await pointForecastCached(lon, lat)
        if (alive && r && (force || paintedKeyRef.current !== key)) {
          paintedKeyRef.current = key
          setForecast(r.forecast)
          setStale(true)
        }
      }
      try {
        if (paintedKeyRef.current !== key) await lastKnown()
        // a few minutes of freshness dedupes the launch double-fetch (map
        // center first, then the same spot again when the GPS fix lands)
        const { forecast: fc, stale: st } = await fetchPointForecast(lon, lat, 5 * 60_000)
        if (alive) {
          paintedKeyRef.current = key
          setForecast(fc)
          setStale(st)
        }
      } catch {
        // Open-Meteo down AND nothing on disk for this spot (a new place, a
        // fresh install): the grid's point is far better than a blank strip.
        // The grid may not exist yet either — onWeatherGrid below retries.
        try {
          await lastKnown(true)
        } catch {
          /* keep whatever we had */
        }
      }
    }
    void load()
    const t = setInterval(() => void load(), REFRESH_MS)
    // and at each top of the hour: the Now cell floors to the current hour,
    // so the boundary is when yesterday's row would otherwise linger
    const offHour = onWeatherHour(() => void load())
    // and when ECCC's HRDPS wind lands (seconds after launch, or a new run
    // later): the fetch dedupes against the fresh cache and re-dresses it,
    // so the strip and the map quote the same wind
    const offWind = onWindOverlay(() => void load())
    // and when a grid lands while the strip is still stale or empty — the
    // outage case: Open-Meteo's point call failed, the grid (from disk, or
    // from a later successful fetch) is the strip's fallback
    const offGrid = onWeatherGrid(() => {
      if (staleRef.current) void load()
    })
    return () => {
      alive = false
      clearInterval(t)
      offHour()
      offWind()
      offGrid()
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
  // from midnight — and the row scrolls to reach it all. When the rest of
  // today can't fill the visible row (a full afternoon, not just the late
  // evening this rule began as), it continues into tomorrow until a whole
  // row of hours is in hand — the water doesn't stop at midnight, and
  // neither does leaving.
  const rows: HourRow[] = useMemo(() => {
    if (!forecast) return []
    if (selDayMs !== todayMs) return dayHours(forecast, selDayMs, 0, 23)
    const today = dayHours(forecast, todayMs, new Date().getHours(), 23)
    const deficit = HOURS_IN_HAND - today.length
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
  const placedRef = useRef<string | null>(null)
  useEffect(() => {
    const el = cellsRef.current
    if (!el || rows.length === 0) return
    // re-place when the day changes AND when a chip arms or disarms: the
    // armed end's existing pick is what the keypad should open looking at
    const key = `${selDayMs}|${armedEnd ?? ''}`
    if (placedRef.current === key) return
    placedRef.current = key
    const targetMs = armedEnd != null ? effectiveEnd(armedEnd) : useAppStore.getState().planTimeMs
    const targetHour = targetMs == null ? null : floorHourMs(targetMs)
    let idx =
      targetHour != null ? rows.findIndex((r) => r.time.getTime() === targetHour) : -1
    if (idx < 0 && selDayMs !== todayMs) {
      idx = rows.findIndex((r) => r.time.getHours() === DAY_FROM_H)
    }
    const cell = el.children[Math.max(0, idx)] as HTMLElement | undefined
    const first = el.children[0] as HTMLElement | undefined
    if (cell && first) el.scrollLeft = Math.max(0, cell.offsetLeft - first.offsetLeft)
  }, [selDayMs, todayMs, rows, armedEnd])

  if (!show || (rows.length === 0 && days.length === 0)) return null

  const planHourMs = planTimeMs == null ? null : floorHourMs(planTimeMs)

  // The planned window, drawn where the hours live: the strip marks the
  // departure (the active cell), the return, and every hour between — so
  // leaving AND coming back read straight off the strip instead of only off
  // the card's chips. The ends are derived EXACTLY as the chips derive them
  // (TripCard.WindowChips): what you asked for wins over what the last plan
  // worked out — so a back time the planner filled in ("there 3 hours")
  // lights its tile the same as one you picked. Ghosted while exploring,
  // like the chips — and drawn only when there is a TRIP to come back from:
  // a time tap with nothing on the chart is a weather preview, not a window
  // (§4.1: the chips carry the trip's window), so no return tile without a
  // destination.
  const backSrcMs =
    picked && destination != null ? (planEndMs ?? plan?.homeMs ?? null) : null
  const backHourMs = backSrcMs == null ? null : floorHourMs(backSrcMs)
  const outHourMs =
    backHourMs == null ? null : floorHourMs(planTimeMs ?? plan?.departMs ?? Date.now())
  const outDayMs = outHourMs == null ? null : startOfDayMs(outHourMs)
  const backDayMs = backHourMs == null ? null : startOfDayMs(backHourMs)

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

      {/* no fix and no home dock: these numbers are for a default nobody
          chose — say so where it bites, and make the fix one tap */}
      {!focusPoint && !departFrom && !hasFix && !homeName && (
        <button
          className="wxstrip-focus wxstrip-nudge"
          onClick={() => {
            useAppStore.getState().setSheetTab(null)
            useAppStore.getState().setPickingHome(true)
          }}
          aria-label="Forecast is for the default home — tap to star your home dock on the chart"
        >
          <IconPin size={11} />
          <span>Star your home dock</span>
        </button>
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
          const inWindow =
            outDayMs != null && d.dayStartMs >= outDayMs && d.dayStartMs <= backDayMs!
          return (
            <button
              key={d.dayStartMs}
              className={`wxday${sel ? ' wxday-on' : ''}${inWindow ? ' wxday-window' : ''}`}
              style={{ borderTopColor: seaColor(wx?.waveMaxM ?? null, seaScale) }}
              onClick={() => pickDay(d.dayStartMs)}
              role="tab"
              aria-selected={sel}
              aria-label={`${dayLabel(d.dayStartMs)}: ${
                wx?.waveMaxM != null ? `${seaName(wx.waveMaxM, seaScale)}, ${wx.waveMaxM.toFixed(1)} metres` : 'no wave data'
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
        <div
          className={`wxstrip-cells${armedEnd ? ` wx-arm-${armedEnd}` : ''}`}
          ref={cellsRef}
        >
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
            // Every hour is on offer while a chip is armed. Fences used to
            // grey out hours past the other end, which made multi-day picks
            // impossible; now an inconsistent pick simply CARRIES the other
            // end along, keeping the window's span — the way dragging the
            // departure always has.
            const armable = armedEnd != null
            const inWindow = outHourMs != null && cellMs >= outHourMs && cellMs <= backHourMs!
            const isBack = backHourMs != null && cellMs === backHourMs
            const period = showPeriod ? formatPeriod(r.wavePeriodS) : null
            const wxText =
              `wind ${windSpeed(windUnit, r.windKn)} ${speedUnitLabel(windUnit)}, waves ${r.waveM != null ? r.waveM.toFixed(1) : 'unknown'} metres` +
              (showPeriod && r.wavePeriodS != null ? ` at ${Math.round(r.wavePeriodS)} seconds` : '') +
              (r.weatherCode >= 95 ? ', thunder' : '')
            return (
              <button
                key={cellMs}
                className={`wxcell${active ? ' wx-active' : ''}${isBack ? ' wx-back' : ''}${inWindow ? ' wx-window' : ''}${armable ? ' wx-armable' : ''}`}
                style={{ borderTopColor: seaColor(r.waveM, seaScale) }}
                onClick={() => {
                  // any accepted time-tap moves the app from exploring to
                  // planning — including "Now", which is a choice, not a default
                  setPlanPicked(true)
                  if (armedEnd) {
                    const span =
                      planTimeMs != null && planEndMs != null
                        ? planEndMs - planTimeMs
                        : useAppStore.getState().usualOutingMin * 60_000
                    if (armedEnd === 'out') {
                      // out past the current back? back comes along, span kept
                      setPlanWindow(
                        cellMs,
                        planEndMs != null && cellMs < planEndMs ? planEndMs : cellMs + span,
                      )
                    } else {
                      // back before the current out? out follows, span kept
                      setPlanWindow(
                        planTimeMs != null && cellMs > planTimeMs ? planTimeMs : cellMs - span,
                        cellMs,
                      )
                    }
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
                  (rating?.stayMin != null ? `, ${durationLabel(rating.stayMin)} there` : '') +
                  (active && backHourMs != null ? ', planned departure' : '') +
                  (isBack ? ', planned return' : '')
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
        <button
          className={`wxstrip-arm${armedEnd === 'back' ? ' wxstrip-arm-back' : ''}`}
          onClick={() => setArmedEnd(null)}
        >
          Pick {armedEnd === 'back' ? 'the back hour' : 'the out hour'} · cancel
        </button>
      )}

      {stale && <i className="wxstrip-stale" title="Offline copy" />}
    </div>
  )
}
