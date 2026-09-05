import { HOME, REGION_BBOX } from '../config'
import { onFirstIdle, withMap } from '../map/mapController'
import { homeCenter, usePlacesStore } from '../state/placesStore'
import { useAppStore } from '../state/appStore'
import { startRecording, stopRecording } from '../tracking/gpsService'
import { resetSogAverage, useGpsStore } from '../tracking/gpsStore'
import { capturePromise } from './legReadout'
import { computeRoute, ensureNav, isAfloat } from './router'
import { useRouteStore } from './routeStore'
import { planTrip } from './tripPlan'
import { haversineNm, lockDelayMin } from './waterRouter'
import { onWeatherGrid } from '../weather/weatherLayer'
import { track } from '../stats/core'

/**
 * Keeps the planned trip current.
 *
 * Planning: recompute route + weather when inputs change, refresh the
 * forecast every 15 min while the app is open.
 *
 * Under way (trip started): re-time the whole trip from the boat's actual
 * position every couple of minutes — ETAs and the verdict track real
 * progress — while the weather itself is refetched every 30 min. Once the
 * boat reaches the destination of a round trip, the plan flips to the ride
 * home so the verdict answers "are we good to get back".
 */

const TICK_MS = 2 * 60_000
const ARRIVED_NM = 0.5 // within this of the destination = "we're there"
const TRIP_EXPIRY_MS = 12 * 3600_000 // a persisted "under way" older than this is over

let replanToken = 0

/*
 * There used to be a departure auto-suggester here ("no time picked means we
 * leave at 10"), which planted a window the moment a destination landed —
 * so tapping a spot to LOOK at its weather felt like being asked when you
 * were leaving. The rule now: place taps explore, time taps plan. A window
 * exists only once an hour or a day is picked on the strip; until then the
 * plan is computed for "now" purely so the lanes describe leaving now.
 */

/** Take an option from the sweep as a WINDOW: leave then, that long there,
 *  home after the ride back. One call so the two ends can never drift apart. */
export function adoptWindow(departMs: number, stayMin: number | null) {
  const s = useRouteStore.getState()
  const nm = s.route?.distanceNm
  const app = useAppStore.getState()
  if (nm == null || stayMin == null) {
    app.setPlanTime(departMs)
    return
  }
  const legMin = (nm / s.cruiseKn) * 60 + lockDelayMin(s.route)
  const spanMin = (s.roundTrip ? 2 : 1) * legMin + stayMin
  app.setPlanWindow(departMs, departMs + Math.round(spanMin) * 60_000)
}

function inRegion(lon: number, lat: number): boolean {
  const b = REGION_BBOX
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
}

/** GPS fix when the boat is actually ON the water, else the starred home
 *  base. Null when the app genuinely doesn't know where the boat lives —
 *  routing then ASKS instead of guessing from the config.
 *
 *  The region check alone wasn't enough: it passes a fix in the driveway,
 *  and routeOnGrid's 13.4 km snap then slides the start 6-7 km onto the lake
 *  and quotes the whole trip — distance, ETA, weather — from out there. */
function boatPosition(): { at: [number, number] | null; afloat: boolean } {
  const fix = useGpsStore.getState().fix
  if (fix && inRegion(fix.lon, fix.lat) && isAfloat(fix.lon, fix.lat)) {
    return { at: [fix.lon, fix.lat], afloat: true }
  }
  return { at: homeCenter(), afloat: false }
}

/** Where the trip is planned from: the chosen start point while planning,
 *  the boat's live position once under way — and which of the three it was,
 *  so the map can name a fallback instead of leaving it unsaid. */
function planStart(underWay: boolean): {
  at: [number, number] | null
  from: 'pinned' | 'fix' | 'home'
} {
  const sp = useRouteStore.getState().startPoint
  if (!underWay && sp) return { at: [sp.lon, sp.lat], from: 'pinned' }
  const boat = boatPosition()
  return { at: boat.at, from: boat.afloat ? 'fix' : 'home' }
}

/** What routing says when it has a destination but no idea of the departure:
 *  no fix on the water, no start point, no home base. Actionable, not
 *  apologetic — both remedies are one tap away. */
export const NO_START_MSG =
  'Where from? Star a home base in Places (Edit → ★), or set a start point on the map.'

/** Recompute route + trip weather. `quiet` keeps the current verdict visible
 *  while the new one is prepared (used by under-way progress ticks). */
export async function replan(quiet = false): Promise<void> {
  const s = useRouteStore.getState()
  const dest = s.destination
  const token = ++replanToken

  if (!dest) {
    s.setRoute(null)
    s.setPlan(null)
    return
  }

  const underWay = s.tripStartedAt != null
  const fixedStart = !underWay && s.startPoint != null
  await ensureNav() // the on-water test reads the depth grid, which may still be loading
  const started = planStart(underWay)
  const start = started.at
  // recorded BEFORE the no-start bail, so the sentence's from-chip can say
  // "home" truthfully even when there's no home to resolve yet — that empty
  // ⭐ is exactly what invites the one onboarding question
  s.setStartFrom(started.from)
  if (!start) {
    s.setRoute(null, NO_START_MSG)
    s.setPlan(null)
    return
  }

  // round trip + boat has reached the destination → plan the ride home.
  // "Reached" LATCHES at the moment of arrival (reachedDestAt): judged fresh
  // from the boat's position each tick, it held only within half a mile of
  // the beach — the first progress tick of the ride home flipped the target
  // back to the destination just left, and a boat that made it home was
  // re-planned the whole trip out again (found post-trip, 2026-09-01)
  let target: [number, number] = [dest.lon, dest.lat]
  let roundTrip = s.roundTrip
  let destName = dest.name
  let vias = s.viaPoints
  if (underWay && s.roundTrip && s.tripOrigin) {
    const reached =
      s.reachedDestAt != null ||
      haversineNm(start[0], start[1], dest.lon, dest.lat) < ARRIVED_NM
    if (reached && s.reachedDestAt == null) s.setReachedDest(Date.now())
    if (reached) {
      target = s.tripOrigin
      roundTrip = false
      destName = 'Home'
      // the ride home retraces the plotted course through the same points
      vias = [...s.viaPoints].reverse()
    }
  }

  const t0 = performance.now() // how long the router takes on this phone
  let result = await computeRoute(start, target, vias)
  const home = homeCenter()
  if (
    'error' in result &&
    !fixedStart &&
    home &&
    (start[0] !== home[0] || start[1] !== home[1])
  ) {
    // the fix exists but can't reach water (marina slip, on the road, GPS
    // drift ashore) — plan the trip from the home base instead of failing.
    // A user-chosen start point is never second-guessed like this: the error
    // tells them to move it instead.
    result = await computeRoute(home, target, vias)
  }
  if (token !== replanToken) return
  if ('error' in result) {
    if (!quiet) track('route', { ok: false, ms: Math.round(performance.now() - t0) })
    s.setRoute(
      null,
      // with a fixed start and no course points the failure could be either
      // end — say so instead of blaming the destination alone
      fixedStart && vias.length === 0
        ? 'No water route — make sure the start point and destination sit on open water.'
        : result.error,
    )
    s.setPlan(null)
    return
  }
  s.setRoute(result)
  if (!quiet) {
    s.setPlan(null) // drop the old verdict so stale advice never shows for a new trip
    s.setPlanning(true)
  }

  try {
    const app = useAppStore.getState()
    // the app-wide planning time is the departure; under way it's always "now"
    const departMs = underWay ? Date.now() : (app.planTimeMs ?? Date.now())

    // Time at the destination is DERIVED, not set: it's the window you asked
    // for minus the running. Saying "we're out from five to nine" is how
    // anyone actually describes an afternoon; "at least ninety minutes there"
    // never was. Without a window we fall back to the old minimum.
    const oneWayMin = (result.distanceNm / s.cruiseKn) * 60 + lockDelayMin(result)
    const windowMin =
      app.planEndMs != null && app.planEndMs > departMs
        ? (app.planEndMs - departMs) / 60_000
        : null
    const derivedStay =
      windowMin == null ? null : Math.max(0, Math.round(windowMin - (roundTrip ? 2 : 1) * oneWayMin))

    const plan = await planTrip(result, {
      cruiseKn: s.cruiseKn,
      departMs,
      roundTrip,
      stayMin: derivedStay ?? s.stayMin,
      destName,
      windUnit: app.windUnit,
      windows: !underWay,
      minStayMin: s.stayMin,
      backByHour: s.backByHour,
    })
    if (token !== replanToken) return
    useRouteStore.getState().setPlan(plan)
    // the user's own replans, not the two-minute progress ticks under way
    if (!quiet) {
      track('route', { ok: true, ms: Math.round(performance.now() - t0), nm: result.distanceNm, round: roundTrip })
    }
  } catch {
    if (token !== replanToken) return
    if (!quiet) {
      // Every planTrip failure used to flatten to "connect to the internet",
      // which is wrong and unhelpful when the strip above is full of numbers.
      // Say which it was; the UI shows it as a short label, not a sentence.
      useRouteStore.getState().setPlan(null, navigator.onLine ? 'No forecast' : 'Offline')
    }
  }
}

/** Start monitoring: freeze the origin for the ride home, record the track,
 *  and re-time everything from the boat's live position. */
export function startTrip() {
  // under way, nothing should still be listening: the time keypad and any
  // armed place slot stand down with the cast-off
  useAppStore.getState().setArmedEnd(null)
  useAppStore.getState().setArmedSlot(null)
  const fix = useGpsStore.getState().fix
  const sp = useRouteStore.getState().startPoint
  // the ride home aims for the actual cast-off spot; without a fix, the
  // chosen start point beats the home-waters default
  // a trip only starts once a route exists, and a route needed a start —
  // so one of these always answers; config HOME is unreachable insurance
  const origin: [number, number] =
    fix && inRegion(fix.lon, fix.lat)
      ? [fix.lon, fix.lat]
      : sp
        ? [sp.lon, sp.lat]
        : (homeCenter() ?? HOME.center)
  capturePromise() // before the window is cleared — it IS the promise
  useAppStore.getState().setPlanTime(null) // casting off happens now, whatever was planned
  useRouteStore.getState().startTrip(origin)
  // every trip records for the log, unless Settings › Log says not to
  if (useAppStore.getState().recordTrips && !useGpsStore.getState().recording) void startRecording()
  void replan()
}

export function endTrip() {
  useRouteStore.getState().endTrip()
  // trip over = subject dismissed: the same resting state the planning card's
  // ✕ leaves behind. Keeping the destination kept the dock, the route line
  // and the periodic replans alive after the boat was back on the trailer.
  useRouteStore.getState().setDestination(null)
  useAppStore.getState().setPlanPicked(false)
  useAppStore.getState().setDetent('rest')
  resetSogAverage()
  void stopRecording()
  void replan()
}

let inited = false

/** Call once at startup. */
export function initRoutePlanner() {
  // guard against React StrictMode's double effect-run in dev — otherwise the
  // refresh interval and subscriptions are registered twice
  if (inited) return
  inited = true

  // resume a persisted trip after a reload (iOS reloads PWAs on app switch):
  // recompute the route + verdict, and pick track recording back up mid-trip —
  // unless the "under way" flag is from a previous day's outing
  const persisted = useRouteStore.getState()
  if (persisted.tripStartedAt != null && Date.now() - persisted.tripStartedAt > TRIP_EXPIRY_MS) {
    persisted.endTrip()
    persisted.setDestination(null) // yesterday's outing doesn't resume as today's plan
  }
  const resumed = useRouteStore.getState()
  if (resumed.destination) {
    // The route — a nav mask over the whole depth grid, the search, the
    // weather sweep — is a long task, and at launch it used to land in the
    // chart's first frames. It waits for the chart's first settled frame
    // (or a moment, if that never comes), unless a fix or a store change
    // has already asked for it by then.
    const quiet = resumed.tripStartedAt != null
    withMap((map) =>
      onFirstIdle(map, () => {
        if (replanToken === 0 && useRouteStore.getState().destination) void replan(quiet)
      }, 1500),
    )
  }
  if (resumed.tripStartedAt != null && !useGpsStore.getState().recording) {
    void startRecording()
  }

  // starring (or moving) the home base changes where trips depart from —
  // replan, which also clears the "where from?" ask the moment it's answered
  usePlacesStore.subscribe((s, prev) => {
    if (s.homeName !== prev.homeName && useRouteStore.getState().destination) void replan()
  })

  useRouteStore.subscribe((s, prev) => {
    if (
      s.destination !== prev.destination ||
      s.startPoint !== prev.startPoint ||
      s.viaPoints !== prev.viaPoints ||
      s.roundTrip !== prev.roundTrip ||
      s.cruiseKn !== prev.cruiseKn ||
      s.stayMin !== prev.stayMin ||
      s.backByHour !== prev.backByHour
    ) {
      void replan()
    }
  })

  // the app-wide planning time IS the departure time — replan when it moves
  useAppStore.subscribe((s, prev) => {
    if (!useRouteStore.getState().destination) return
    // BOTH ends of the window are trip inputs — the far end decides the time
    // at the destination, so moving it alone still has to re-time the trip
    if (s.planTimeMs !== prev.planTimeMs || s.planEndMs !== prev.planEndMs) void replan()
    // the verdict quotes the wind, so its unit has to reach the headline
    else if (s.windUnit !== prev.windUnit) void replan(true)
  })

  // first GPS fix moves the start from home waters to the boat — unless a
  // fixed start point is set, which doesn't care where the phone is
  useGpsStore.subscribe((s, prev) => {
    const rs = useRouteStore.getState()
    if (s.fix && !prev.fix && rs.destination && (!rs.startPoint || rs.tripStartedAt != null)) {
      void replan(rs.tripStartedAt != null)
    }
  })

  // the plan reads the cached grid, so a fresh grid is a fresh verdict —
  // quietly, the old one stays up while the new one is prepared. This is
  // the only weather-driven replan: the weather clock owns the fetching.
  onWeatherGrid(() => {
    const s = useRouteStore.getState()
    if (s.destination) void replan(true)
  })

  // under way: quiet progress update every 2 min (the boat moved, the trip
  // re-times from where it is now); just planning, the grid listener above
  // is the refresh
  setInterval(() => {
    // a chosen departure hour that has arrived flows back into "now"
    const planTime = useAppStore.getState().planTimeMs
    if (planTime != null && planTime <= Date.now()) {
      useAppStore.getState().setPlanTime(null) // triggers a replan via the subscription
    }

    const s = useRouteStore.getState()
    if (s.destination && s.tripStartedAt != null) void replan(true)
  }, TICK_MS)

  // back to front: re-time from now (the grid's own clock refetches a stale
  // grid on the same visibility tick, and that lands through the listener)
  document.addEventListener('visibilitychange', () => {
    const { destination, tripStartedAt } = useRouteStore.getState()
    if (document.visibilityState === 'visible' && destination) void replan(tripStartedAt != null)
  })
}
