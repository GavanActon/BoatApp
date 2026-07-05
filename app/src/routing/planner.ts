import { HOME, REGION_BBOX } from '../config'
import { useAppStore } from '../state/appStore'
import { startRecording, stopRecording } from '../tracking/gpsService'
import { useGpsStore } from '../tracking/gpsStore'
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

function inRegion(lon: number, lat: number): boolean {
  const b = REGION_BBOX
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
}

/** GPS fix when it's inside the charted region, otherwise home waters. */
function startPoint(): [number, number] {
  const fix = useGpsStore.getState().fix
  return fix && inRegion(fix.lon, fix.lat) ? [fix.lon, fix.lat] : HOME.center
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
  const start = startPoint()

  // round trip + boat has reached the destination → plan the ride home
  let target: [number, number] = [dest.lon, dest.lat]
  let roundTrip = s.roundTrip
  let destName = dest.name
  if (
    underWay &&
    s.roundTrip &&
    s.tripOrigin &&
    haversineNm(start[0], start[1], dest.lon, dest.lat) < ARRIVED_NM
  ) {
    target = s.tripOrigin
    roundTrip = false
    destName = 'Home'
  }

  let result = await computeRoute(start, target)
  if ('error' in result && (start[0] !== HOME.center[0] || start[1] !== HOME.center[1])) {
    // the fix exists but can't reach water (marina slip, on the road, GPS
    // drift ashore) — plan the trip from home waters instead of failing
    result = await computeRoute(HOME.center, target)
  }
  if (token !== replanToken) return
  if ('error' in result) {
    s.setRoute(null, result.error)
    s.setPlan(null)
    return
  }
  s.setRoute(result)
  if (!quiet) {
    s.setPlan(null) // drop the old verdict so stale advice never shows for a new trip
    s.setPlanning(true)
  }

  try {
    const plan = await planTrip(result, {
      cruiseKn: s.cruiseKn,
      // the app-wide planning time is the departure; under way it's always "now"
      departMs: underWay ? Date.now() : (useAppStore.getState().planTimeMs ?? Date.now()),
      roundTrip,
      // the timeline uses the option-adopted stay when there is one, else the minimum
      stayMin: s.plannedStayMin ?? s.stayMin,
      destName,
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
      useRouteStore
        .getState()
        .setPlan(null, 'No forecast available — connect to the internet once to fetch it.')
    }
  }
}

/** Start monitoring: freeze the origin for the ride home, record the track,
 *  and re-time everything from the boat's live position. */
export function startTrip() {
  const fix = useGpsStore.getState().fix
  const origin: [number, number] =
    fix && inRegion(fix.lon, fix.lat) ? [fix.lon, fix.lat] : HOME.center
  useAppStore.getState().setPlanTime(null) // casting off happens now, whatever was planned
  useRouteStore.getState().startTrip(origin)
  if (!useGpsStore.getState().recording) void startRecording()
  void replan()
}

export function endTrip() {
  useRouteStore.getState().endTrip()
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
      s.roundTrip !== prev.roundTrip ||
      s.cruiseKn !== prev.cruiseKn ||
      s.stayMin !== prev.stayMin ||
      s.plannedStayMin !== prev.plannedStayMin ||
      s.backByHour !== prev.backByHour
    ) {
      void replan()
    }
  })

  // the app-wide planning time IS the departure time — replan when it moves
  useAppStore.subscribe((s, prev) => {
    if (s.planTimeMs !== prev.planTimeMs && useRouteStore.getState().destination) void replan()
  })

  // first GPS fix moves the start point from home waters to the boat
  useGpsStore.subscribe((s, prev) => {
    if (s.fix && !prev.fix && useRouteStore.getState().destination) void replan()
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
