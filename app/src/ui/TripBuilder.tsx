import { useEffect, useState } from 'react'
import { DESTINATIONS } from '../config'
import { startTrip } from '../routing/planner'
import { applySavedTrip, useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { dayTimeLabel, durationLabel } from '../time'
import { db, type SavedStart, type SavedTrip } from '../tracking/db'
import { IconClose, IconLocate, IconPin, IconStar } from './icons'

/**
 * The map-facing trip builder: a slim card docked over the bottom bar that
 * asks the two trip questions — where from, where to — and then becomes the
 * run's preview (distance and time at once, the weather verdict as soon as
 * the plan resolves) while the plotted route stays visible on the map behind
 * it. The full options panel (when to go, trip setup, timeline) is one
 * button away.
 */

const VERDICT_TEXT = {
  go: 'Good to go',
  caution: 'Use caution',
  nogo: 'Not recommended',
}

export default function TripBuilder() {
  const builder = useRouteStore((s) => s.builder)
  const setBuilder = useRouteStore((s) => s.setBuilder)
  const picking = useRouteStore((s) => s.picking)
  const setPicking = useRouteStore((s) => s.setPicking)
  const destination = useRouteStore((s) => s.destination)
  const setDestination = useRouteStore((s) => s.setDestination)
  const startPoint = useRouteStore((s) => s.startPoint)
  const setStartPoint = useRouteStore((s) => s.setStartPoint)
  const route = useRouteStore((s) => s.route)
  const routeError = useRouteStore((s) => s.routeError)
  const plan = useRouteStore((s) => s.plan)
  const planning = useRouteStore((s) => s.planning)
  const planError = useRouteStore((s) => s.planError)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const setSheetTab = useAppStore((s) => s.setSheetTab)

  const [saved, setSaved] = useState<SavedTrip[]>([])
  const [starts, setStarts] = useState<SavedStart[]>([])

  // opening the card refreshes the saved lists
  useEffect(() => {
    if (!builder) return
    void db.trips.orderBy('createdAt').reverse().toArray().then(setSaved)
    void db.starts.orderBy('createdAt').toArray().then(setStarts)
  }, [builder])

  // hidden while picking (the map needs the room; the top chip guides),
  // under way (the trip chip and panel own that) and when dismissed
  if (!builder || picking || tripStartedAt != null) return null

  // previewing without a destination makes no sense — fall back to choosing
  const choosing = builder === 'choose' || !destination

  /** Turn the map-picked start into a reusable named one. */
  async function saveStart() {
    if (!startPoint) return
    const names = new Set(starts.map((s) => s.name))
    let name = 'Start point'
    for (let n = 2; names.has(name); n++) name = `Start point ${n}`
    await db.starts.add({ name, lon: startPoint.lon, lat: startPoint.lat, createdAt: Date.now() })
    setStartPoint({ name, lon: startPoint.lon, lat: startPoint.lat }) // becomes its chip
    setStarts(await db.starts.orderBy('createdAt').toArray())
  }

  function pickOnMap(what: 'start' | 'dest') {
    setPicking(what)
    setSheetTab(null) // get everything out of the way to tap the map
  }

  if (choosing) {
    return (
      <div className="tripbuilder glass">
        <div className="tb-head">
          <span className="tb-title">Plan a trip</span>
          <button className="icon-btn" onClick={() => setBuilder(null)} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="tb-row">
          <span className="tb-label">To</span>
          <div className="tb-chips">
            {saved.map((t) => {
              const active = destination?.lon === t.lon && destination?.lat === t.lat
              return (
                <button
                  key={`saved-${t.id}`}
                  className={`dest-chip dest-saved ${active ? 'dest-on' : ''}`}
                  onClick={() => {
                    if (active) return setDestination(null)
                    applySavedTrip(t)
                    setBuilder('preview')
                  }}
                >
                  <IconStar size={12} /> {t.name}
                </button>
              )
            })}
            {DESTINATIONS.filter((d) => !saved.some((t) => t.destName === d.name)).map((d) => {
              const active = destination?.name === d.name
              return (
                <button
                  key={d.name}
                  className={`dest-chip ${active ? 'dest-on' : ''}`}
                  onClick={() => {
                    if (active) return setDestination(null)
                    setDestination({ ...d })
                    setBuilder('preview')
                  }}
                >
                  {d.name}
                </button>
              )
            })}
            <button className="dest-chip dest-pick" onClick={() => pickOnMap('dest')}>
              <IconPin size={14} /> Pick on map
            </button>
          </div>
        </div>
        <div className="tb-row">
          <span className="tb-label">From</span>
          <div className="tb-chips">
            <button
              className={`dest-chip ${!startPoint ? 'dest-on' : ''}`}
              onClick={() => setStartPoint(null)}
            >
              <IconLocate size={13} /> Current location
            </button>
            {starts.map((sp) => {
              const active = startPoint?.lon === sp.lon && startPoint?.lat === sp.lat
              return (
                <button
                  key={`start-${sp.id}`}
                  className={`dest-chip dest-saved ${active ? 'dest-on' : ''}`}
                  onClick={() =>
                    active
                      ? setStartPoint(null)
                      : setStartPoint({ name: sp.name, lon: sp.lon, lat: sp.lat })
                  }
                >
                  <IconStar size={12} /> {sp.name}
                </button>
              )
            })}
            <button
              className={`dest-chip dest-pick ${startPoint && !startPoint.name ? 'dest-on' : ''}`}
              onClick={() => pickOnMap('start')}
            >
              <IconPin size={14} /> Pick on map
            </button>
            {startPoint && !startPoint.name && (
              <button className="dest-chip dest-save-start" onClick={() => void saveStart()}>
                <IconStar size={12} /> Save this start
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---------- preview: the run on the map, the facts on the card ----------
  const fromLabel = startPoint ? (startPoint.name ?? 'Pinned start') : 'Current location'
  const destLabel = destination?.name ?? 'Pinned spot'

  return (
    <div className="tripbuilder glass">
      <div className="tb-head">
        <span className="tb-names">
          <span>{fromLabel}</span> → <b>{destLabel}</b>
        </span>
        <button className="linklike" onClick={() => setBuilder('choose')}>
          Change
        </button>
        <button className="icon-btn" onClick={() => setBuilder(null)} aria-label="Close">
          <IconClose size={16} />
        </button>
      </div>
      <div className="tb-facts">
        {route ? (
          <span className="numeral">
            <b>{route.distanceNm.toFixed(1)}</b> nm each way · about{' '}
            <b>{durationLabel(Math.round((route.distanceNm / cruiseKn) * 60))}</b>
          </span>
        ) : (
          <span className="tb-dim">{routeError ?? 'Plotting through safe water…'}</span>
        )}
        {plan ? (
          <span className={`tb-verdict tb-${plan.verdict}`}>
            {VERDICT_TEXT[plan.verdict]} · leaving {dayTimeLabel(plan.departMs)}
          </span>
        ) : planning ? (
          <span className="tb-dim">Checking the weather…</span>
        ) : planError ? (
          <span className="tb-dim">{planError}</span>
        ) : null}
      </div>
      {route && (
        <div className="tb-hint">Drag the route line on the map to steer it around shoals.</div>
      )}
      <div className="tb-actions">
        <button
          className="btn-ghost"
          onClick={() => {
            setBuilder(null)
            setSheetTab('route')
          }}
        >
          Trip options
        </button>
        <button
          className="btn-primary"
          disabled={!plan}
          onClick={() => {
            setBuilder(null)
            startTrip()
          }}
        >
          Start trip
        </button>
      </div>
    </div>
  )
}
