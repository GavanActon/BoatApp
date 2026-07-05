import { useMemo } from 'react'
import { useAppStore } from '../../state/appStore'
import { floorHourMs, isToday, startOfDayMs } from '../../time'
import { conditionFor, dayHours, nextHours, type PointForecast } from '../../weather/openMeteo'
import { IconWindArrow } from '../icons'

/**
 * Hour-by-hour detail: wind + direction, gusts, waves + period, temperature
 * and sky. Shows the next 12 hours by default; given a `dayStartMs` on
 * another day it shows that day's daytime hours instead. The row matching
 * the app-wide planning time is highlighted.
 */

const DETAIL_HOURS = 12
const DAY_FROM_H = 6
const DAY_TO_H = 21

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

function compass(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16]
}

function skyLabel(code: number): string {
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

export default function HourlyDetail({
  forecast,
  dayStartMs,
}: {
  forecast: PointForecast
  dayStartMs?: number | null
}) {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const dayMode = dayStartMs != null && !isToday(dayStartMs)

  const rows = useMemo(
    () =>
      dayMode
        ? dayHours(forecast, startOfDayMs(dayStartMs), DAY_FROM_H, DAY_TO_H)
        : nextHours(forecast, DETAIL_HOURS),
    [forecast, dayMode, dayStartMs],
  )

  if (!rows.length) return null

  const planHourMs = planTimeMs == null ? null : floorHourMs(planTimeMs)

  return (
    <div className="hd-table">
      <div className="hd-row hd-head">
        <span>Time</span>
        <span>Wind</span>
        <span>Gust</span>
        <span>Waves</span>
        <span className="hd-right">Temp · Sky</span>
      </div>
      {rows.map((r, k) => {
        const rough = conditionFor(r.windKn, r.gustKn, r.waveM) === 'rough'
        const selected = planHourMs != null && r.time.getTime() === planHourMs
        return (
          <div className={`hd-row${selected ? ' hd-selected' : ''}`} key={k}>
            <span className="hd-time numeral">
              {!dayMode && k === 0
                ? 'Now'
                : r.time.toLocaleTimeString(undefined, { hour: 'numeric' })}
            </span>
            <span className={rough ? 'hd-wind warn' : 'hd-wind'}>
              <IconWindArrow deg={r.windDir + 180} size={14} />
              <b className="numeral">{Math.round(r.windKn)}</b> kn {compass(r.windDir)}
            </span>
            <span className="hd-gust numeral">{Math.round(r.gustKn)}</span>
            <span className={rough ? 'hd-wave warn' : 'hd-wave'}>
              {r.waveM != null ? (
                <>
                  <b className="numeral">{r.waveM.toFixed(1)}</b> m
                  {r.wavePeriodS != null && <em className="numeral"> {Math.round(r.wavePeriodS)}s</em>}
                </>
              ) : (
                '—'
              )}
            </span>
            <span className="hd-right">
              <b className="numeral">{Math.round(r.tempC)}°</b> <em>{skyLabel(r.weatherCode)}</em>
            </span>
          </div>
        )
      })}
    </div>
  )
}
