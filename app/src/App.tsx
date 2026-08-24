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
  IconRoute,
  IconRuler,
  IconTrack,
  IconWind,
  IconDownload,
} from './ui/icons'
import LayersPanel from './ui/panels/LayersPanel'
import OfflinePanel from './ui/panels/OfflinePanel'
import RoutePanel from './ui/panels/RoutePanel'
import TracksPanel from './ui/panels/TracksPanel'
import WeatherPanel from './ui/panels/WeatherPanel'
import TripCard from './ui/TripCard'
import WeatherStrip from './ui/WeatherStrip'
import { initWeatherLayer } from './weather/weatherLayer'

// auto-follow waits for a fix at least this tight before trusting it…
const GOOD_FIX_ACCURACY_M = 150
// …but takes the best available once the deadline passes
const FOLLOW_DECIDE_TIMEOUT_MS = 10000

const TABS: { id: SheetTab; name: string; icon: typeof IconLayers }[] = [
  { id: 'route', name: 'Trip', icon: IconRoute },
  { id: 'layers', name: 'Layers', icon: IconLayers },
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
        Drag the line to add a course point — or a point or pin to move it · done
      </button>
    )
  }
  if (picking) {
    return (
      <button className="chip chip-accent" onClick={() => setPicking(null)}>
        Tap the map to set your {picking === 'start' ? 'starting point' : 'destination'} · cancel
      </button>
    )
  }
  // the trip card is already saying all of this at the bottom of the map —
  // unless the ruler has borrowed its spot, in which case the chip stands in
  if (card && !measuring) return null
  if (!destination || !plan) return null

  const underWay = tripStartedAt != null
  const name = destination.name ?? 'Pinned spot'
  const cls = plan.verdict === 'go' ? 'chip-ok' : plan.verdict === 'caution' ? 'chip-warn' : 'chip-danger'
  let text: string
  if (underWay) {
    text = `${name} · ${runDistance(speedUnit, plan.oneWayNm)} ${distanceUnitFor(speedUnit)} to go · there ${timeLabel(plan.arriveMs)}`
    if (plan.verdict === 'nogo') text += ' · rough ahead'
    else if (plan.turnsBadMs != null) text += ` · turns ${timeLabel(plan.turnsBadMs)}`
  } else {
    // a trip planned for another day wears its day up front: "Sat · Gros Cap: good to go"
    const day = isToday(plan.departMs) ? '' : `${dayShort(plan.departMs)} · `
    text =
      plan.verdict === 'go'
        ? `${day}${name}: good to go`
        : plan.verdict === 'caution'
          ? `${day}${name}: use caution`
          : `${day}${name}: not recommended`
    if (plan.verdict !== 'nogo' && plan.turnsBadMs != null) {
      text += ` · turns ${dayTimeLabel(plan.turnsBadMs)}`
    }
  }
  return (
    <button className={`chip ${cls}`} onClick={() => setCard('trip')}>
      {text}
    </button>
  )
}

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
        <span className="chip chip-warn">Location denied — allow location for this site</span>
      )}
      {gpsStatus === 'error' && (
        <span className="chip chip-warn">No GPS fix — still searching…</span>
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
  const card = useRouteStore((s) => s.card)
  const setCard = useRouteStore((s) => s.setCard)
  const measuring = useMeasureStore((s) => s.active)
  const barRef = useRef<HTMLDivElement>(null)

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
        <div className="tabdock glass">
          {TABS.map((t) => {
            const Icon = t.icon
            const on = sheetTab === t.id || (t.id === 'route' && card === 'choose')
            return (
              <button
                key={t.id}
                className={`tab ${on ? 'tab-on' : ''}`}
                onClick={() => {
                  const destination = useRouteStore.getState().destination
                  if (t.id === 'route') {
                    if (!destination) {
                      // no trip yet → the Trip tab toggles the map-facing chooser
                      setSheetTab(null)
                      setCard(card === 'choose' ? null : 'choose')
                      return
                    }
                    // with a trip, the tab toggles the details drawer — and
                    // makes sure the card is back up underneath it
                    setCard('trip')
                    setSheetTab(sheetTab === 'route' ? null : 'route')
                    return
                  }
                  // another tab puts the chooser away; a planned card can stay
                  if (card === 'choose') setCard(destination ? 'trip' : null)
                  setSheetTab(sheetTab === t.id ? null : t.id)
                }}
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
          {sheetTab === 'route' && <RoutePanel />}
          {sheetTab === 'layers' && <LayersPanel />}
          {sheetTab === 'weather' && <WeatherPanel />}
          {sheetTab === 'tracks' && <TracksPanel />}
          {sheetTab === 'offline' && <OfflinePanel />}
        </BottomSheet>
      )}
    </div>
  )
}
