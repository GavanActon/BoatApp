import { useMemo } from 'react'
import { useAppStore } from '../../state/appStore'
import { speedUnitLabel, windSpeed } from '../../units'
import { floorHourMs, isToday, startOfDayMs } from '../../time'
import {
  dayHours,
  formatPeriod,
  nextHours,
  skyLabel,
  type PointForecast,
} from '../../weather/openMeteo'
import { seaColor } from '../../weather/seaState'
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

export default function HourlyDetail({
  forecast,
  dayStartMs,
}: {
  forecast: PointForecast
  dayStartMs?: number | null
}) {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const showPeriod = useAppStore((s) => s.wavePeriod)
  const windUnit = useAppStore((s) => s.windUnit)
  const seaScale = useAppStore((s) => s.seaScaleM)
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
        <span>{showPeriod ? 'Waves · per' : 'Waves'}</span>
        <span className="hd-right">Temp · Sky</span>
      </div>
      {rows.map((r, k) => {
        // the wave number wears the ramp; nothing here grades the hour
        const selected = planHourMs != null && r.time.getTime() === planHourMs
        return (
          <div className={`hd-row${selected ? ' hd-selected' : ''}`} key={k}>
            <span className="hd-time numeral">
              {!dayMode && k === 0
                ? 'Now'
                : r.time.toLocaleTimeString(undefined, { hour: 'numeric' })}
            </span>
            <span className="hd-wind">
              <IconWindArrow deg={r.windDir + 180} size={14} />
              <b className="numeral">{windSpeed(windUnit, r.windKn)}</b> {speedUnitLabel(windUnit)}{' '}
              {compass(r.windDir)}
            </span>
            <span className="hd-gust numeral">{windSpeed(windUnit, r.gustKn)}</span>
            <span className="hd-wave">
              {r.waveM != null ? (
                <>
                  <b className="numeral" style={{ color: seaColor(r.waveM, seaScale) }}>{r.waveM.toFixed(1)}</b> m
                  {showPeriod && formatPeriod(r.wavePeriodS) && (
                    <em className="numeral"> {formatPeriod(r.wavePeriodS)}</em>
                  )}
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
