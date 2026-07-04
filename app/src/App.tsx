import { useEffect, useState } from 'react'
import MapView from './map/MapView'
import { withMap } from './map/mapController'
import { useAppStore, type SheetTab } from './state/appStore'
import { useGpsStore } from './tracking/gpsStore'
import { locateAndFollow } from './tracking/gpsService'
import BottomSheet from './ui/BottomSheet'
import InstrumentBar from './ui/InstrumentBar'
import { IconCompass, IconLayers, IconLocate, IconTrack, IconWind, IconDownload } from './ui/icons'
import LayersPanel from './ui/panels/LayersPanel'
import OfflinePanel from './ui/panels/OfflinePanel'
import TracksPanel from './ui/panels/TracksPanel'
import WeatherPanel from './ui/panels/WeatherPanel'
import { initWeatherLayer } from './weather/weatherLayer'

const TABS: { id: SheetTab; name: string; icon: typeof IconLayers }[] = [
  { id: 'layers', name: 'Layers', icon: IconLayers },
  { id: 'weather', name: 'Weather', icon: IconWind },
  { id: 'tracks', name: 'Tracks', icon: IconTrack },
  { id: 'offline', name: 'Offline', icon: IconDownload },
]

function TopBar() {
  const online = useAppStore((s) => s.online)
  const offlineReady = useAppStore((s) => s.offlineReady)
  const gpsStatus = useGpsStore((s) => s.status)

  return (
    <div className="topbar">
      {!online && (
        <span className={`chip ${offlineReady ? 'chip-ok' : 'chip-warn'}`}>
          {offlineReady ? 'Offline · charts ready' : 'Offline · charts not downloaded'}
        </span>
      )}
      {gpsStatus === 'acquiring' && <span className="chip">Acquiring GPS…</span>}
      {gpsStatus === 'denied' && (
        <span className="chip chip-warn">Location denied — enable in Settings › Safari</span>
      )}
    </div>
  )
}

function FabStack() {
  const follow = useAppStore((s) => s.follow)
  const [bearing, setBearing] = useState(0)

  useEffect(() => {
    withMap((map) => {
      const update = () => setBearing(map.getBearing())
      map.on('rotate', update)
      update()
    })
  }, [])

  return (
    <div className="fabstack">
      <button
        className="fab"
        style={{ opacity: Math.abs(bearing) > 0.5 ? 1 : 0.55 }}
        onClick={() => withMap((m) => m.easeTo({ bearing: 0, pitch: 0 }))}
        aria-label="Reset north"
      >
        <IconCompass rotation={-bearing} />
      </button>
      <button
        className={`fab ${follow ? 'active' : ''}`}
        onClick={() => locateAndFollow()}
        aria-label="My position"
      >
        <IconLocate />
      </button>
    </div>
  )
}

export default function App() {
  const sheetTab = useAppStore((s) => s.sheetTab)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const setOnline = useAppStore((s) => s.setOnline)

  useEffect(() => {
    initWeatherLayer()
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [setOnline])

  const activeTab = TABS.find((t) => t.id === sheetTab)

  return (
    <div className="app">
      <MapView />
      <TopBar />
      <FabStack />

      <div className="bottombar">
        <div className="tabdock glass">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                className={`tab ${sheetTab === t.id ? 'tab-on' : ''}`}
                onClick={() => setSheetTab(sheetTab === t.id ? null : t.id)}
                aria-label={t.name}
              >
                <Icon size={20} />
                <span>{t.name}</span>
              </button>
            )
          })}
        </div>
        <InstrumentBar />
      </div>

      {activeTab && (
        <BottomSheet title={activeTab.name}>
          {sheetTab === 'layers' && <LayersPanel />}
          {sheetTab === 'weather' && <WeatherPanel />}
          {sheetTab === 'tracks' && <TracksPanel />}
          {sheetTab === 'offline' && <OfflinePanel />}
        </BottomSheet>
      )}
    </div>
  )
}
