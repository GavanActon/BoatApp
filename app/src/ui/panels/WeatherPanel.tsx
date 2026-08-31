import { useCallback, useEffect, useState } from 'react'
import { getMap } from '../../map/mapController'
import { useRouteStore } from '../../routing/routeStore'
import { useAppStore } from '../../state/appStore'
import { agoLabel, dayLabel, isToday, startOfDayMs } from '../../time'
import { useGpsStore } from '../../tracking/gpsStore'
import { fetchPointForecast, type PointForecast } from '../../weather/openMeteo'
import { waveOverlayStatus } from '../../weather/rdwps'
import { onWeatherGrid, refreshWeatherGrid, weatherGridInfo } from '../../weather/weatherLayer'
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

      <DataStatus />
    </div>
  )
}

/**
 * The data health rows — which feed the numbers above came from, how fresh,
 * and whether a silent fallback is in effect. The app degrades quietly by
 * design (a stale RDWPS run is simply not used); this is the one place that
 * says so out loud, so a dead pipeline is noticed from the boat rather than
 * from a wrong forecast. Lives at the bottom of the Weather tab: provenance
 * belongs with the forecast it explains.
 */
function DataStatus() {
  // ages tick and fetches land while the sheet is open — re-render for both
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    const off = onWeatherGrid(() => setTick((n) => n + 1))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])

  const grid = weatherGridInfo()
  const waves = waveOverlayStatus()
  const online = useAppStore((s) => s.online)

  // the model runs 4×/day and lands ~4 h behind its stamp; past ~11 h a
  // cycle has been missed, past 18 h the app has already fallen back
  const waveDesc =
    waves.state === 'active'
      ? `RDWPS 1 km · run ${agoLabel(waves.runAgeMs)}`
      : waves.state === 'stale-run'
        ? 'RDWPS run too old — using global model'
        : 'RDWPS unavailable — using global model'
  const waveWarn = waves.state !== 'active' || waves.runAgeMs > 11 * 3600_000

  return (
    <>
      <div className="panel-section">Data</div>
      <div className="row">
        <div className="row-text">
          <span className="row-title">Wind & weather</span>
          <span className="row-desc">Open-Meteo forecast grid</span>
        </div>
        <em className={grid?.stale || !grid ? 'age-badge stale' : 'age-badge'}>
          {grid ? `${grid.stale ? 'offline copy · ' : ''}${agoLabel(Date.now() - grid.fetchedAt)}` : 'not loaded'}
        </em>
      </div>
      <div className="row">
        <div className="row-text">
          <span className="row-title">Waves</span>
          <span className="row-desc">{waveDesc}</span>
        </div>
        <em className={waveWarn ? 'age-badge stale' : 'age-badge'}>
          {waves.state === 'active'
            ? agoLabel(waves.checkedAgoMs)
            : online
              ? 'fallback'
              : 'offline'}
        </em>
      </div>
    </>
  )
}
