import { useCallback, useEffect, useMemo, useState } from 'react'
import { endTrip, replan } from '../../routing/planner'
import { useRouteStore } from '../../routing/routeStore'
import {
  compass,
  type TripOption,
  type TripPhase,
  type TripPlan,
  type TripSample,
} from '../../routing/tripPlan'
import { useAppStore } from '../../state/appStore'
import {
  dayLabel,
  dayTimeLabel,
  durationLabel,
  floorHourMs,
  hourShort,
  isToday,
  startOfDayMs,
  timeLabel,
} from '../../time'
import { db, type SavedStart, type SavedTrip } from '../../tracking/db'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel, windSpeed } from '../../units'
import { fetchPointForecast, formatPeriod, type PointForecast } from '../../weather/openMeteo'
import Disclosure from '../Disclosure'
import { IconCheck, IconMinus, IconPlus, IconRefresh, IconTrash, IconWindArrow } from '../icons'
import HourlyDetail from './HourlyDetail'

/**
 * The trip details drawer. The map screen owns the trip — the card carries
 * the facts, the strip up top picks the departure, the route line wears the
 * conditions — so this drawer only EXPANDS on what's already visible: the
 * verdict's full reasoning, the leg-by-leg timeline with each leg's day
 * forecast a tap away, and saved-trip admin. Under way it adds End trip.
 */

function ageLabel(fetchedAt: number): string {
  const min = Math.round((Date.now() - fetchedAt) / 60000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.round(min / 6) / 10} h ago`
}

const VERDICT_TEXT = {
  go: 'Good to go',
  caution: 'Use caution',
  nogo: 'Not recommended',
}

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

/** "Sat 8a · 4½h" for round trips (leave then, that long there). */
function optionLabel(o: TripOption): string {
  if (o.stayMin != null) return `${hourShort(o.departMs)} · ${durationLabel(o.stayMin)}`
  if (o.windowStartMs === o.windowEndMs) return hourShort(o.windowStartMs)
  return `${hourShort(o.windowStartMs)}–${hourShort(o.windowEndMs)}`
}

/** One verdict card — shared by planning and under-way views. While planning,
 *  the departure fact carries ± nudgers (the answer is also the control) and
 *  a non-green card points at the week's best alternative. */
function VerdictCard({
  plan,
  underWay,
  tripStartedAt,
  onNudge,
  better,
}: {
  plan: TripPlan
  underWay: boolean
  tripStartedAt: number | null
  onNudge?: (deltaHours: number) => void
  better?: { text: string; onUse: () => void }
}) {
  const speedUnit = useAppStore((s) => s.speedUnit)
  return (
    <div className={`verdict verdict-${plan.verdict}`}>
      <div className="verdict-head">
        <b>{VERDICT_TEXT[plan.verdict]}</b>
        <span className="fc-actions">
          <em className={plan.stale ? 'age-badge stale' : 'age-badge'}>
            {plan.stale ? `offline · ${ageLabel(plan.fetchedAt)}` : ageLabel(plan.fetchedAt)}
          </em>
          <button className="icon-btn" onClick={() => void replan()} aria-label="Refresh">
            <IconRefresh size={16} />
          </button>
        </span>
      </div>
      <p>{plan.headline}</p>
      {plan.verdict !== 'nogo' && plan.turnsBadText && (
        <p className="verdict-warn">⚠ {plan.turnsBadText}</p>
      )}
      {better && (
        <button className="verdict-better" onClick={better.onUse}>
          Better: {better.text} →
        </button>
      )}
      <div className="verdict-facts numeral">
        {!underWay && (
          <span className="fact-leave">
            leaving
            {onNudge && (
              <button className="nudge" onClick={() => onNudge(-1)} aria-label="Leave an hour earlier">
                <IconMinus size={12} />
              </button>
            )}
            <b>{dayTimeLabel(plan.departMs)}</b>
            {onNudge && (
              <button className="nudge" onClick={() => onNudge(1)} aria-label="Leave an hour later">
                <IconPlus size={12} />
              </button>
            )}
          </span>
        )}
        <span>
          <b>{runDistance(speedUnit, plan.oneWayNm)}</b>{' '}
          {distanceUnitFor(speedUnit)} {underWay ? 'to go' : 'each way'}
        </span>
        <span>
          there <b>{underWay ? timeLabel(plan.arriveMs) : dayTimeLabel(plan.arriveMs)}</b>
        </span>
        {!underWay && plan.homeMs != null && (
          <span>
            <b>{durationLabel(Math.round((plan.homeMs - 2 * plan.arriveMs + plan.departMs) / 60_000))}</b>{' '}
            there
          </span>
        )}
        {plan.homeMs != null && (
          <span>
            back <b>{underWay ? timeLabel(plan.homeMs) : dayTimeLabel(plan.homeMs)}</b>
          </span>
        )}
      </div>
      {underWay && tripStartedAt != null && (
        <div className="trip-live">
          Under way since {timeLabel(tripStartedAt)} — progress re-timed every 2 min, weather
          refreshed every 30 min.
        </div>
      )}
    </div>
  )
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
      className={`trip-row trip-${s.cond} ${expanded ? 'trip-expanded' : ''}`}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`${phaseLabel(s.phase, destName)} — tap for the day's forecast here`}
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
    fetchPointForecast(lon, lat)
      .then((r) => alive && setFc(r.forecast))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [lon, lat])

  return (
    <div className="leg-forecast">
      <div className="leg-forecast-title">
        {isToday(atMs) ? 'Rest of the day at this spot' : `${dayLabel(atMs)} at this spot`}
      </div>
      {fc ? (
        <HourlyDetail forecast={fc} dayStartMs={startOfDayMs(atMs)} />
      ) : (
        <div className="empty">{failed ? 'No forecast available offline.' : 'Loading…'}</div>
      )}
    </div>
  )
}

function Timeline({ plan }: { plan: TripPlan }) {
  const expandedIdx = useRouteStore((s) => s.expandedIdx)
  const setExpandedIdx = useRouteStore((s) => s.setExpandedIdx)
  return (
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
  )
}

export default function RoutePanel() {
  const setSheetTab = useAppStore((s) => s.setSheetTab)
  const online = useAppStore((s) => s.online)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)
  const {
    destination,
    setDestination,
    startPoint,
    setStartPoint,
    viaPoints,
    setViaPoints,
    roundTrip,
    cruiseKn,
    stayMin,
    setPlannedStay,
    backByHour,
    setCard,
    route,
    routeError,
    plan,
    planError,
    planning,
    tripStartedAt,
  } = useRouteStore()
  const underWay = tripStartedAt != null

  // saved trips
  const [saved, setSaved] = useState<SavedTrip[]>([])
  const [justSaved, setJustSaved] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const reloadSaved = useCallback(() => {
    void db.trips.orderBy('createdAt').reverse().toArray().then(setSaved)
  }, [])
  useEffect(() => reloadSaved(), [reloadSaved])

  // saved start points (launch ramps, marina slips)
  const [starts, setStarts] = useState<SavedStart[]>([])
  const [editingStartId, setEditingStartId] = useState<number | null>(null)
  const [editStartName, setEditStartName] = useState('')
  const reloadStarts = useCallback(() => {
    void db.starts.orderBy('createdAt').toArray().then(setStarts)
  }, [])
  useEffect(() => reloadStarts(), [reloadStarts])

  async function saveTrip() {
    if (!destination) return
    await db.trips.add({
      name: destination.name ?? 'Pinned spot',
      destName: destination.name,
      lon: destination.lon,
      lat: destination.lat,
      roundTrip,
      cruiseKn,
      stayMin,
      backBy: backByHour,
      vias: viaPoints,
      start: startPoint ? { ...startPoint } : null,
      createdAt: Date.now(),
    })
    reloadSaved()
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1600)
  }

  async function commitStartName(sp: SavedStart) {
    const name = editStartName.trim()
    setEditingStartId(null)
    if (name && name !== sp.name) {
      await db.starts.update(sp.id!, { name })
      // if it's the start in use, rename it on the map too
      if (startPoint && startPoint.lon === sp.lon && startPoint.lat === sp.lat) {
        setStartPoint({ name, lon: sp.lon, lat: sp.lat })
      }
      reloadStarts()
    }
  }

  async function deleteStart(sp: SavedStart) {
    await db.starts.delete(sp.id!)
    // deleting the start in use falls back to current location
    if (startPoint && startPoint.lon === sp.lon && startPoint.lat === sp.lat) setStartPoint(null)
    reloadStarts()
  }

  async function commitName(t: SavedTrip) {
    const name = editName.trim()
    setEditingId(null)
    if (name && name !== t.name) {
      await db.trips.update(t.id!, { name })
      // if this trip is the one on the map, rename it there too
      if (destination && destination.lon === t.lon && destination.lat === t.lat) {
        setDestination({ name, lon: t.lon, lat: t.lat })
      }
      reloadSaved()
    }
  }

  // the week's best alternative, offered whenever the current pick isn't green
  const better = useMemo(() => {
    if (!plan || plan.verdict === 'go' || underWay) return undefined
    const o = plan.days
      .flatMap((d) => d.options)
      .find((x) => x.verdict === 'go' && x.departMs > Date.now() && x.departMs !== plan.departMs)
    if (!o) return undefined
    return {
      text: `${dayLabel(o.departMs)} ${optionLabel(o)}`,
      onUse: () => {
        setPlanTime(o.departMs)
        setPlannedStay(o.stayMin)
      },
    }
  }, [plan, underWay, setPlanTime, setPlannedStay])

  // ---------- under way: the live trip view, nothing else ----------
  if (underWay) {
    return (
      <div className="panel">
        {plan ? (
          <>
            <VerdictCard plan={plan} underWay tripStartedAt={tripStartedAt} />
            <div className="panel-section">Trip timeline — tap a leg for its day forecast</div>
            <Timeline plan={plan} />
          </>
        ) : (
          <div className="empty">
            {planning ? 'Re-timing the trip…' : (planError ?? 'Waiting for a forecast…')}
          </div>
        )}
        <button
          className="btn-primary trip-start btn-stop"
          onClick={() => {
            endTrip()
            setSheetTab(null) // back to the map — the trip's home
          }}
        >
          End trip
        </button>
      </div>
    )
  }

  // departure = the app-wide planning time; the verdict card's ± nudges it
  const stepHour = (delta: number) => {
    const base = planTimeMs ?? floorHourMs()
    const next = base + delta * 3600_000
    setPlanTime(next <= Date.now() ? null : next)
  }

  return (
    <div className="panel">
      {!destination && (
        <>
          <div className="empty">
            No trip yet — pick a destination and the route gets plotted through safe water, the
            weather checked for every leg, and the whole week swept for the best times to go.
          </div>
          <button
            className="btn-ghost"
            onClick={() => {
              setSheetTab(null)
              setCard('choose')
            }}
          >
            Choose a destination
          </button>
        </>
      )}

      {destination && routeError && <div className="empty">{routeError}</div>}

      {destination && route && (
        <>
          {plan && (
            <VerdictCard
              plan={plan}
              underWay={false}
              tripStartedAt={null}
              onNudge={stepHour}
              better={better}
            />
          )}

          {planning && !plan && <div className="empty">Checking the weather along the route…</div>}
          {planError && !plan && (
            <div className="empty">{online ? planError : `Offline — ${planError}`}</div>
          )}

          <div className="route-edit-note">
            {viaPoints.length > 0 ? (
              <>
                Steered through {viaPoints.length} point{viaPoints.length === 1 ? '' : 's'} — drag
                to adjust, tap one to remove.{' '}
                <button className="linklike" onClick={() => setViaPoints([])}>
                  Reset course
                </button>
              </>
            ) : (
              'Drag the route line on the map to steer it around islands or shoals.'
            )}
          </div>

          {plan && (
            <>
              <div className="panel-section">Trip timeline — tap a leg for its day forecast</div>
              <Timeline plan={plan} />
            </>
          )}
        </>
      )}

      {/* ---------- admin ---------- */}
      {(destination || saved.length > 0 || starts.length > 0) && (
        <Disclosure
          title="Saved trips"
          summary={
            (saved.length > 0 ? `${saved.length} saved` : 'none yet') +
            (starts.length > 0 ? ` · ${starts.length} start${starts.length === 1 ? '' : 's'}` : '') +
            (destination ? ' · save this one' : '')
          }
        >
          {destination && (
            <div className="trip-actions">
              <button className="btn-ghost" onClick={() => void saveTrip()} disabled={justSaved}>
                {justSaved ? (
                  <>
                    <IconCheck size={16} /> Saved
                  </>
                ) : (
                  'Save trip'
                )}
              </button>
              <button className="btn-ghost danger" onClick={() => setDestination(null)}>
                <IconTrash size={15} /> Clear trip
              </button>
            </div>
          )}
          {saved.map((t) => (
            <div key={t.id} className="row">
              <div className="row-text">
                {editingId === t.id ? (
                  <input
                    className="trip-name-input"
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => void commitName(t)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <button
                    className="row-title trip-name"
                    onClick={() => {
                      setEditingId(t.id!)
                      setEditName(t.name)
                    }}
                    aria-label={`Rename ${t.name}`}
                  >
                    {t.name}
                  </button>
                )}
                <span className="row-desc">
                  {t.roundTrip ? 'Round trip' : 'One way'} ·{' '}
                  {Math.round(knToUnit(speedUnit, t.cruiseKn))} {speedUnitLabel(speedUnit)}
                  {t.roundTrip ? ` · ≥${durationLabel(t.stayMin)} there` : ''}
                  {t.start ? ` · from ${t.start.name ?? 'a pinned start'}` : ''}
                  {' · tap name to rename'}
                </span>
              </div>
              <button
                className="icon-btn danger"
                onClick={() => void db.trips.delete(t.id!).then(reloadSaved)}
                aria-label={`Delete ${t.name}`}
              >
                <IconTrash size={16} />
              </button>
            </div>
          ))}

          {starts.length > 0 && <div className="panel-section">Start points</div>}
          {starts.map((sp) => (
            <div key={`start-row-${sp.id}`} className="row">
              <div className="row-text">
                {editingStartId === sp.id ? (
                  <input
                    className="trip-name-input"
                    value={editStartName}
                    autoFocus
                    onChange={(e) => setEditStartName(e.target.value)}
                    onBlur={() => void commitStartName(sp)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditingStartId(null)
                    }}
                  />
                ) : (
                  <button
                    className="row-title trip-name"
                    onClick={() => {
                      setEditingStartId(sp.id!)
                      setEditStartName(sp.name)
                    }}
                    aria-label={`Rename ${sp.name}`}
                  >
                    {sp.name}
                  </button>
                )}
                <span className="row-desc">
                  {Math.abs(sp.lat).toFixed(3)}°{sp.lat >= 0 ? 'N' : 'S'}{' '}
                  {Math.abs(sp.lon).toFixed(3)}°{sp.lon >= 0 ? 'E' : 'W'}
                  {' · tap name to rename'}
                </span>
              </div>
              <button
                className="icon-btn danger"
                onClick={() => void deleteStart(sp)}
                aria-label={`Delete ${sp.name}`}
              >
                <IconTrash size={16} />
              </button>
            </div>
          ))}
        </Disclosure>
      )}
    </div>
  )
}
