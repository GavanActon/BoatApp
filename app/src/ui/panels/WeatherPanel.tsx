import { useCallback, useEffect, useState } from 'react'
import { getMap } from '../../map/mapController'
import { useRouteStore } from '../../routing/routeStore'
import { useAppStore } from '../../state/appStore'
import { dayLabel, isToday, startOfDayMs } from '../../time'
import { useGpsStore } from '../../tracking/gpsStore'
import { fetchPointForecast, type PointForecast } from '../../weather/openMeteo'
import { refreshWeatherGrid } from '../../weather/weatherLayer'
import { IconLocate, IconRefresh } from '../icons'
import ForecastCharts from './ForecastCharts'
import HourlyDetail from './HourlyDetail'
import SevenDay from './SevenDay'

/**
 * Pure forecast reference, deepest first. The seven days lead — which day is
 * worth going out is the question the tab gets asked — and picking one drops
 * the hourly table beneath it into that day. The charts under that are the
 * same week as a trend, for reading how a change arrives.
 *
 * Time is picked here or on the outlook strip (the same app-wide planning
 * time); map-overlay toggles live in Layers.
 */

function ageLabel(fetchedAt: number): string {
  const min = Math.round((Date.now() - fetchedAt) / 60000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const hrs = Math.round(min / 6) / 10
  return `${hrs} h ago`
}

export default function WeatherPanel() {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const fix = useGpsStore((s) => s.fix)

  const [forecast, setForecast] = useState<PointForecast | null>(null)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // named only when the forecast is somewhere other than here (a trip's
  // pinned start); the locate button swings it back
  const [spot, setSpot] = useState<string | null>(null)

  const load = useCallback(async (lon: number, lat: number, label: string | null = null) => {
    setLoading(true)
    setError(null)
    setSpot(label)
    try {
      const { forecast: fc, stale: st } = await fetchPointForecast(lon, lat)
      setForecast(fc)
      setStale(st)
    } catch {
      setError('No forecast available — connect to the internet once to fetch it.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // a trip planned from a pinned start opens on the DEPARTURE point —
    // that is the weather the trip is rated against, and the ramp can be an
    // hour from the phone by road. Under way the boat is the start already.
    const rs = useRouteStore.getState()
    const from = rs.destination && rs.tripStartedAt == null ? rs.startPoint : null
    if (from) {
      void load(from.lon, from.lat, from.name ?? 'Pinned start')
    } else {
      const c = getMap()?.getCenter()
      const lon = fix?.lon ?? c?.lng
      const lat = fix?.lat ?? c?.lat
      if (lon != null && lat != null) void load(lon, lat)
    }
    // also refresh the map layer grid when the panel opens (cheap, cached)
    void refreshWeatherGrid()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selDayMs = startOfDayMs(planTimeMs ?? Date.now())

  return (
    <div className="panel">
      <div className="panel-section panel-section-first fc-header">
        <span>
          7-day forecast
          {spot && <em className="age-badge">at {spot}</em>}
          {forecast && (
            <em className={stale ? 'age-badge stale' : 'age-badge'}>
              {stale ? `offline · ${ageLabel(forecast.fetchedAt)}` : ageLabel(forecast.fetchedAt)}
            </em>
          )}
        </span>
        <span className="fc-actions">
          {fix && (
            <button
              className="icon-btn"
              onClick={() => void load(fix.lon, fix.lat)}
              aria-label="Forecast at my position"
            >
              <IconLocate size={18} />
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => {
              const c = getMap()?.getCenter()
              if (c) void load(c.lng, c.lat)
            }}
            aria-label="Refresh forecast"
          >
            <IconRefresh size={18} />
          </button>
        </span>
      </div>

      {loading && !forecast && <div className="empty">Loading forecast…</div>}
      {error && !forecast && <div className="empty">{error}</div>}

      {forecast && (
        <>
          <SevenDay forecast={forecast} />

          <div className="panel-section">
            {isToday(selDayMs) ? 'Next 12 hours' : `${dayLabel(selDayMs)} hour by hour`}
          </div>
          <HourlyDetail forecast={forecast} dayStartMs={selDayMs} />

          <div className="panel-section">Wind &amp; wave trend</div>
          <ForecastCharts forecast={forecast} />
        </>
      )}
    </div>
  )
}
