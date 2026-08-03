import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DESTINATIONS } from '../config'
import type { SavedTrip } from '../tracking/db'
import type { RouteResult } from './waterRouter'
import type { TripPlan } from './tripPlan'

export interface Destination {
  name: string | null // null = point picked on the map
  lon: number
  lat: number
}

interface RouteState {
  // trip inputs
  destination: Destination | null
  setDestination: (d: Destination | null) => void
  /** Nudge the pin without resetting the rest of the trip (map drag). */
  moveDestination: (lon: number, lat: number) => void
  // fixed start point (launch ramp, marina); null = current location (GPS / home waters)
  startPoint: Destination | null
  setStartPoint: (p: Destination | null) => void
  /** Nudge the start marker without resetting anything else (map drag). */
  moveStartPoint: (lon: number, lat: number) => void
  // user-placed course points the route is steered through, in travel order
  viaPoints: [number, number][]
  setViaPoints: (pts: [number, number][]) => void
  insertVia: (idx: number, pt: [number, number]) => void
  moveVia: (idx: number, pt: [number, number]) => void
  removeVia: (idx: number) => void
  roundTrip: boolean
  setRoundTrip: (v: boolean) => void
  cruiseKn: number // planning speed
  setCruiseKn: (v: number) => void
  stayMin: number // MINIMUM time at destination worth going for (round trips)
  setStayMin: (v: number) => void
  plannedStayMin: number | null // stay adopted from a trip option; null = just the minimum
  setPlannedStay: (v: number | null) => void
  backByHour: number | null // latest hour-of-day to be home / off the water; null = no limit
  setBackBy: (h: number | null) => void

  // "tap the map to set…" mode — what the next map tap places
  picking: 'dest' | 'start' | null
  setPicking: (v: 'dest' | 'start' | null) => void

  // the map-facing trip card — the trip's home on the nav screen: 'choose'
  // asks where-from/where-to, 'trip' is the planned/under-way card that stays
  // docked over the map. null = dismissed (the top chip stands in).
  card: 'choose' | 'trip' | null
  setCard: (v: 'choose' | 'trip' | null) => void

  // trip under way (persisted so an iOS PWA reload mid-trip resumes monitoring)
  tripStartedAt: number | null
  tripOrigin: [number, number] | null // where the boat left from, for the ride home
  startTrip: (origin: [number, number]) => void
  endTrip: () => void

  // timeline leg expanded to its full-day forecast (index into plan.samples)
  expandedIdx: number | null
  setExpandedIdx: (i: number | null) => void

  // route dot the top forecast strip is pointed at (one at a time)
  focusPoint: { lon: number; lat: number; label: string } | null
  setFocusPoint: (p: { lon: number; lat: number; label: string } | null) => void

  // computed trip (not persisted)
  route: RouteResult | null
  routeError: string | null
  setRoute: (r: RouteResult | null, error?: string | null) => void
  plan: TripPlan | null
  planError: string | null
  planning: boolean
  setPlan: (p: TripPlan | null, error?: string | null) => void
  setPlanning: (v: boolean) => void
}

export const useRouteStore = create<RouteState>()(
  persist(
    (set) => ({
      // the Sandies out of the box; a persisted trip (or a cleared one) wins on reload
      destination: { ...DESTINATIONS[0] },
      // one trip at a time: a new destination replaces the old trip wholesale,
      // including course points, the focused strip dot and any adopted stay time
      setDestination: (destination) =>
        set({
          destination,
          viaPoints: [],
          picking: null,
          focusPoint: null,
          expandedIdx: null,
          plannedStayMin: null,
        }),
      moveDestination: (lon, lat) =>
        set((s) => (s.destination ? { destination: { ...s.destination, lon, lat } } : {})),
      // the start survives destination changes — where you launch from rarely
      // changes trip to trip
      startPoint: null,
      setStartPoint: (startPoint) => set({ startPoint, picking: null }),
      moveStartPoint: (lon, lat) =>
        set((s) => (s.startPoint ? { startPoint: { ...s.startPoint, lon, lat } } : {})),
      viaPoints: [],
      setViaPoints: (viaPoints) => set({ viaPoints }),
      insertVia: (idx, pt) =>
        set((s) => ({ viaPoints: [...s.viaPoints.slice(0, idx), pt, ...s.viaPoints.slice(idx)] })),
      moveVia: (idx, pt) =>
        set((s) => ({ viaPoints: s.viaPoints.map((p, i) => (i === idx ? pt : p)) })),
      removeVia: (idx) => set((s) => ({ viaPoints: s.viaPoints.filter((_, i) => i !== idx) })),
      roundTrip: true,
      setRoundTrip: (roundTrip) => set({ roundTrip, plannedStayMin: null }),
      cruiseKn: 15,
      // stored in knots; kept fractional so whole-number km/h and mph steps survive
      setCruiseKn: (v) => set({ cruiseKn: Math.min(45, Math.max(4, v)) }),
      stayMin: 90,
      // changing the minimum drops any option-adopted stay
      setStayMin: (stayMin) => set({ stayMin, plannedStayMin: null }),
      plannedStayMin: null,
      setPlannedStay: (plannedStayMin) => set({ plannedStayMin }),
      backByHour: 17, // home by 5 pm unless told otherwise
      setBackBy: (backByHour) => set({ backByHour }),

      picking: null,
      setPicking: (picking) => set({ picking }),

      // the default destination ships with its card showing
      card: 'trip',
      setCard: (card) => set({ card }),

      tripStartedAt: null,
      tripOrigin: null,
      startTrip: (tripOrigin) => set({ tripStartedAt: Date.now(), tripOrigin }),
      endTrip: () => set({ tripStartedAt: null, tripOrigin: null }),

      expandedIdx: null,
      setExpandedIdx: (expandedIdx) => set({ expandedIdx }),

      focusPoint: null,
      setFocusPoint: (focusPoint) => set({ focusPoint }),

      route: null,
      routeError: null,
      setRoute: (route, routeError = null) => set({ route, routeError }),
      plan: null,
      planError: null,
      planning: false,
      setPlan: (plan, planError = null) => set({ plan, planError, planning: false }),
      setPlanning: (planning) => set({ planning }),
    }),
    {
      name: 'sandies-route',
      // the trip itself survives reloads (iOS reloads PWAs on app switch);
      // route + plan are recomputed from these on startup
      partialize: (s) => ({
        roundTrip: s.roundTrip,
        cruiseKn: s.cruiseKn,
        stayMin: s.stayMin,
        plannedStayMin: s.plannedStayMin,
        backByHour: s.backByHour,
        destination: s.destination,
        startPoint: s.startPoint,
        viaPoints: s.viaPoints,
        tripStartedAt: s.tripStartedAt,
        tripOrigin: s.tripOrigin,
      }),
      // the card isn't persisted: it simply shows whenever a trip came back
      merge: (persisted, current) => {
        const p = persisted as Partial<RouteState> | undefined
        const merged = { ...current, ...p }
        merged.card = merged.destination ? 'trip' : null
        return merged
      },
    },
  ),
)

/** Load a saved trip: its settings, its start point and — last, because it
 *  resets course points — its destination, then the saved course back on top.
 *  The saved trip's (possibly renamed) label becomes the trip's name
 *  everywhere: the map chip, the plan headline and the destination marker. */
export function applySavedTrip(t: SavedTrip) {
  const s = useRouteStore.getState()
  s.setRoundTrip(t.roundTrip)
  s.setCruiseKn(t.cruiseKn)
  s.setStayMin(t.stayMin)
  if (t.backBy !== undefined) s.setBackBy(t.backBy)
  s.setStartPoint(t.start ?? null) // trips remember where they launch from
  s.setDestination({ name: t.name, lon: t.lon, lat: t.lat })
  if (t.vias?.length) s.setViaPoints(t.vias)
}
