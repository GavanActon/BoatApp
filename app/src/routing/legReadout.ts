import { useAppStore } from '../state/appStore'
import { useGpsStore } from '../tracking/gpsStore'
import { useRouteStore } from './routeStore'
import type { TripPlan } from './tripPlan'

/**
 * Time left and arrival, for whichever leg the boat is actually on.
 *
 * Two numbers, because they do different jobs: TIME LEFT is what you read at
 * the wheel without thinking, and ARRIVAL is what you tell the people
 * waiting. Neither substitutes for the other.
 *
 * Once an arrival clock is on screen it will sometimes be wrong, and how that
 * is handled is the whole character of this: the home time is the promise you
 * made when you left, and the time at the destination is the slack. Run slow
 * and the app holds home, shortens ashore, and says so. It never proposes
 * cutting a stay short or opening the throttle — it moves a number and names
 * what moved.
 */

export type LegPhase = 'outbound' | 'ashore' | 'homeward'

export interface LegReadout {
  phase: LegPhase
  /** Minutes until this leg ends. Null when there's nothing to measure with. */
  timeLeftMin: number | null
  /** When this leg ends — arriving, pushing off, or tied up. */
  arriveMs: number | null
  /** Minutes later (+) or earlier (−) than promised. Null when on plan or unknown. */
  driftMin: number | null
  /** The far end: when you get home. Held fixed while there's slack to give. */
  homeMs: number | null
  /** What's left of the time at the destination once the running is paid for. */
  ashoreMin: number | null
  /** True when speed over ground was unusable and planned cruise stood in. */
  atCruise: boolean
  /** Water still to cover on this leg, from the boat's own position. */
  remainingNm: number
}

// don't cry wolf over a wave or two — only call the arrival moved once it has
const DRIFT_THRESHOLD_MIN = 3
const ARRIVED_NM = 0.5

export function legReadout(plan: TripPlan | null): LegReadout | null {
  const rs = useRouteStore.getState()
  if (!plan || rs.tripStartedAt == null) return null

  const avgSog = useGpsStore.getState().avgSogKn
  // Stopped, or no usable fix: fall back to the speed the trip was planned at
  // and say so, rather than dividing by a speed of nearly zero and reporting
  // an arrival some time next week.
  const atCruise = avgSog == null || avgSog < 1
  const speedKn = atCruise ? rs.cruiseKn : avgSog

  const remainingNm = plan.oneWayNm
  const timeLeftMin = Math.max(0, Math.round((remainingNm / speedKn) * 60))
  const now = Date.now()
  const arriveMs = now + timeLeftMin * 60_000

  // the planner flips the plan to the ride home once the boat reaches the far
  // end, so that — not a separate flag — is what says which leg we're on
  const homeward = plan.destName === 'Home'
  const phase: LegPhase = homeward ? 'homeward' : remainingNm < ARRIVED_NM ? 'ashore' : 'outbound'

  const promisedHomeMs = rs.promisedHomeMs
  const promisedArriveMs = rs.promisedArriveMs

  // On the way out the arrival is what can slip; heading home it's the home
  // time itself, because there's no slack left to give.
  const against = homeward ? promisedHomeMs : promisedArriveMs
  const rawDrift = against == null ? null : Math.round((arriveMs - against) / 60_000)
  const driftMin = rawDrift == null || Math.abs(rawDrift) < DRIFT_THRESHOLD_MIN ? null : rawDrift

  // Home stays the promise while there's time at the destination to spend.
  // Only when the running alone would overrun it does the home time move.
  const homeMs = homeward ? arriveMs : (promisedHomeMs ?? plan.homeMs)
  const returnLegMin = (remainingNm / speedKn) * 60
  const ashoreMin =
    homeward || homeMs == null
      ? null
      : Math.round((homeMs - arriveMs) / 60_000 - (rs.roundTrip ? returnLegMin : 0))

  return { phase, timeLeftMin, arriveMs, driftMin, homeMs, ashoreMin, atCruise, remainingNm }
}

/**
 * Capture what the trip promised, so drift has something honest to measure
 * against. Called once, as the boat casts off.
 *
 * The promise is a SHAPE, not a pair of clock times: this long to get there,
 * this long ashore, home after the ride back. It has to be rebased onto the
 * actual cast-off, because casting off at seven on a trip planned for ten
 * doesn't make you nine hours early — it makes you a boat that left at seven.
 * Comparing against the untouched planned clock times produced drifts of
 * eleven hours, which is how this was found.
 */
export function capturePromise() {
  const plan = useRouteStore.getState().plan
  const app = useAppStore.getState()
  if (!plan) {
    useRouteStore.setState({ promisedArriveMs: null, promisedHomeMs: null })
    return
  }
  const castOff = Date.now()
  const outMs = plan.arriveMs - plan.departMs
  // the window's far end is the commitment the skipper actually made; the
  // plan's own homeMs is only this app's arithmetic about it
  const plannedHome = app.planEndMs ?? plan.homeMs
  const totalMs = plannedHome == null ? null : plannedHome - plan.departMs
  useRouteStore.setState({
    promisedArriveMs: castOff + outMs,
    promisedHomeMs: totalMs == null ? null : castOff + totalMs,
  })
}
