import { useEffect, useRef, useState } from 'react'
import MapView from './map/MapView'
import { withMap } from './map/mapController'
import { REGION_BBOX } from './config'
import { useAppStore, type SheetTab } from './state/appStore'
import { distanceUnitFor, runDistance } from './units'
import { useGpsStore, type Fix } from './tracking/gpsStore'
import { locateAndFollow, startGps } from './tracking/gpsService'
import { initRouteLayer } from './routing/routeLayer'
import { initRoutePlanner } from './routing/planner'
import { useRouteStore } from './routing/routeStore'
import { initMeasureLayer } from './measure/measureLayer'
import { useMeasureStore } from './measure/measureStore'
import { dayShort, dayTimeLabel, isToday, timeLabel } from './time'
import BottomSheet from './ui/BottomSheet'
import InstrumentBar from './ui/InstrumentBar'
import MeasureCard from './ui/MeasureCard'
import {
  IconCompass,
  IconEditRoute,
  IconLayers,
  IconLocate,
  IconRuler,
  IconSliders,
  IconTrack,
  IconWind,
  IconDownload,
  IconDownloadDone,
  IconPlaces,
} from './ui/icons'
import LayersPanel from './ui/panels/LayersPanel'
import PlacesPanel from './ui/panels/PlacesPanel'
import OfflinePanel from './ui/panels/OfflinePanel'
import TracksPanel from './ui/panels/TracksPanel'
import WeatherPanel from './ui/panels/WeatherPanel'
import TripCard from './ui/TripCard'
import WeatherStrip from './ui/WeatherStrip'
import { acknowledgeWxShift, initForecastWatch } from './weather/forecastWatch'
import { initWeatherLayer, onWeatherGrid, weatherGridInfo } from './weather/weatherLayer'
import { initWindFlow } from './weather/windFlow'
import { initSeaFlow } from './weather/waveFlow'

// auto-follow waits for a fix at least this tight before trusting it…
const GOOD_FIX_ACCURACY_M = 150
// …but takes the best available once the deadline passes
const FOLLOW_DECIDE_TIMEOUT_MS = 10000

// No Trip tab: the dock IS the trip surface, and it is always present (§2.5)
const TABS: { id: SheetTab; name: string; icon: typeof IconLayers }[] = [
  // Places first: WHICH PLACE is the question the app opens on (§0.2) — this
  // tab superseded the dock's old "Here" bar
  { id: 'places', name: 'Places', icon: IconPlaces },
  // still id 'layers' everywhere in code — only the name on the door changed
  { id: 'layers', name: 'Settings', icon: IconSliders },
  { id: 'weather', name: 'Weather', icon: IconWind },
  { id: 'tracks', name: 'Tracks', icon: IconTrack },
  { id: 'offline', name: 'Offline', icon: IconDownload },
]

/** Guides map-picking, and stands in for a dismissed trip card — tapping it
 *  brings the card back. While the card is up it says nothing the card
 *  doesn't. */
function TripChip() {
  const editing = useRouteStore((s) => s.editing)
  const setEditing = useRouteStore((s) => s.setEditing)
  const picking = useRouteStore((s) => s.picking)
  const setPicking = useRouteStore((s) => s.setPicking)
  const card = useRouteStore((s) => s.card)
  const setCard = useRouteStore((s) => s.setCard)
  const destination = useRouteStore((s) => s.destination)
  const plan = useRouteStore((s) => s.plan)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const measuring = useMeasureStore((s) => s.active)

  if (editing) {
    return (
      <button className="chip chip-accent" onClick={() => setEditing(false)}>
        Editing course · done
      </button>
    )
  }
  if (picking) {
    return (
      <button className="chip chip-accent" onClick={() => setPicking(null)}>
        Set {picking === 'start' ? 'start' : 'destination'} · cancel
      </button>
    )
  }
  // the trip card is already saying all of this at the bottom of the map —
  // unless the ruler has borrowed its spot, in which case the chip stands in
  if (card && !measuring) return null
  if (!destination || !plan) return null

  const underWay = tripStartedAt != null
  const name = destination.name ?? 'Pinned spot'
  // Facts, not a grade. This chip used to read "Gros Cap: good to go" in
  // green — the app's loudest opinion, on the busiest part of the screen.
  const dist = `${runDistance(speedUnit, plan.oneWayNm)} ${distanceUnitFor(speedUnit)}`
  const text = underWay
    ? `${name} · ${dist} to go · there ${timeLabel(plan.arriveMs)}`
    : `${isToday(plan.departMs) ? '' : `${dayShort(plan.departMs)} · `}${name} · ${dist} · there ${dayTimeLabel(plan.arriveMs)}`
  return (
    <button className="chip" onClick={() => setCard('trip')}>
      {text}
    </button>
  )
}

/** Every number on screen is only as good as its fetch. Quiet until the
 *  forecast is genuinely old (refreshes normally land every 30 min, so hours
 *  of age mean fetches are FAILING — flaky cell, dead API); then it says so
 *  where decisions are being made. Tapping opens the Weather tab, whose Data
 *  rows carry the details. */
function ForecastAgeChip() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    const off = onWeatherGrid(() => setTick((n) => n + 1))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])
  const info = weatherGridInfo()
  const ageMs = info ? Date.now() - info.fetchedAt : 0
  if (ageMs < 3 * 3600_000) return null
  return (
    <button
      className="chip chip-warn"
      onClick={() => useAppStore.getState().setSheetTab('weather')}
    >
      Forecast {Math.round(ageMs / 3600_000)} h old
    </button>
  )
}

/** The forecast-shift alert: a fresh model run moved the hours the user
 *  cares about. Tapping opens the Weather tab and accepts the new picture
 *  as the baseline. */
function ShiftChip() {
  const wxShift = useAppStore((s) => s.wxShift)
  if (!wxShift) return null
  return (
    <button
      className="chip chip-warn"
      onClick={() => {
        useAppStore.getState().setSheetTab('weather')
        acknowledgeWxShift()
      }}
    >
      {wxShift}
    </button>
  )
}

function TopBar() {
  const online = useAppStore((s) => s.online)
  const offlineReady = useAppStore((s) => s.offlineReady)
  const missingCharts = useAppStore((s) => s.missingCharts)
  const gpsStatus = useGpsStore((s) => s.status)
  const gpsError = useGpsStore((s) => s.lastError)

  return (
    <div className="topbar">
      {!online && (
        <span className={`chip ${offlineReady ? 'chip-ok' : 'chip-warn'}`}>
          {offlineReady ? 'Offline · charts ready' : 'Offline · charts not downloaded'}
        </span>
      )}
      {missingCharts.length > 0 && (
        <span className="chip chip-warn">
          {missingCharts.join(', ')} didn't load — re-download in Offline
        </span>
      )}
      <ForecastAgeChip />
      <ShiftChip />
      {gpsStatus === 'acquiring' && <span className="chip">Acquiring GPS…</span>}
      {gpsStatus === 'denied' && (
        <span className="chip chip-warn">Location denied — allow location for this site</span>
      )}
      {gpsStatus === 'insecure' && (
        <span className="chip chip-warn">No location over plain http — open this on localhost or https</span>
      )}
      {gpsStatus === 'error' && (
        <span className="chip chip-warn">
          {gpsError ? `No GPS fix — ${gpsError}` : 'No GPS fix — still searching…'}
        </span>
      )}
      <TripChip />
    </div>
  )
}

function FabStack() {
  const follow = useAppStore((s) => s.follow)
  const measuring = useMeasureStore((s) => s.active)
  const route = useRouteStore((s) => s.route)
  const editing = useRouteStore((s) => s.editing)
  const setEditing = useRouteStore((s) => s.setEditing)
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
      {route && (
        <button
          className={`fab ${editing ? 'active' : ''}`}
          onClick={() => {
            if (editing) return setEditing(false)
            // one map gesture owner at a time — the ruler does the same to us
            useMeasureStore.getState().stop()
            useAppStore.getState().setSheetTab(null)
            useRouteStore.getState().setPicking(null)
            setEditing(true)
          }}
          aria-label={editing ? 'Done editing the course' : 'Edit the course'}
        >
          <IconEditRoute />
        </button>
      )}
      <button
        className={`fab ${measuring ? 'active' : ''}`}
        onClick={() => {
          if (measuring) return useMeasureStore.getState().stop()
          // the map needs to be tappable: put the sheet, pick mode and the
          // course editor away
          useAppStore.getState().setSheetTab(null)
          useRouteStore.getState().setPicking(null)
          useRouteStore.getState().setEditing(false)
          useMeasureStore.getState().start()
        }}
        aria-label="Measure distance"
      >
        <IconRuler />
      </button>
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
        // a toggle, not a one-way switch: pressing it while following lets go
        onClick={() => (follow ? useAppStore.getState().setFollow(false) : locateAndFollow())}
        aria-label={follow ? 'Stop following my position' : 'My position'}
      >
        <IconLocate />
      </button>
    </div>
  )
}

export default function App() {
  const sheetTab = useAppStore((s) => s.sheetTab)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const offlineReady = useAppStore((s) => s.offlineReady)
  const setOnline = useAppStore((s) => s.setOnline)
  const measuring = useMeasureStore((s) => s.active)
  const destination = useRouteStore((s) => s.destination)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const barRef = useRef<HTMLDivElement>(null)

  // Planning a run, the dock IS the screen's business and the tabs are five
  // ways to leave it. They come back the moment the trip is cleared — the
  // dock's ✕ is the way out, and it's the only one that needs to be there.
  // A sheet somehow open keeps them, so nothing can strand itself.
  const routing = destination != null && tripStartedAt == null && sheetTab == null

  // the FABs ride just above the bottom bar, which grows and shrinks with the
  // card docked in it — publish its height so CSS can follow along
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--barh', `${Math.round(el.offsetHeight)}px`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    initWeatherLayer()
    initRouteLayer()
    initMeasureLayer() // after the route layer, so measurements draw on top
    initRoutePlanner()
    initWindFlow()
    initSeaFlow()
    initForecastWatch()

    // grab a position right away; follow it only when it's on our waters.
    // the first fix is often a coarse wifi/IP guess, so hold out for an
    // accurate one — falling back to whatever we have at the deadline —
    // before deciding whether to follow
    startGps()
    let decided = false
    const decide = (fix: Fix | null) => {
      if (decided || !fix) return
      decided = true
      unsubGps()
      clearTimeout(decideTimer)
      // a good fix can arrive minutes into the session on a phone — by then
      // the user may already be looking at a place or planning a run, and
      // yanking the camera to the boat mid-thought is exactly the "GPS pulls
      // me home" bug. Auto-follow only claims a camera nobody has pointed.
      const rs = useRouteStore.getState()
      if (rs.focusPoint != null || rs.destination != null) return
      const b = REGION_BBOX
      if (fix.lon >= b.west && fix.lon <= b.east && fix.lat >= b.south && fix.lat <= b.north) {
        locateAndFollow()
      }
    }
    const unsubGps = useGpsStore.subscribe((s) => {
      if (s.fix && s.fix.accuracy <= GOOD_FIX_ACCURACY_M) decide(s.fix)
    })
    const decideTimer = window.setTimeout(
      () => decide(useGpsStore.getState().fix),
      FOLLOW_DECIDE_TIMEOUT_MS,
    )

    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      unsubGps()
      clearTimeout(decideTimer)
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [setOnline])

  const activeTab = TABS.find((t) => t.id === sheetTab)

  return (
    <div className="app">
      <MapView />
      <div className="toparea">
        <WeatherStrip />
        <TopBar />
      </div>
      <FabStack />

      <div className="bottombar" ref={barRef}>
        {/* one card at a time in the dock — measuring borrows the trip's spot */}
        {measuring ? <MeasureCard /> : <TripCard />}
        {!routing && (
          <div className="tabdock glass">
            {TABS.map((t) => {
              // once the region's charts are all aboard, the Offline tab says
              // so at a glance: the download arrow becomes a check and the
              // label reads "On board" — nobody should wonder at the dock
              // whether they remembered to download
              const ready = t.id === 'offline' && offlineReady
              const Icon = ready ? IconDownloadDone : t.icon
              return (
                <button
                  key={t.id}
                  className={`tab ${sheetTab === t.id ? 'tab-on' : ''}${ready ? ' tab-ready' : ''}`}
                  onClick={() => setSheetTab(sheetTab === t.id ? null : t.id)}
                  aria-label={ready ? 'Offline charts downloaded' : t.name}
                >
                  <Icon size={20} />
                  <span>{ready ? 'On board' : t.name}</span>
                </button>
              )
            })}
          </div>
        )}
        <InstrumentBar />
      </div>

      {activeTab && (
        <BottomSheet title={activeTab.name}>
          {sheetTab === 'places' && <PlacesPanel />}
          {sheetTab === 'layers' && <LayersPanel />}
          {sheetTab === 'weather' && <WeatherPanel />}
          {sheetTab === 'tracks' && <TracksPanel />}
          {sheetTab === 'offline' && <OfflinePanel />}
        </BottomSheet>
      )}
    </div>
  )
}
