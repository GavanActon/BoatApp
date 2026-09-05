import { useGpsStore } from '../tracking/gpsStore'

/**
 * Being there. One rule for every place the boat can arrive at — the trip's
 * destination, a saved place, a season place, home at the end of a round
 * trip — so the card, the planner and the achievements agree on the moment.
 *
 * Half a mile alone was too generous: a boat still on plane half a mile out
 * was told it had arrived — the card flipped, the arrival strip came up —
 * with the beach a minute and a half away (Gavan, 2026-09-04). Now NEARBY
 * counts only once the boat has come off the throttle, and CLOSE counts at
 * any speed, because 280 m is beside the pin however fast you pass it. The
 * pin is often on the sand and the boat anchors off it: that is what the
 * nearby-and-idle half is for.
 */
export const REACH_NM = 0.5
export const CLOSE_NM = 0.15
export const IDLE_KN = 3

export function isThere(distNm: number, sogKn: number | null): boolean {
  if (distNm < CLOSE_NM) return true
  if (distNm >= REACH_NM) return false
  // no speed from this phone: nothing says the boat is still running
  return sogKn == null || sogKn < IDLE_KN
}

/** The speed to judge arrival by: the fix's own, else the rolling average —
 *  which is null once the boat has drifted for the whole window, and null
 *  there means idle, not unknown. */
export function boatSogKn(): number | null {
  const g = useGpsStore.getState()
  return g.fix?.sogKn ?? g.avgSogKn
}
