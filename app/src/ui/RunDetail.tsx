import { useEffect, useState } from 'react'
import { useRouteStore } from '../routing/routeStore'
import { compass, type TripPhase, type TripSample } from '../routing/tripPlan'
import { useAppStore } from '../state/appStore'
import { dayLabel, isToday, startOfDayMs, timeLabel } from '../time'
import { speedUnitLabel, windSpeed } from '../units'
import { formatPeriod, type PointForecast } from '../weather/openMeteo'
import { pointForecastCached } from '../weather/weatherLayer'
import { IconWindArrow } from './icons'
import HourlyDetail from './panels/HourlyDetail'

/**
 * The run leg by leg, each with its wind and water at the minute the boat is
 * there, and each leg's full-day forecast a tap away.
 *
 * This lived in the route drawer until the dock grew its raised detent; the
 * drawer is gone and this is what was worth keeping from it. The verdict
 * card that used to sit above it is not — its facts (leaving, there, back,
 * distance) already live on the docked card.
 */

function phaseLabel(phase: TripPhase, destName: string | null): string {
  switch (phase) {
    case 'depart':
      return 'Leave'
    case 'outbound':
      return 'En route'
    case 'arrive':
      return destName ?? 'Destination'
    case 'return':
      return 'Heading back'
    case 'home':
      return 'Back'
  }
}

function TimelineRow({
  s,
  destName,
  expanded,
  onToggle,
}: {
  s: TripSample
  destName: string | null
  expanded: boolean
  onToggle: () => void
}) {
  const showPeriod = useAppStore((s) => s.wavePeriod)
  const windUnit = useAppStore((s) => s.windUnit)
  return (
    <button
      className={`trip-row ${expanded ? 'trip-expanded' : ''}`}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={phaseLabel(s.phase, destName)}
    >
      <span className="trip-time numeral">{timeLabel(s.atMs)}</span>
      <span className="trip-phase">{phaseLabel(s.phase, destName)}</span>
      <span className="hd-wind">
        <IconWindArrow deg={s.windDir + 180} size={14} />
        <b className="numeral">{windSpeed(windUnit, s.windKn)}</b> {speedUnitLabel(windUnit)}{' '}
        {compass(s.windDir)}
      </span>
      <span className="hd-wave">
        {s.waveM != null ? (
          <>
            <b className="numeral">{s.waveM.toFixed(1)}</b> m
            {showPeriod && formatPeriod(s.wavePeriodS) && (
              <em className="numeral"> {formatPeriod(s.wavePeriodS)}</em>
            )}
          </>
        ) : (
          '—'
        )}
      </span>
    </button>
  )
}

/** Hourly forecast for one leg's location on the trip's day, expanded under its row. */
function LegForecast({ lon, lat, atMs }: { lon: number; lat: number; atMs: number }) {
  const [fc, setFc] = useState<PointForecast | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setFc(null)
    setFailed(false)
    // off the cache, never the network — the leg's water is on the grid
    void pointForecastCached(lon, lat).then((r) => {
      if (!alive) return
      if (r) setFc(r.forecast)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [lon, lat])

  return (
    <div className="leg-forecast">
      <div className="leg-forecast-title">{isToday(atMs) ? 'Today here' : `${dayLabel(atMs)} here`}</div>
      {fc ? (
        <HourlyDetail forecast={fc} dayStartMs={startOfDayMs(atMs)} />
      ) : (
        <div className="empty">{failed ? 'Offline' : '…'}</div>
      )}
    </div>
  )
}

export default function RunDetail() {
  const plan = useRouteStore((s) => s.plan)
  const planning = useRouteStore((s) => s.planning)
  const planError = useRouteStore((s) => s.planError)
  const viaPoints = useRouteStore((s) => s.viaPoints)
  const setViaPoints = useRouteStore((s) => s.setViaPoints)
  // which leg is open to its day forecast — the run's own business now, not
  // the route store's; a new plan starts with every row folded
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  useEffect(() => setExpandedIdx(null), [plan])

  if (!plan) return <div className="empty">{planning ? '…' : (planError ?? '—')}</div>

  return (
    <div className="run-detail">
      {viaPoints.length > 0 && (
        <div className="route-edit-note">
          <button className="linklike" onClick={() => setViaPoints([])}>
            Reset course
          </button>
        </div>
      )}
      <div className="trip-table">
        {plan.samples.map((s, k) => (
          <div key={k}>
            <TimelineRow
              s={s}
              destName={plan.destName}
              expanded={expandedIdx === k}
              onToggle={() => setExpandedIdx(expandedIdx === k ? null : k)}
            />
            {expandedIdx === k && <LegForecast lon={s.lon} lat={s.lat} atMs={s.atMs} />}
          </div>
        ))}
      </div>
    </div>
  )
}
