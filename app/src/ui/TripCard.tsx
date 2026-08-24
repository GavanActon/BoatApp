import { useEffect, useState } from 'react'
import { DESTINATIONS } from '../config'
import { startTrip } from '../routing/planner'
import { applySavedTrip, useRouteStore } from '../routing/routeStore'
import { useAppStore } from '../state/appStore'
import { dayTimeLabel, durationLabel, floorHourMs, timeLabel } from '../time'
import { db, type SavedStart, type SavedTrip } from '../tracking/db'
import { distanceUnitFor, runDistance } from '../units'
import { IconClose, IconLocate, IconMinus, IconPin, IconPlus, IconSliders, IconStar } from './icons'
import TripSetup from './TripSetup'

/**
 * The trip's home on the navigation screen: a slim card docked over the
 * bottom bar that carries the whole trip through its life without leaving
 * the map. Choosing asks the two questions — where from, where to; planned
 * it shows the run's facts and verdict with the plotted route behind it
 * (when to leave is the strip up top; boat setup is one sliders-tap away);
 * under way it becomes the live progress line. The details drawer expands
 * on all of it, never replaces it.
 */

const VERDICT_TEXT = {
  go: 'Good to go',
  caution: 'Use caution',
  nogo: 'Not recommended',
}

export default function TripCard() {
  const card = useRouteStore((s) => s.card)
  const setCard = useRouteStore((s) => s.setCard)
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
  const speedUnit = useAppStore((s) => s.speedUnit)
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)

  const [setupOpen, setSetupOpen] = useState(false)
  const [saved, setSaved] = useState<SavedTrip[]>([])
  const [starts, setStarts] = useState<SavedStart[]>([])

  // opening the chooser refreshes the saved lists
  useEffect(() => {
    if (card !== 'choose') return
    void db.trips.orderBy('createdAt').reverse().toArray().then(setSaved)
    void db.starts.orderBy('createdAt').toArray().then(setStarts)
  }, [card])

  // the setup popover belongs to the planned card only
  useEffect(() => {
    if (card !== 'trip') setSetupOpen(false)
  }, [card])

  // hidden while picking — the map needs the room; the top chip guides
  if (!card || picking) return null

  // a 'trip' card without a destination makes no sense — ask instead
  const choosing = card === 'choose' || !destination

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
          <button
            className="icon-btn"
            onClick={() => setCard(destination ? 'trip' : null)}
            aria-label="Close"
          >
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
                    setCard('trip')
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
                    setCard('trip')
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

  const destLabel = plan?.destName ?? destination?.name ?? 'Pinned spot'

  // ---------- under way: the live progress line, tap for the drawer ----------
  if (tripStartedAt != null) {
    let liveText: string | null = null
    if (plan) {
      liveText = `${runDistance(speedUnit, plan.oneWayNm)} ${distanceUnitFor(speedUnit)} to go · there ${timeLabel(plan.arriveMs)}`
      if (plan.verdict === 'nogo') liveText += ' · rough ahead'
      else if (plan.turnsBadMs != null) liveText += ` · turns ${timeLabel(plan.turnsBadMs)}`
    }
    return (
      <div className={`tripbuilder glass tripcard-live tc-${plan?.verdict ?? 'na'}`}>
        <button
          className="tc-live-body"
          onClick={() => setSheetTab('route')}
          aria-label={`Trip to ${destLabel} — tap for details and end trip`}
        >
          <b>{destLabel}</b>
          <span className="numeral">{liveText ?? 'Re-timing the trip…'}</span>
        </button>
        <button className="icon-btn" onClick={() => setCard(null)} aria-label="Hide trip card">
          <IconClose size={16} />
        </button>
      </div>
    )
  }

  // ---------- planned: the run on the map, the facts on the card ----------
  // "Here" keeps the line short so the DESTINATION never loses its space
  const fromLabel = startPoint ? (startPoint.name ?? 'Pinned start') : 'Here'

  // departure = the app-wide planning time; the ± here nudges it by the hour
  const stepHour = (delta: number) => {
    const base = planTimeMs ?? floorHourMs()
    const next = base + delta * 3600_000
    setPlanTime(next <= Date.now() ? null : next)
  }

  return (
    <>
      {setupOpen && <TripSetup onClose={() => setSetupOpen(false)} />}
      <div className="tripbuilder glass">
        <div className="tb-head">
          <span className="tb-names">
            <span>{fromLabel}</span> → <b>{destination?.name ?? 'Pinned spot'}</b>
          </span>
          <button className="linklike" onClick={() => setCard('choose')}>
            Change
          </button>
          <button
            className={`icon-btn ${setupOpen ? 'icon-btn-on' : ''}`}
            onClick={() => setSetupOpen((v) => !v)}
            aria-label="Trip setup"
          >
            <IconSliders size={16} />
          </button>
          <button className="icon-btn tb-close" onClick={() => setCard(null)} aria-label="Hide trip card">
            <IconClose size={16} />
          </button>
        </div>
        <div className="tb-facts">
          {route ? (
            <span className="numeral">
              <b>{runDistance(speedUnit, route.distanceNm)}</b> {distanceUnitFor(speedUnit)} each way ·
              about{' '}
              <b>{durationLabel(Math.round((route.distanceNm / cruiseKn) * 60))}</b>
            </span>
          ) : (
            <span className="tb-dim">{routeError ?? 'Plotting through safe water…'}</span>
          )}
          {plan ? (
            <span className={`tb-verdict tb-${plan.verdict}`}>
              {VERDICT_TEXT[plan.verdict]} · leaving
              <button className="nudge" onClick={() => stepHour(-1)} aria-label="Leave an hour earlier">
                <IconMinus size={12} />
              </button>
              <b className="numeral">{dayTimeLabel(plan.departMs)}</b>
              <button className="nudge" onClick={() => stepHour(1)} aria-label="Leave an hour later">
                <IconPlus size={12} />
              </button>
              {plan.homeMs != null && (
                <span className="tb-back numeral">· back {timeLabel(plan.homeMs)}</span>
              )}
            </span>
          ) : planning ? (
            <span className="tb-dim">Checking the weather…</span>
          ) : planError ? (
            <span className="tb-dim">{planError}</span>
          ) : null}
        </div>
        <div className="tb-actions">
          <button className="btn-ghost" onClick={() => setSheetTab('route')}>
            Details
          </button>
          <button
            className="btn-primary"
            disabled={!plan}
            onClick={() => {
              setSetupOpen(false)
              startTrip()
            }}
          >
            Start trip
          </button>
        </div>
      </div>
    </>
  )
}
