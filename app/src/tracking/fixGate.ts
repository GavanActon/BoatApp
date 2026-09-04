/**
 * The fix gate: what a position has to be before the boat is moved, the
 * track takes it, or the crew hears it.
 *
 * Core Location is not a clean stream. Back from the lock screen it hands
 * out a cached or cell-derived position before the chip has a fresh one;
 * under a windscreen or along a cliff a reflected signal lands a fix a few
 * hundred metres out for a second; a queued fix can arrive after a newer
 * one. Each of those drew a spike into a friend's track. So a fix is
 * judged against the last one kept: a coarse one is dropped, an older one
 * is dropped, and one the boat could not have reached is held back —
 * unless the next fix lands beside it, in which case the boat really did
 * go there (a long suspend, a fast run) and both are kept.
 *
 * Dependency-free on purpose: this file is checked by a plain Node test.
 */

export interface GateFix {
  lon: number
  lat: number
  accuracy: number
  ts: number
}

export type Verdict = 'good' | 'coarse' | 'stale' | 'jump'

/** A reported accuracy worse than this is not a position, it is a guess. */
export const MAX_ACCURACY_M = 50
/** Faster than any boat on this lake; the margin a jump is judged against. */
export const MAX_SPEED_KN = 60
/** A held fix is confirmed by the next one landing within this of it. */
const CONFIRM_M = 150

const MAX_SPEED_MS = (MAX_SPEED_KN * 1852) / 3600

export interface GateState<F extends GateFix = GateFix> {
  /** The last fix kept. */
  last: F | null
  /** A fix that jumped; kept aside until the next one agrees or not. */
  suspect: F | null
  dropped: Record<Exclude<Verdict, 'good'>, number>
}

export function newGate<F extends GateFix>(): GateState<F> {
  return { last: null, suspect: null, dropped: { coarse: 0, stale: 0, jump: 0 } }
}

export function metresBetween(a: GateFix, b: GateFix): number {
  const R = 6371000
  const toR = Math.PI / 180
  const dLat = (b.lat - a.lat) * toR
  const dLon = (b.lon - a.lon) * toR
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Judge one fix. `keep` is what to use, in order — usually the fix itself,
 * nothing for a dropped one, and two when a held fix is confirmed. The
 * state is updated in place.
 */
export function judge<F extends GateFix>(fix: F, g: GateState<F>): { verdict: Verdict; keep: F[] } {
  if (!Number.isFinite(fix.accuracy) || fix.accuracy > MAX_ACCURACY_M) {
    g.dropped.coarse++
    return { verdict: 'coarse', keep: [] }
  }
  const last = g.last
  if (last && fix.ts <= last.ts) {
    g.dropped.stale++
    return { verdict: 'stale', keep: [] }
  }
  if (last) {
    const d = metresBetween(last, fix)
    const dt = (fix.ts - last.ts) / 1000
    const reach = last.accuracy + fix.accuracy + MAX_SPEED_MS * dt
    if (d > reach) {
      const s = g.suspect
      if (s && metresBetween(s, fix) <= CONFIRM_M) {
        // the boat really is over there: the held fix and this one both count
        g.suspect = null
        g.last = fix
        return { verdict: 'good', keep: [s, fix] }
      }
      g.suspect = fix
      g.dropped.jump++
      return { verdict: 'jump', keep: [] }
    }
  }
  // a plain fix beside the last: whatever was held was a blip
  g.suspect = null
  g.last = fix
  return { verdict: 'good', keep: [fix] }
}
