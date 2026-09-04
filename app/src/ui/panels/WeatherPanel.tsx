import { useCallback, useEffect, useState } from 'react'
import { HOME } from '../../config'
import { nearestWater } from '../../map/depthGrid'
import { getMap } from '../../map/mapController'
import { useRouteStore } from '../../routing/routeStore'
import { useAppStore } from '../../state/appStore'
import { homeCenter } from '../../state/placesStore'
import { agoLabel, dayLabel, isToday, startOfDayMs, timeLabel } from '../../time'
import { useGpsStore } from '../../tracking/gpsStore'
import {
  lastPointSource,
  marineHold,
  openMeteoLastError,
  pointWavesCarriedFrom,
  type PointForecast,
} from '../../weather/openMeteo'
import { waveOverlayStatus } from '../../weather/rdwps'
import { windOverlayStatus } from '../../weather/hrdps'
import { onWeatherGrid, pointForecastCached, refreshWeatherGrid, weatherGridInfo } from '../../weather/weatherLayer'
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
      // the panel READS: the strip polls its focus point, the weather clock
      // polls the grid, and this shows whichever of those covers the spot
      const r = await pointForecastCached(lon, lat)
      if (!r) throw new Error('no forecast yet')
      setForecast(r.forecast)
      setStale(r.stale)
    } catch {
      setError('No forecast yet — it arrives with the first weather fetch.')
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
      // no fix: the home dock, like the strip — the map centre can be land;
      // a fix on land: the nearest water, like the strip
      const home = homeCenter() ?? HOME.center
      const at = (fix && nearestWater(fix.lon, fix.lat)) || (fix ? [fix.lon, fix.lat] : home)
      void load(at[0], at[1])
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
/** When the next NEW RDWPS run reaches the app: the model runs 00/06/12/18Z,
 *  the site's scheduled fetch runs ~3¾ h later (03:45/09:45/15:45/21:45 UTC,
 *  20 min after the run's usual landing), and the app picks it up within its
 *  hourly check — so quote the fetch slot, softened with a ~. */
function nextWaveRunMs(): number {
  const slotsUtcH = [3.75, 9.75, 15.75, 21.75]
  const now = new Date()
  const dayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (const h of slotsUtcH) {
    const t = dayUtc + h * 3600_000 + 10 * 60_000 // + build & deploy minutes
    if (t > Date.now()) return t
  }
  return dayUtc + 24 * 3600_000 + slotsUtcH[0] * 3600_000 + 10 * 60_000
}

/** The weather clock refetches the grid once it's this old (weatherLayer's
 *  GRID_MAX_AGE_MS) — the wind row's "next check" is fetchedAt plus this. */
const GRID_REFRESH_MS = 30 * 60_000

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
  const wind = windOverlayStatus()
  const online = useAppStore((s) => s.online)
  const omError = openMeteoLastError()

  // both ECCC models run 4×/day and land ~3–4 h behind their stamp; past
  // ~11 h a cycle has been missed, past 18 h the app has already fallen back
  const waveDesc =
    waves.state === 'active'
      ? `RDWPS 1 km · run ${agoLabel(waves.runAgeMs)}`
      : waves.state === 'stale-run'
        ? 'RDWPS run too old — using global model'
        : 'RDWPS unavailable — using global model'
  const waveWarn = waves.state !== 'active' || waves.runAgeMs > 11 * 3600_000
  // the global model's sea (days 3–7, and the whole week when RDWPS is
  // out) is an older copy's when its host failed — say so, with the
  // reason while the host is being left alone
  const carried = pointWavesCarriedFrom() ?? grid?.wavesCarriedFrom ?? null
  const hold = marineHold()

  const windDesc =
    wind.state === 'active'
      ? `HRDPS 2.5 km · run ${agoLabel(wind.runAgeMs)} · ECCC GeoMet`
      : wind.state === 'stale-run'
        ? 'HRDPS run too old — using Open-Meteo'
        : 'ECCC GeoMet unavailable — using Open-Meteo'
  const windWarn = wind.state !== 'active' || wind.runAgeMs > 11 * 3600_000
  const pointSource = lastPointSource()

  return (
    <>
      <div className="panel-section">Data</div>
      <div className="row">
        <div className="row-text">
          <span className="row-title">Wind, gusts, temperature & sky</span>
          <span className="row-desc">{windDesc}</span>
        </div>
        <em className={windWarn ? 'age-badge stale' : 'age-badge'}>
          {wind.state === 'active'
            ? agoLabel(wind.checkedAgoMs)
            : online
              ? 'fallback'
              : 'offline'}
        </em>
      </div>
      <div className="row">
        <div className="row-text">
          <span className="row-title">{wind.state === 'active' ? 'Outlook' : 'Wind & weather'}</span>
          <span className="row-desc">
            {wind.state === 'active'
              ? 'Open-Meteo · rain chance, days 3–7'
              : 'HRDPS 2.5 km wind · Open-Meteo blend'}
          </span>
          {pointSource === 'met.no' && (
            <span className="row-desc">strip & panel from MET Norway — Open-Meteo is down</span>
          )}
          {grid && (
            <span className="row-desc">
              {grid.fetchedAt + GRID_REFRESH_MS > Date.now()
                ? `next check ${timeLabel(grid.fetchedAt + GRID_REFRESH_MS)}`
                : 'checking…'}
            </span>
          )}
          {grid?.stale && omError && (
            <span className="row-desc">{`last try ${agoLabel(Date.now() - omError.at)}: ${omError.reason}`}</span>
          )}
        </div>
        <em className={grid?.stale || !grid ? 'age-badge stale' : 'age-badge'}>
          {grid ? `${grid.stale ? 'offline copy · ' : ''}${agoLabel(Date.now() - grid.fetchedAt)}` : 'not loaded'}
        </em>
      </div>
      <div className="row">
        <div className="row-text">
          <span className="row-title">Waves</span>
          <span className="row-desc">{waveDesc}</span>
          <span className="row-desc">{`new run ~${timeLabel(nextWaveRunMs())}`}</span>
          {carried != null && (
            <span className="row-desc">
              {`global model: last good copy, ${agoLabel(Date.now() - carried)}`}
              {hold && ` · ${hold.reason}`}
            </span>
          )}
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
