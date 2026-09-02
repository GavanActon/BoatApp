import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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
  backByHour: number | null // latest hour-of-day to be home / off the water; null = no limit
  setBackBy: (h: number | null) => void

  // Route editing is a MODE. Without it, a press anywhere on the line — a
  // 26 px-wide hit target — pulls a fresh course point out of the course, which
  // happens by accident far more often than on purpose. Not persisted: you turn
  // it on to make a change, and it doesn't outlive the session.
  editing: boolean
  setEditing: (v: boolean) => void

  // "tap the map to set…" mode — what the next map tap places
  picking: 'dest' | 'start' | null
  setPicking: (v: 'dest' | 'start' | null) => void

  // the map-facing trip card — the trip's home on the nav screen. 'trip' is
  // the planned/under-way card docked over the map; null = dismissed (the top
  // chip stands in). With no destination the dock always shows the home card
  // regardless — there is no separate chooser to be in any more (§2.3).
  card: 'trip' | null
  setCard: (v: 'trip' | null) => void

  // trip under way (persisted so an iOS PWA reload mid-trip resumes monitoring)
  tripStartedAt: number | null
  tripOrigin: [number, number] | null // where the boat left from, for the ride home
  /** When the boat first came within arrival range of the destination this
   *  trip. LATCHED — measured fresh each tick, "arrived" held only within
   *  half a mile of the beach, so the first progress tick of the ride home
   *  flipped the plan back to the destination just left. */
  reachedDestAt: number | null
  setReachedDest: (ms: number) => void
  // What the trip promised as it cast off, so a slipping arrival has something
  // honest to be measured against. See legReadout.capturePromise.
  promisedArriveMs: number | null
  promisedHomeMs: number | null
  startTrip: (origin: [number, number]) => void
  endTrip: () => void

  // Which start the plan actually used, so the card can say so instead of
  // claiming "Here" when the fix was ashore and home waters stood in.
  startFrom: 'pinned' | 'fix' | 'home'
  setStartFrom: (v: 'pinned' | 'fix' | 'home') => void

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

/** What actually reaches localStorage — picked off RouteState so partialize
 *  and migrate can't drift apart. */
type PersistedTrip = Pick<
  RouteState,
  | 'roundTrip'
  | 'cruiseKn'
  | 'stayMin'
  | 'backByHour'
  | 'destination'
  | 'viaPoints'
  | 'tripStartedAt'
  | 'tripOrigin'
  | 'reachedDestAt'
  | 'promisedArriveMs'
  | 'promisedHomeMs'
> & { flowV: number }

/**
 * Which generation of the trip FLOW wrote this storage.
 *
 * Not zustand's `version`, and it can't be: zustand only runs `migrate` when
 * the stored version is already a number, so storage written before any
 * version existed is handed straight through and never migrated. That is
 * precisely the storage that needs fixing, so the marker has to live inside
 * the persisted state where `merge` — which always runs — can see it.
 */
const FLOW_V = 1

export const useRouteStore = create<RouteState>()(
  persist(
    (set) => ({
      // No trip out of the box. The app opens on the WATER — what the spots
      // are doing — and a route is what you get once you've picked one of
      // them. Shipping a pre-plotted run to the Sandies answered a question
      // nobody had asked yet. A persisted trip still wins on reload.
      destination: null,
      // one trip at a time: a new destination replaces the old trip wholesale,
      // including course points, the focused strip dot and any adopted stay time
      setDestination: (destination) =>
        set({
          destination,
          viaPoints: [],
          picking: null,
          editing: false, // a new trip is not a course you were part-way through editing
          focusPoint: null,
          reachedDestAt: null, // a fresh destination has not been reached
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
      setRoundTrip: (roundTrip) => set({ roundTrip }),
      cruiseKn: 15,
      // stored in knots; kept fractional so whole-number km/h and mph steps survive
      setCruiseKn: (v) => set({ cruiseKn: Math.min(45, Math.max(4, v)) }),
      // the shortest stay the week-long sweep counts as worth going for; the
      // trip's actual time there comes from the window (appStore.planEndMs)
      stayMin: 90,
      setStayMin: (stayMin) => set({ stayMin }),
      backByHour: 17, // home by 5 pm unless told otherwise
      setBackBy: (backByHour) => set({ backByHour }),

      editing: false,
      setEditing: (editing) => set({ editing }),

      picking: null,
      setPicking: (picking) => set({ picking }),

      // the dock is always present; with no destination it rests on the spots
      card: 'trip',
      setCard: (card) => set({ card }),

      tripStartedAt: null,
      tripOrigin: null,
      reachedDestAt: null,
      setReachedDest: (reachedDestAt) => set({ reachedDestAt }),
      promisedArriveMs: null,
      promisedHomeMs: null,
      startTrip: (tripOrigin) => set({ tripStartedAt: Date.now(), tripOrigin, reachedDestAt: null }),
      endTrip: () =>
        set({
          tripStartedAt: null,
          tripOrigin: null,
          reachedDestAt: null,
          promisedArriveMs: null,
          promisedHomeMs: null,
        }),

      startFrom: 'fix',
      setStartFrom: (startFrom) => set({ startFrom }),

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
      /**
       * v1 moved the app to opening on the spots instead of on a trip.
       *
       * Changing the default wasn't enough: every install from before it has
       * the old shipped trip to the Sandies sitting in its storage, and the
       * merge below faithfully restores any saved destination — so the app
       * kept plotting a route nobody had asked for. That destination was
       * never chosen; it just came with the app. Drop it once.
       *
       * This does also clear a trip somebody genuinely picked, which is worth
       * it: the spots list is the landing state now and any destination is one
       * tap from it.
       */
      version: 1,
      migrate: (persisted) => persisted as PersistedTrip,
      // the trip itself survives reloads (iOS reloads PWAs on app switch);
      // route + plan are recomputed from these on startup
      partialize: (s): PersistedTrip => ({
        flowV: FLOW_V,
        roundTrip: s.roundTrip,
        cruiseKn: s.cruiseKn,
        stayMin: s.stayMin,
        backByHour: s.backByHour,
        destination: s.destination,
        viaPoints: s.viaPoints,
        tripStartedAt: s.tripStartedAt,
        tripOrigin: s.tripOrigin,
        reachedDestAt: s.reachedDestAt,
        promisedArriveMs: s.promisedArriveMs,
        promisedHomeMs: s.promisedHomeMs,
      }),
      // the card isn't persisted: it simply shows whenever a trip came back
      merge: (persisted, current) => {
        const p = persisted as (Partial<PersistedTrip> & { startPoint?: RouteState['startPoint'] }) | undefined
        const merged = { ...current, ...p }
        // The pinned start is a PER-SESSION override, never a saved lifestyle:
        // the durable "trips start here" is the starred home base in Places.
        // Persisting the pin created two homes — a stale "Home" dot that beat
        // the GPS and the star forever, invisibly. Old storage still carries
        // the key, so it is dropped on every load.
        merged.startPoint = null
        if (p && p.flowV !== FLOW_V) {
          // Storage from before the spots-first flow carries the trip to the
          // Sandies that used to ship with the app. It was never chosen — it
          // just came in the box — so restoring it meant every launch plotted
          // a route nobody asked for. Drop it once. A destination the user
          // actually picked is one tap away in the spots list.
          merged.destination = null
          merged.viaPoints = []
        }
        // come back to the trip you had; without one the dock shows the home
        // card anyway — 'trip' just means "not dismissed"
        merged.card = 'trip'
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
  // after setDestination, which clears the previous trip's focus: the strip
  // must describe the place you just chose (§0.2), however it was chosen
  s.setFocusPoint({ lon: t.lon, lat: t.lat, label: t.name })
  if (t.vias?.length) s.setViaPoints(t.vias)
}

// dev-only handle, the same convention as MapView's window.__map — lets the
// verify harness read the live plan, which is never persisted
if (import.meta.env.DEV) {
  ;(window as unknown as { __route?: unknown }).__route = useRouteStore
}
