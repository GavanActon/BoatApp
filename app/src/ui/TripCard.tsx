import { useEffect, useState } from 'react'
import { HOME } from '../config'
import { homeCenter } from '../state/placesStore'
import { legReadout } from '../routing/legReadout'
import { endTrip, startTrip } from '../routing/planner'
import { useRouteStore } from '../routing/routeStore'
import type { TripPlan } from '../routing/tripPlan'
import { haversineNm } from '../routing/waterRouter'
import { useAppStore } from '../state/appStore'
import { allPlaces, noteFor } from '../state/placesStore'
import {
  dayLabel,
  dayShort,
  dayTimeLabel,
  durationLabel,
  floorHourMs,
  hourShort,
  isToday,
  startOfDayMs,
  timeLabel,
} from '../time'
import { useGpsStore } from '../tracking/gpsStore'
import { distanceUnitFor, knToUnit, runDistance, speedUnitLabel, unitToKn, windSpeed } from '../units'
import { fetchPointForecast, type PointForecast } from '../weather/openMeteo'
import { seaColor } from '../weather/seaState'
import { ensureWeatherGrid, gridConditionsAt, onWeatherHour, weatherGridInfo } from '../weather/weatherLayer'
import { IconClose, IconMinus, IconPlus } from './icons'
import RunDetail from './RunDetail'
import { useSwipeUp } from './useSwipeUp'

/**
 * The dock — WHO the screen is about and WHAT HAPPENS NEXT, and nothing
 * that restates the outlook strip.
 *
 * Three surfaces, three axes, each datum exactly one home: the STRIP is
 * when (every time-series condition for the current subject, hour cells and
 * day chips, droplet and ⚡ marks included); the MAP is where (the spot
 * badges); this dock is who-and-what-next. It exists only when there IS a
 * who: a picked place, or a trip under way. With no subject there is no
 * dock at all — the Places sheet superseded the old always-on "Here" bar,
 * which sat on the chart saying mostly nothing. At rest the dock is a slim
 * bar — the place's name, the run time, thunder if any is due today, and a
 * planned trip's window and start gate. Raised, it carries only what has no
 * other home: the spot's hand-written note and the run leg by leg.
 *
 * An earlier build put a full conditions shelf and a second week strip
 * here; every cell of it duplicated the strip pinned to the top of the
 * chart, so it went. The jump list, limits row and saved-trip admin
 * likewise moved out, to the Places sheet.
 */

/** First remaining hour today that calls thunder, or null. This is the one
 *  thing the dock is allowed to be loud about (§0.6) — an amber ⚡ chip. */
function thunderTodayMs(f: PointForecast): number | null {
  const t = f.hourly.time
  const from = floorHourMs()
  const to = startOfDayMs(Date.now()) + 24 * 3600_000
  for (let i = 0; i < t.length; i++) {
    const ms = Date.parse(t[i])
    if (ms < from || ms >= to) continue
    if ((f.hourly.weatherCode[i] ?? 0) >= 95) return ms
  }
  return null
}

/**
 * The grid is module state, not a store — tick once it has landed so the
 * jump list reading it re-renders. refreshWeatherGrid swallows its own
 * failures and resolves null, so a failed fetch used to leave every tile
 * reading "–" for the rest of the session with nothing to retrigger it.
 * Keep asking until there is a grid.
 */
function useWeatherGridTick() {
  const [gridTick, setGridTick] = useState(0)
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    let tries = 0
    const load = () => {
      void ensureWeatherGrid().then(() => {
        if (!alive) return
        setGridTick((t) => t + 1)
        if (weatherGridInfo() == null && tries++ < 4) {
          timer = window.setTimeout(load, 2000 * tries)
        }
      })
    }
    load()
    const onOnline = () => {
      tries = 0
      load()
    }
    window.addEventListener('online', onOnline)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [])
  return gridTick
}

const FC_REFRESH_MS = 30 * 60_000

/** The subject's point forecast — the dock reads ONE thing off it, whether
 *  thunder is due today. Same cache the strip fills, so this costs nothing
 *  new while online and still answers offline. */
function useSubjectForecast(lon: number, lat: number): PointForecast | null {
  const [fc, setFc] = useState<PointForecast | null>(null)
  // two decimals is the point cache's own key resolution — finer changes are
  // GPS jitter, and refetching on jitter would thrash the cache for nothing
  const lonKey = Math.round(lon * 100) / 100
  const latKey = Math.round(lat * 100) / 100
  useEffect(() => {
    let alive = true
    setFc(null)
    const load = () =>
      fetchPointForecast(lonKey, latKey)
        .then((r) => alive && setFc(r.forecast))
        .catch(() => {
          /* no chip until a forecast lands */
        })
    void load()
    const t = setInterval(() => void load(), FC_REFRESH_MS)
    const offHour = onWeatherHour(() => void load()) // hourly data steps hourly
    return () => {
      alive = false
      clearInterval(t)
      offHour()
    }
  }, [lonKey, latKey])
  return fc
}

/** Biggest sea on each lane — the plan line quotes both, because on this
 *  lake the way out and the way home are routinely two different afternoons —
 *  plus the strongest wind anywhere along the run. */
function laneWaves(plan: TripPlan | null): {
  out: number | null
  back: number | null
  windKn: number | null
} {
  if (!plan) return { out: null, back: null, windKn: null }
  let out: number | null = null
  let back: number | null = null
  let windKn: number | null = null
  for (const s of plan.samples) {
    windKn = windKn == null ? s.windKn : Math.max(windKn, s.windKn)
    if (s.waveM == null) continue
    if (s.phase === 'depart' || s.phase === 'outbound' || s.phase === 'arrive') {
      out = out == null ? s.waveM : Math.max(out, s.waveM)
    } else {
      back = back == null ? s.waveM : Math.max(back, s.waveM)
    }
  }
  return { out, back, windKn }
}

/** How soon "Start trip" is allowed to exist: the out-time is within an hour
 *  of now, or no time is picked at all — leaving now (§0.4). */
const START_SOON_MS = 60 * 60_000

/**
 * A picked spot's plan: the window chips, the run's distance with each
 * lane's biggest sea, and — only when its moment has come — the start
 * button. Any other time the plan is stated, quietly, and nothing on
 * screen asks you to launch.
 */
function PlanBlock() {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const windUnit = useAppStore((s) => s.windUnit)
  const route = useRouteStore((s) => s.route)
  const routeError = useRouteStore((s) => s.routeError)
  const plan = useRouteStore((s) => s.plan)
  const planning = useRouteStore((s) => s.planning)
  const planError = useRouteStore((s) => s.planError)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)

  const lanes = laneWaves(plan)
  const soon = planTimeMs == null || planTimeMs - Date.now() < START_SOON_MS
  // Place taps explore, TIME taps plan. Until an hour or day is picked on the
  // strip this block is facts only — surfacing the window chips the moment a
  // spot was tapped made looking at its weather feel like being asked when
  // you were leaving.
  const planningStarted = useAppStore((s) => s.planPicked)

  return (
    <>
      {planningStarted && <WindowChips />}
      <div className="tb-facts">
        {route ? (
          <span className="numeral">
            <b>{runDistance(speedUnit, route.distanceNm)}</b> {distanceUnitFor(speedUnit)} ·{' '}
            <b>{durationLabel(Math.round((route.distanceNm / cruiseKn) * 60))}</b>
            {lanes.out != null && (
              <>
                {' · '}
                <b style={{ color: seaColor(lanes.out) }}>{lanes.out.toFixed(1)} m</b> out
              </>
            )}
            {lanes.back != null && (
              <>
                {' · '}
                <b style={{ color: seaColor(lanes.back) }}>{lanes.back.toFixed(1)} m</b> back
              </>
            )}
            {lanes.windKn != null && (
              <>
                {' · '}
                <b>{windSpeed(windUnit, lanes.windKn)}</b> {speedUnitLabel(windUnit)} wind
              </>
            )}
          </span>
        ) : (
          <span className="tb-dim">{routeError ?? '…'}</span>
        )}
        {plan ? null : planning ? (
          <span className="tb-dim">…</span>
        ) : planError ? (
          <span className="tb-dim">{planError}</span>
        ) : null}
      </div>
      {!planningStarted ? null : soon ? (
        <div className="tb-actions">
          <button className="btn-primary" disabled={!plan} onClick={() => startTrip()}>
            Start trip
          </button>
        </div>
      ) : (
        // a future trip is a plan, not a countdown — no start affordance at
        // all until the morning of (§0.4)
        <div className="plan-note numeral">planned · {dayLabel(planTimeMs)}</div>
      )}
    </>
  )
}

export default function TripCard() {
  const card = useRouteStore((s) => s.card)
  const setCard = useRouteStore((s) => s.setCard)
  const picking = useRouteStore((s) => s.picking)
  const destination = useRouteStore((s) => s.destination)
  const setDestination = useRouteStore((s) => s.setDestination)
  const startPoint = useRouteStore((s) => s.startPoint)
  const route = useRouteStore((s) => s.route)
  const plan = useRouteStore((s) => s.plan)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const tripStartedAt = useRouteStore((s) => s.tripStartedAt)
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const fix = useGpsStore((s) => s.fix)

  const detent = useAppStore((s) => s.detent)
  const setDetent = useAppStore((s) => s.setDetent)

  // gridTick only exists to re-render once the grid lands — it isn't a store,
  // so nothing else would tell us. The water-temp fact recomputes for free.
  void useWeatherGridTick()

  const raised = detent === 'raised'
  // swipe up anywhere on the card raises it; swipe down brings it back down
  const swipe = useSwipeUp(
    () => setDetent('raised'),
    () => setDetent('rest'),
  )

  // where "here" is: the chosen start beats the fix beats the home waters
  const here = startPoint ?? (fix ? { name: null, lon: fix.lon, lat: fix.lat } : null) ?? {
    name: null,
    lon: (homeCenter() ?? HOME.center)[0],
    lat: (homeCenter() ?? HOME.center)[1],
  }
  // ONE subject at a time — and the dock only renders when there is one;
  // `here` stands in for the hooks' sake before the early return below
  const subject = destination ?? here
  const subjectName = destination?.name ?? 'Pinned spot'
  const fc = useSubjectForecast(subject.lon, subject.lat)
  const stormMs = fc ? thunderTodayMs(fc) : null

  const setPlanPicked = useAppStore((s) => s.setPlanPicked)

  // hidden while picking — the map needs the room; the top chip guides
  if (picking) return null

  // no subject, no dock: with nothing picked the chart stands alone and the
  // Places sheet is where you look around (§0.2)
  if (!destination && tripStartedAt == null) return null

  // ✕ clears the subject: destination, focus and lanes clear, dock goes away
  const clearSubject = () => {
    setDestination(null)
    setPlanPicked(false) // a fresh subject starts at exploring, not planning
    setDetent('rest')
  }

  // the same real button for everyone the swipe is invisible to (§2.4)
  const grab = (
    <button
      className="grab"
      onClick={() => setDetent(raised ? 'rest' : 'raised')}
      aria-expanded={raised}
      aria-label={raised ? 'Less' : 'More'}
    >
      <i />
    </button>
  )

  const destLabel = plan?.destName ?? destination?.name ?? 'Pinned spot'

  // ---------- under way: the live leg; raised, what's left of the run ----------
  if (destination && tripStartedAt != null) {
    return (
      <div className={`tripbuilder glass tripcard-live ${raised ? 'tb-raised' : ''}`} {...swipe}>
        {grab}
        <LiveLeg
          destLabel={destLabel}
          onOpen={() => setDetent('raised')}
          onHide={() => {
            setCard(null)
            setDetent('rest')
          }}
        />
        {raised && (
          <div className="tb-scroll">
            <RunDetail />
          </div>
        )}
      </div>
    )
  }

  // a planned trip the user put away — the top chip stands in
  if (!card) return null

  // run time from here, before the routed distance lands, so the bar can
  // answer "how far is that" the moment the subject changes
  const runNm = destination
    ? (route?.distanceNm ?? haversineNm(here.lon, here.lat, destination.lon, destination.lat))
    : null
  const runMin = runNm != null ? Math.round((runNm / cruiseKn) * 60) : null
  // the bar leads with the day whenever the plan is for another one (§0.4)
  const planDay =
    destination && planTimeMs != null ? (isToday(planTimeMs) ? 'today' : dayShort(planTimeMs)) : null

  return (
    <div className={`tripbuilder glass ${raised ? 'tb-raised' : 'tb-home'}`} {...swipe}>
      {grab}
      <div className="dock-head">
        <span className="who">{subjectName}</span>
        <StandingFacts lon={subject.lon} lat={subject.lat} />
        {planDay && <span className="head-day">{planDay}</span>}
        {destination && runMin != null && <span className="meta numeral">≈{runMin} min</span>}
        {stormMs != null && (
          // thunder is the one thing allowed to be loud — amber, never the
          // red that belongs to issued warnings (§1.3)
          <span className="storm-chip numeral">⚡ {hourShort(stormMs)}</span>
        )}
        {destination && (
          <>
            <SpeedChip />
            <button className="icon-btn head-x" onClick={clearSubject} aria-label="Clear the trip">
              <IconClose size={14} />
            </button>
          </>
        )}
      </div>
      {raised ? (
        <div className="tb-scroll">
          {destination && <FromRow />}
          {destination?.name != null && (
            // the hand-written exposure note — content, not chrome, and the
            // one sentence the interface allows itself (§1.5)
            <SpotNote name={destination.name} />
          )}
          {destination && <RunDetail />}
        </div>
      ) : (
        destination && <PlanBlock />
      )}
    </div>
  )
}

/** The water you'd swim in at the subject, off the cached grid — it simply
 *  sits out until the grid lands. Sunset lives on the Places sheet's Here
 *  row now, with the rest of the standing-here facts. */
function StandingFacts({ lon, lat }: { lon: number; lat: number }) {
  const water = gridConditionsAt(lon, lat, Date.now())?.waterTempC ?? null
  if (water == null) return null
  return <span className="meta numeral">water {Math.round(water)}°</span>
}

/**
 * Where the run starts FROM, at L2.
 *
 * The dock's subject is the far end; this is the near one, and it had no
 * home on any surface. The plan quietly used your position, or the home base
 * when you're ashore, and nothing said which — nor offered a way to say
 * otherwise without going through the map's start pin.
 *
 * A chip row, the same swipeable line every other question here gets, so the
 * places run left and right under a thumb. "Here" is the boat and leads,
 * because most runs start where you float; it reads "Home base" when that's
 * what the plan actually fell back to, so the chip never claims to be your
 * position while standing in for it.
 */
function FromRow() {
  const startPoint = useRouteStore((s) => s.startPoint)
  const setStartPoint = useRouteStore((s) => s.setStartPoint)
  const destination = useRouteStore((s) => s.destination)
  const startFrom = useRouteStore((s) => s.startFrom)
  // routing from the destination to itself is not a run
  const places = allPlaces().filter((p) => p.name !== destination?.name)
  return (
    <div className="from-row">
      <span className="from-label">From</span>
      <div className="tb-chips">
        <button
          className={`dest-chip ${startPoint == null ? 'on' : ''}`}
          onClick={() => setStartPoint(null)}
        >
          {startFrom === 'home' ? 'Home base' : 'Here'}
        </button>
        {places.map((p) => (
          <button
            key={p.name}
            className={`dest-chip ${startPoint?.name === p.name ? 'on' : ''}`}
            onClick={() => setStartPoint({ name: p.name, lon: p.lon, lat: p.lat })}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The spot's hand-written exposure note, at L2 only — the user's own
 *  wording (Places sheet, Edit) wins over the config's. */
function SpotNote({ name }: { name: string }) {
  const note = noteFor(name)
  if (!note) return null
  return <div className="spot-note-l2">{note}</div>
}

/**
 * The trip window: when you leave, when you want to be back, and — falling
 * out of those two — how long you get there.
 *
 * Tapping a chip arms it; the outlook strip's hour cells then become its
 * keypad, and only the hours that would still make a window are offered. The
 * numbers stay readable the whole time, which is what a pair of ± nudgers
 * never managed.
 */
function WindowChips() {
  const planTimeMs = useAppStore((s) => s.planTimeMs)
  const planEndMs = useAppStore((s) => s.planEndMs)
  const armedEnd = useAppStore((s) => s.armedEnd)
  const setArmedEnd = useAppStore((s) => s.setArmedEnd)
  const plan = useRouteStore((s) => s.plan)
  const route = useRouteStore((s) => s.route)
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const roundTrip = useRouteStore((s) => s.roundTrip)

  // What you ASKED for wins over what the last plan worked out: these chips
  // are controls, and a control that lags the tap by a replan feels broken.
  const outMs = planTimeMs ?? plan?.departMs ?? floorHourMs()
  const backMs = planEndMs ?? plan?.homeMs ?? null

  // time there is the window minus the running — never a setting of its own
  const legMin = route ? (route.distanceNm / cruiseKn) * 60 : null
  const thereMin =
    backMs != null && legMin != null
      ? Math.round((backMs - outMs) / 60_000 - (roundTrip ? 2 : 1) * legMin)
      : null
  const tooTight = thereMin != null && thereMin < 0

  return (
    <div className="win-chips">
      <button
        className={`win-chip ${armedEnd === 'out' ? 'win-armed' : ''}`}
        onClick={() => setArmedEnd(armedEnd === 'out' ? null : 'out')}
        aria-label={`Leaving ${dayTimeLabel(outMs)} — tap, then pick an hour on the strip`}
      >
        <span className="win-k">Out</span>
        <span className="win-v numeral">{dayTimeLabel(outMs)}</span>
      </button>

      <span className={`win-mid ${tooTight ? 'win-tight' : ''}`}>
        {thereMin == null ? (
          <span className="win-k">there</span>
        ) : tooTight ? (
          <>
            <span className="win-k">too tight</span>
            <b className="numeral">{durationLabel(-thereMin)} short</b>
          </>
        ) : (
          <>
            <span className="win-k">there</span>
            <b className="numeral">{durationLabel(thereMin)}</b>
          </>
        )}
      </span>

      <button
        className={`win-chip ${armedEnd === 'back' ? 'win-armed' : ''}`}
        onClick={() => setArmedEnd(armedEnd === 'back' ? null : 'back')}
        disabled={!roundTrip}
        aria-label={
          backMs == null
            ? 'Set when you want to be back'
            : `Back ${dayTimeLabel(backMs)} — tap, then pick an hour on the strip`
        }
      >
        <span className="win-k">{roundTrip ? 'Back' : 'Arrive by'}</span>
        <span className="win-v numeral">{backMs == null ? '—' : dayTimeLabel(backMs)}</span>
      </button>
    </div>
  )
}

/** Cruise speed: your boat's, stored, with an inline stepper for the days it
 *  isn't. Opens in place on the card — never a popover over the chart. */
function SpeedChip() {
  const cruiseKn = useRouteStore((s) => s.cruiseKn)
  const setCruiseKn = useRouteStore((s) => s.setCruiseKn)
  const speedUnit = useAppStore((s) => s.speedUnit)
  const [open, setOpen] = useState(false)

  const shown = Math.round(knToUnit(speedUnit, cruiseKn))
  const step = (d: number) => setCruiseKn(unitToKn(speedUnit, shown + d))

  if (!open) {
    return (
      <button className="speed-chip" onClick={() => setOpen(true)} aria-label="Cruise speed">
        <span className="numeral">{shown}</span> {speedUnitLabel(speedUnit)}
      </button>
    )
  }
  return (
    <span className="speed-step">
      <button className="nudge" onClick={() => step(-1)} aria-label="Slower">
        <IconMinus size={11} />
      </button>
      <b className="numeral">
        {shown} {speedUnitLabel(speedUnit)}
      </b>
      <button className="nudge" onClick={() => step(1)} aria-label="Faster">
        <IconPlus size={11} />
      </button>
      <button className="linklike" onClick={() => setOpen(false)}>
        done
      </button>
    </span>
  )
}

/**
 * The live leg: time left, arrival, and the far end.
 *
 * Three sizes for three jobs. Time left dominates because it's the only
 * number that works at the wheel; the arrival sits under it in the same
 * glance because it's what you tell the people waiting; the far end lives
 * below a divider because it's context, not something you steer by.
 *
 * The clock ticks once a minute — a figure that changes while you're looking
 * at it is worse than one slightly stale.
 */
function LiveLeg({
  destLabel,
  onOpen,
  onHide,
}: {
  destLabel: string
  onOpen: () => void
  onHide: () => void
}) {
  const plan = useRouteStore((s) => s.plan)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const leg = legReadout(plan)
  const ready = leg != null && leg.timeLeftMin != null
  const ashore = ready && leg.phase === 'ashore'
  const heading = !ready
    ? destLabel
    : ashore
      ? 'Ashore'
      : leg.phase === 'homeward'
        ? 'To the ramp'
        : `To ${destLabel}`
  const arriveKey = ashore ? 'push off' : leg?.phase === 'homeward' ? 'home' : 'there'

  return (
    <>
      <div className="leg-head">
        <span className="leg-title">{heading}</span>
        <button className="leg-end" onClick={() => endTrip()}>
          End
        </button>
        <button className="icon-btn" onClick={onHide} aria-label="Hide trip card">
          <IconClose size={16} />
        </button>
      </div>

      {!ready ? (
        <div className="leg-body">
          <span className="numeral">…</span>
        </div>
      ) : (
        <button className="leg-body" onClick={onOpen} aria-label={heading}>
          <span className="leg-main">
            <span
              className={`leg-big numeral ${leg.driftMin != null && leg.driftMin > 0 ? 'leg-late' : ''}`}
            >
              {durationLabel(leg.timeLeftMin!)}
              <small> left</small>
            </span>
            <span className="leg-arr">
              <span className="leg-k">{arriveKey}</span>
              <span
                className={`leg-v numeral ${leg.driftMin != null && leg.driftMin > 0 ? 'leg-late' : ''}`}
              >
                {timeLabel(leg.arriveMs!)}
                {leg.driftMin != null && (
                  // early is not a problem, so it doesn't wear the warning colour
                  <em className={`leg-drift ${leg.driftMin < 0 ? 'leg-early' : ''}`}>
                    {leg.driftMin > 0 ? '+' : ''}
                    {leg.driftMin}
                  </em>
                )}
              </span>
            </span>
          </span>

          {leg.phase !== 'homeward' && leg.homeMs != null && (
            <span className="leg-far">
              <span className="leg-k">home</span>
              <span className="leg-v numeral">{timeLabel(leg.homeMs)}</span>
              {leg.ashoreMin != null && leg.ashoreMin > 0 && (
                <span className="leg-far-note numeral">· {durationLabel(leg.ashoreMin)} ashore</span>
              )}
            </span>
          )}

          {leg.atCruise && <span className="leg-note leg-dim">at cruise</span>}
        </button>
      )}
    </>
  )
}
