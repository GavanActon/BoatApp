import { useCallback, useEffect, useState } from 'react'
import { getMap } from '../../map/mapController'
import { useAppStore } from '../../state/appStore'
import { useGpsStore } from '../../tracking/gpsStore'
import { fetchPointForecast, type PointForecast } from '../../weather/openMeteo'
import { refreshWeatherGrid, weatherGridInfo } from '../../weather/weatherLayer'
import { IconLocate, IconRefresh } from '../icons'
import ForecastCharts from './ForecastCharts'

function ageLabel(fetchedAt: number): string {
  const min = Math.round((Date.now() - fetchedAt) / 60000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const hrs = Math.round(min / 6) / 10
  return `${hrs} h ago`
}

export default function WeatherPanel() {
  const layers = useAppStore((s) => s.layers)
  const setLayer = useAppStore((s) => s.setLayer)
  const weatherHour = useAppStore((s) => s.weatherHour)
  const setWeatherHour = useAppStore((s) => s.setWeatherHour)
  const online = useAppStore((s) => s.online)
  const fix = useGpsStore((s) => s.fix)

  const [forecast, setForecast] = useState<PointForecast | null>(null)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gridInfo, setGridInfo] = useState(weatherGridInfo())

  const load = useCallback(async (lon: number, lat: number) => {
    setLoading(true)
    setError(null)
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
    const map = getMap()
    const c = map?.getCenter()
    const lon = fix?.lon ?? c?.lng
    const lat = fix?.lat ?? c?.lat
    if (lon != null && lat != null) void load(lon, lat)
    // also refresh the map layer grid when the panel opens (cheap, cached)
    void refreshWeatherGrid().then(() => setGridInfo(weatherGridInfo()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scrubTime = new Date(Date.now() + weatherHour * 3600_000)

  return (
    <div className="panel">
      <label className="row">
        <div className="row-text">
          <span className="row-title">Wind & waves on map</span>
          <span className="row-desc">
            {gridInfo
              ? `Forecast fetched ${ageLabel(gridInfo.fetchedAt)}${gridInfo.stale ? ' · offline copy' : ''}`
              : online
                ? 'Fetches a forecast grid for the whole bay'
                : 'Offline — no cached forecast yet'}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={layers.weather}
          onChange={(e) => setLayer('weather', e.target.checked)}
        />
      </label>

      {layers.weather && (
        <div className="scrubber">
          <div className="scrubber-label">
            <span>Map time</span>
            <b className="numeral">
              {weatherHour === 0
                ? 'Now'
                : scrubTime.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })}
            </b>
          </div>
          <input
            type="range"
            min={0}
            max={48}
            step={1}
            value={weatherHour}
            onChange={(e) => setWeatherHour(Number(e.target.value))}
          />
        </div>
      )}

      <div className="panel-section fc-header">
        <span>
          7-day forecast
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

      {loading && <div className="empty">Loading forecast…</div>}
      {error && !forecast && <div className="empty">{error}</div>}
      {forecast && <ForecastCharts forecast={forecast} />}
    </div>
  )
}
