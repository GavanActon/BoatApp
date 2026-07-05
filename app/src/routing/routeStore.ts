import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

  // "tap the map to set destination" mode
  picking: boolean
  setPicking: (v: boolean) => void

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
      destination: null,
      // one trip at a time: a new destination replaces the old trip wholesale,
      // including the focused strip dot and any adopted stay time
      setDestination: (destination) =>
        set({ destination, picking: false, focusPoint: null, expandedIdx: null, plannedStayMin: null }),
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
      backByHour: 20, // home by 8 pm unless told otherwise
      setBackBy: (backByHour) => set({ backByHour }),

      picking: false,
      setPicking: (picking) => set({ picking }),

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
        tripStartedAt: s.tripStartedAt,
        tripOrigin: s.tripOrigin,
      }),
    },
  ),
)
