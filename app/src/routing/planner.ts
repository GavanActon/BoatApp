import { HOME, REGION_BBOX } from '../config'
import { useAppStore } from '../state/appStore'
import { startRecording, stopRecording } from '../tracking/gpsService'
import { resetSogAverage, useGpsStore } from '../tracking/gpsStore'
import { capturePromise } from './legReadout'
import { computeRoute } from './router'
import { useRouteStore } from './routeStore'
import { planTrip } from './tripPlan'
import { haversineNm } from './waterRouter'

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

const IDLE_REFRESH_MS = 15 * 60_000
const TRIP_WX_REFRESH_MS = 30 * 60_000
const PLAN_WX_CACHE_MS = 5 * 60_000 // planning tweaks (time, speed, stay) reuse a recent forecast
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
  const legMin = (nm / s.cruiseKn) * 60
  const spanMin = (s.roundTrip ? 2 : 1) * legMin + stayMin
  app.setPlanWindow(departMs, departMs + Math.round(spanMin) * 60_000)
}

function inRegion(lon: number, lat: number): boolean {
  const b = REGION_BBOX
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
}

/** GPS fix when it's inside the charted region, otherwise home waters. */
function boatPosition(): [number, number] {
  const fix = useGpsStore.getState().fix
  return fix && inRegion(fix.lon, fix.lat) ? [fix.lon, fix.lat] : HOME.center
}

/** Where the trip is planned from: the chosen start point while planning,
 *  the boat's live position once under way. */
function planStart(underWay: boolean): [number, number] {
  const sp = useRouteStore.getState().startPoint
  if (!underWay && sp) return [sp.lon, sp.lat]
  return boatPosition()
}

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
  const start = planStart(underWay)

  // round trip + boat has reached the destination → plan the ride home
  let target: [number, number] = [dest.lon, dest.lat]
  let roundTrip = s.roundTrip
  let destName = dest.name
  let vias = s.viaPoints
  if (
    underWay &&
    s.roundTrip &&
    s.tripOrigin &&
    haversineNm(start[0], start[1], dest.lon, dest.lat) < ARRIVED_NM
  ) {
    target = s.tripOrigin
    roundTrip = false
    destName = 'Home'
    // the ride home retraces the plotted course through the same points
    vias = [...s.viaPoints].reverse()
  }

  let result = await computeRoute(start, target, vias)
  if (
    'error' in result &&
    !fixedStart &&
    (start[0] !== HOME.center[0] || start[1] !== HOME.center[1])
  ) {
    // the fix exists but can't reach water (marina slip, on the road, GPS
    // drift ashore) — plan the trip from home waters instead of failing.
    // A user-chosen start point is never second-guessed like this: the error
    // tells them to move it instead.
    result = await computeRoute(HOME.center, target, vias)
  }
  if (token !== replanToken) return
  if ('error' in result) {
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
    const oneWayMin = (result.distanceNm / s.cruiseKn) * 60
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
      // under way, the trip is re-timed often but the forecast holds for 30 min
      maxWxCacheMs: underWay ? TRIP_WX_REFRESH_MS : PLAN_WX_CACHE_MS,
      windows: !underWay,
      minStayMin: s.stayMin,
      backByHour: s.backByHour,
    })
    if (token !== replanToken) return
    useRouteStore.getState().setPlan(plan)
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
  const fix = useGpsStore.getState().fix
  const sp = useRouteStore.getState().startPoint
  // the ride home aims for the actual cast-off spot; without a fix, the
  // chosen start point beats the home-waters default
  const origin: [number, number] =
    fix && inRegion(fix.lon, fix.lat)
      ? [fix.lon, fix.lat]
      : sp
        ? [sp.lon, sp.lat]
        : HOME.center
  capturePromise() // before the window is cleared — it IS the promise
  useAppStore.getState().setPlanTime(null) // casting off happens now, whatever was planned
  useRouteStore.getState().startTrip(origin)
  if (!useGpsStore.getState().recording) void startRecording()
  void replan()
}

export function endTrip() {
  useRouteStore.getState().endTrip()
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
  }
  const resumed = useRouteStore.getState()
  if (resumed.destination) void replan(resumed.tripStartedAt != null)
  if (resumed.tripStartedAt != null && !useGpsStore.getState().recording) {
    void startRecording()
  }

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

  // under way: quiet progress update every 2 min (weather refetches after
  // 30 min via maxWxCacheMs); just planning: full refresh every 15 min
  setInterval(() => {
    // a chosen departure hour that has arrived flows back into "now"
    const planTime = useAppStore.getState().planTimeMs
    if (planTime != null && planTime <= Date.now()) {
      useAppStore.getState().setPlanTime(null) // triggers a replan via the subscription
    }

    const s = useRouteStore.getState()
    if (!s.destination) return
    if (s.tripStartedAt != null) {
      void replan(true)
    } else if (!s.plan || Date.now() - s.plan.fetchedAt >= IDLE_REFRESH_MS) {
      void replan()
    }
  }, TICK_MS)

  // heal a stale plan when connectivity returns or the app comes back to front
  window.addEventListener('online', () => {
    if (useRouteStore.getState().destination) void replan(true)
  })
  document.addEventListener('visibilitychange', () => {
    const { destination, plan, tripStartedAt } = useRouteStore.getState()
    if (
      document.visibilityState === 'visible' &&
      destination &&
      (!plan || Date.now() - plan.fetchedAt > IDLE_REFRESH_MS)
    ) {
      void replan(tripStartedAt != null)
    }
  })
}
