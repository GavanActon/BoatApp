import { HOME, REGION_BBOX } from '../config'
import { useAppStore } from '../state/appStore'
import { startRecording, stopRecording } from '../tracking/gpsService'
import { useGpsStore } from '../tracking/gpsStore'
import { computeRoute } from './router'
import { useRouteStore } from './routeStore'
import { planTrip, type TripPlan } from './tripPlan'
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
const DEFAULT_DEPART_H = 10 // no departure picked = "we leave at 10"

let replanToken = 0
let suggestedFor: string | null = null // destination we already auto-suggested a departure for

/** The house default departure — 10 am on the day of `ms`. */
function defaultDepartMs(ms: number): number {
  const d = new Date(ms)
  d.setHours(DEFAULT_DEPART_H, 0, 0, 0)
  return d.getTime()
}

/**
 * First impressions assume the house habit: no departure chosen means "we
 * leave at 10", so adopt today's 10 am while it's still ahead and inside a
 * go window. Failing that, lead with the best time, not a warning: if right
 * now is either not good or not a sanctioned departure at all (late evening,
 * past back-by), adopt the week's best option — departing at 10 when that
 * day's window covers it. One-shot per destination — after that the user's
 * chosen time is always respected.
 */
function maybeSuggestDeparture(plan: TripPlan) {
  const rs = useRouteStore.getState()
  if (rs.tripStartedAt != null || !rs.destination || plan.days.length === 0) return
  const key = `${rs.destination.lon},${rs.destination.lat}`
  if (suggestedFor === key) return
  suggestedFor = key
  if (useAppStore.getState().planTimeMs != null) return // a time was already picked

  const now = Date.now()
  const all = plan.days.flatMap((d) => d.options)

  const todayTen = defaultDepartMs(now)
  if (todayTen > now) {
    const win = all.find(
      (o) => o.verdict === 'go' && o.windowStartMs <= todayTen && todayTen <= o.windowEndMs,
    )
    if (win) {
      useAppStore.getState().setPlanTime(todayTen)
      // an option's stay was maximized for its own departure hour — only
      // adopt it when that hour is 10 itself
      if (win.departMs === todayTen) useRouteStore.getState().setPlannedStay(win.stayMin)
      return
    }
  }

  const sanctioned = all.some((o) => o.windowStartMs <= now && now <= o.windowEndMs + 3_599_000)
  if (plan.verdict === 'go' && sanctioned) return // leaving now IS the best answer

  const future = all.filter((o) => o.departMs > now)
  const pick = future.find((o) => o.verdict === 'go') ?? (sanctioned ? undefined : future[0])
  if (!pick) return
  const ten = defaultDepartMs(pick.departMs)
  if (ten !== pick.departMs && ten > now && pick.windowStartMs <= ten && ten <= pick.windowEndMs) {
    // that day's window covers the house 10 am — leave then, stay left at
    // the minimum (the option's stay only fit its own departure hour)
    useAppStore.getState().setPlanTime(ten)
    return
  }
  useAppStore.getState().setPlanTime(pick.departMs)
  useRouteStore.getState().setPlannedStay(pick.stayMin)
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
    suggestedFor = null // next destination gets a fresh suggestion
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
    const plan = await planTrip(result, {
      cruiseKn: s.cruiseKn,
      // the app-wide planning time is the departure; under way it's always "now"
      departMs: underWay ? Date.now() : (useAppStore.getState().planTimeMs ?? Date.now()),
      roundTrip,
      // the timeline uses the option-adopted stay when there is one, else the minimum
      stayMin: s.plannedStayMin ?? s.stayMin,
      destName,
      windUnit: useAppStore.getState().windUnit,
      // under way, the trip is re-timed often but the forecast holds for 30 min
      maxWxCacheMs: underWay ? TRIP_WX_REFRESH_MS : PLAN_WX_CACHE_MS,
      windows: !underWay,
      minStayMin: s.stayMin,
      backByHour: s.backByHour,
    })
    if (token !== replanToken) return
    useRouteStore.getState().setPlan(plan)
    maybeSuggestDeparture(plan)
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
  const sp = useRouteStore.getState().startPoint
  // the ride home aims for the actual cast-off spot; without a fix, the
  // chosen start point beats the home-waters default
  const origin: [number, number] =
    fix && inRegion(fix.lon, fix.lat)
      ? [fix.lon, fix.lat]
      : sp
        ? [sp.lon, sp.lat]
        : HOME.center
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
      s.startPoint !== prev.startPoint ||
      s.viaPoints !== prev.viaPoints ||
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
    if (!useRouteStore.getState().destination) return
    if (s.planTimeMs !== prev.planTimeMs) void replan()
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
