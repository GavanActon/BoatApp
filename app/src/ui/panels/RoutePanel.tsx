import { useCallback, useEffect, useMemo, useState } from 'react'
import { endTrip, replan, startTrip } from '../../routing/planner'
import { useRouteStore } from '../../routing/routeStore'
import {
  compass,
  type DayWindows,
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
  hourOfDayLabel,
  hourShort,
  isToday,
  startOfDayMs,
  timeLabel,
} from '../../time'
import { db, type SavedStart, type SavedTrip } from '../../tracking/db'
import { knToUnit, speedUnitLabel, unitToKn } from '../../units'
import { fetchPointForecast, type PointForecast } from '../../weather/openMeteo'
import Disclosure from '../Disclosure'
import { IconCheck, IconMinus, IconPlus, IconRefresh, IconTrash, IconWindArrow } from '../icons'
import HourlyDetail from './HourlyDetail'

/**
 * Trip planner, answers-first: pick where you're going and the panel leads
 * with the verdict and the week's trip options. The two per-trip decisions
 * (where, when) are the only controls on the surface; boat & family
 * configuration (round trip, cruise speed, minimum stay, back-by) lives in
 * the collapsed "Trip setup" row, and admin (timeline evidence, saved-trip
 * management) in its own disclosures.
 *
 * Once under way the panel becomes the live trip view: verdict, timeline,
 * end-trip.
 */

function ageLabel(fetchedAt: number): string {
  const min = Math.round((Date.now() - fetchedAt) / 60000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.round(min / 6) / 10} h ago`
}

const STAY_CHOICES = [
  { min: 30, label: '30m' },
  { min: 60, label: '1h' },
  { min: 120, label: '2h' },
  { min: 180, label: '3h' },
]

const BACKBY_MIN_H = 11 // stepping below 11 AM makes no trip; above 11 PM means "any"
const BACKBY_MAX_H = 23

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

/** "8a · 4½h" for round trips (leave then, that long there), a departure
 *  range "8a–1p" for one-way runs. */
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
          <b>{plan.oneWayNm.toFixed(1)}</b> {underWay ? 'nm to go' : 'nm each way'}
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
        <b className="numeral">{Math.round(s.windKn)}</b> kn {compass(s.windDir)}
      </span>
      <span className="hd-wave">
        {s.waveM != null ? (
          <>
            <b className="numeral">{s.waveM.toFixed(1)}</b> m
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

/** "When to go" — the 7-day trip-option sweep, tappable. Each chip is a
 *  concrete schedule; adopting one sets the departure AND the stay. */
function DepartureWindows({ days }: { days: DayWindows[] }) {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const setPlanTime = useAppStore((s) => s.setPlanTime)
  const setPlannedStay = useRouteStore((s) => s.setPlannedStay)
  const plannedStayMin = useRouteStore((s) => s.plannedStayMin)
  const selDayMs = startOfDayMs(planTimeMs ?? Date.now())

  function adopt(o: TripOption) {
    setPlanTime(o.departMs <= Date.now() ? null : o.departMs)
    setPlannedStay(o.stayMin)
  }

  function isAdopted(o: TripOption): boolean {
    const timeMatch =
      planTimeMs != null
        ? planTimeMs === o.departMs
        : o.windowStartMs <= Date.now() && Date.now() <= o.windowEndMs + 3_599_000
    return timeMatch && (o.stayMin == null || plannedStayMin === o.stayMin)
  }

  return (
    <>
      <div className="panel-section">When to go — leave · time there</div>
      <div className="win-days">
        {days.map((d) => (
          <div
            key={d.dayStartMs}
            className={`win-day${d.dayStartMs === selDayMs ? ' win-day-on' : ''}`}
          >
            <span className={`win-dayname cond-${d.best ?? 'na'}`}>{dayLabel(d.dayStartMs)}</span>
            <span className="win-list">
              {d.best == null ? (
                <em className="win-none">
                  {isToday(d.dayStartMs) ? 'done for today' : 'beyond the forecast'}
                </em>
              ) : d.options.length === 0 ? (
                <em className="win-none">no window — stay in</em>
              ) : (
                d.options.map((o) => (
                  <button
                    key={o.departMs}
                    className={`win win-${o.verdict}${isAdopted(o) ? ' win-on' : ''}`}
                    onClick={() => adopt(o)}
                    aria-label={
                      `${dayLabel(d.dayStartMs)}: leave ${hourShort(o.departMs)}` +
                      (o.stayMin != null ? `, ${durationLabel(o.stayMin)} there` : '') +
                      `, ${o.stayMin != null ? 'home' : 'there'} by ${timeLabel(o.homeMs)}` +
                      ` — ${o.verdict === 'go' ? 'good' : 'usable with caution'}`
                    }
                  >
                    {optionLabel(o)}
                  </button>
                ))
              )}
            </span>
          </div>
        ))}
      </div>
    </>
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
    setRoundTrip,
    cruiseKn,
    setCruiseKn,
    stayMin,
    setStayMin,
    plannedStayMin,
    setPlannedStay,
    backByHour,
    setBackBy,
    setBuilder,
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

  /** Hand where-from/where-to back to the map-facing builder card. */
  function openBuilder() {
    setSheetTab(null)
    setBuilder('choose')
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
        <button className="btn-primary trip-start btn-stop" onClick={() => endTrip()}>
          End trip
        </button>
      </div>
    )
  }

  // cruise speed is stored in knots; step by whole units of the chosen display unit
  const shownSpeed = Math.round(knToUnit(speedUnit, cruiseKn))
  const stepSpeed = (delta: number) => setCruiseKn(unitToKn(speedUnit, shownSpeed + delta))

  // departure = the app-wide planning time; the verdict card's ± nudges it
  const stepHour = (delta: number) => {
    const base = planTimeMs ?? floorHourMs()
    const next = base + delta * 3600_000
    setPlanTime(next <= Date.now() ? null : next)
  }

  // step the back-by hour; past 11 PM it means "no limit" ("Any" sits one
  // notch above the max, so − from Any lands back on 11 PM)
  const stepBackBy = (delta: number) => {
    const base = backByHour ?? BACKBY_MAX_H + 1
    const next = base + delta
    setBackBy(next > BACKBY_MAX_H ? null : Math.max(BACKBY_MIN_H, next))
  }

  const backByLabel = backByHour == null ? 'Any' : hourOfDayLabel(backByHour)
  const setupSummary =
    `${roundTrip ? 'round trip' : 'one way'} · ${shownSpeed} ${speedUnitLabel(speedUnit)}` +
    (roundTrip ? ` · ≥${durationLabel(stayMin)} there` : '') +
    ` · back by ${backByLabel}`

  return (
    <div className="panel">
      {/* ---------- the trip: chosen via the map builder, changed there too ---------- */}
      {destination ? (
        <div className="trip-route-head">
          <span className="trip-route-names">
            <span>{startPoint ? (startPoint.name ?? 'Pinned start') : 'Current location'}</span>
            {' → '}
            <b>{destination.name ?? 'Pinned spot'}</b>
          </span>
          <button className="linklike" onClick={openBuilder}>
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="empty">
            No trip yet — pick a destination and the route gets plotted through safe water, the
            weather checked for every leg, and the whole week swept for the best times to go.
          </div>
          <button className="btn-ghost" onClick={openBuilder}>
            Choose a destination
          </button>
        </>
      )}

      {destination && routeError && <div className="empty">{routeError}</div>}

      {destination && route && (
        <>
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

          {/* ---------- decision 2: when ---------- */}
          {plan && plan.days.length > 0 && <DepartureWindows days={plan.days} />}

          {plan && (
            <>
              <button className="btn-primary trip-start" onClick={() => startTrip()}>
                {planTimeMs != null ? 'Start trip now' : 'Start trip'}
              </button>
              {planTimeMs != null && (
                <div className="trip-plan-note">
                  Planned for {dayTimeLabel(planTimeMs)} — starting casts off right away.
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ---------- configuration: boat & family character, rarely touched ---------- */}
      <Disclosure title="Trip setup" summary={setupSummary}>
        <label className="row">
          <div className="row-text">
            <span className="row-title">Round trip</span>
            <span className="row-desc">Rates the weather for the ride back too</span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={roundTrip}
            onChange={(e) => setRoundTrip(e.target.checked)}
          />
        </label>

        <div className="row">
          <div className="row-text">
            <span className="row-title">Cruise speed</span>
            <span className="row-desc">Used to time the trip and the forecast</span>
          </div>
          <div className="stepper">
            <button className="icon-btn" onClick={() => stepSpeed(-1)} aria-label="Slower">
              <IconMinus size={16} />
            </button>
            <b className="numeral">
              {shownSpeed}
              <span> {speedUnitLabel(speedUnit)}</span>
            </b>
            <button className="icon-btn" onClick={() => stepSpeed(1)} aria-label="Faster">
              <IconPlus size={16} />
            </button>
          </div>
        </div>

        {roundTrip && (
          <div className="row">
            <div className="row-text">
              <span className="row-title">Time there</span>
              <span className="row-desc">
                {plannedStayMin != null
                  ? `At least ${durationLabel(stayMin)} · planned ${durationLabel(plannedStayMin)} from the picked option`
                  : 'At least — options stretch it while the weather holds'}
              </span>
            </div>
            <div className="seg">
              {STAY_CHOICES.map((c) => (
                <button
                  key={c.min}
                  className={stayMin === c.min ? 'seg-on' : ''}
                  onClick={() => setStayMin(c.min)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="row">
          <div className="row-text">
            <span className="row-title">Back by</span>
            <span className="row-desc">
              {roundTrip ? 'Latest you want to be home' : 'Latest you want to arrive'}
            </span>
          </div>
          <div className="stepper">
            <button className="icon-btn" onClick={() => stepBackBy(-1)} aria-label="Back an hour earlier">
              <IconMinus size={16} />
            </button>
            <b className="numeral">{backByLabel}</b>
            <button
              className="icon-btn"
              onClick={() => stepBackBy(1)}
              disabled={backByHour == null}
              aria-label="Back an hour later"
            >
              <IconPlus size={16} />
            </button>
          </div>
        </div>
      </Disclosure>

      {/* ---------- evidence ---------- */}
      {plan && (
        <Disclosure
          title="Trip timeline"
          summary="conditions at every leg · tap one for its forecast"
        >
          <Timeline plan={plan} />
        </Disclosure>
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
