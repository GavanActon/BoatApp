import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Discover's own state, in its own storage key. Nothing here lives in
 * `sandies-prefs`: delete this folder and the key and the app is exactly
 * as it was.
 */

/** Gestures the app can't tell from a default value — a cruise speed left
 *  at 15 kn looks the same as one set to 15 kn — so the engine notes the
 *  first time each is SEEN to change. */
export type TouchKey =
  | 'cruise'
  | 'units'
  | 'scale'
  | 'planTime'
  | 'backBy'
  | 'via'
  | 'helm'
  | 'lowPower'
  | 'rename'
  | 'newRoute'
  | 'tripStart'

export interface Earned {
  at: number
  /** What happened, as label/value pairs — numbers, never a sentence. */
  facts: [string, string][]
}

/** The trip in progress, as the engine sees it. Persisted so an iOS reload
 *  mid-trip doesn't forget when the boat cast off. */
export interface TripCtx {
  openedAt: number | null
  startedAt: number
  destName: string | null
  destLon: number
  destLat: number
  originLon: number
  originLat: number
  roundTrip: boolean
  plannedNm: number | null
  plannedArriveMs: number | null
  plannedHomeMs: number | null
  arrivedAt: number | null
  leftDestAt: number | null
  homeAt: number | null
  forecastBand: number | null
  feltBand: number | null
  helmHome: boolean
  limitM: number | null
  scaleM: number | null
  /** The outing row this trip writes to, once it exists. */
  outingId: number | null
  /** Achievements earned since cast-off — the arrival card's strip. */
  earnedIds: string[]
}

/** A finished trip whose sea-felt question went unanswered: asked once,
 *  after the fact, until answered or waved off. */
export interface PendingFelt {
  startedAt: number
  destName: string | null
}

/** Unlock moments queue up to this many; the rest wait in the hub with
 *  their fresh outline — an existing install adopting the trial can earn
 *  half a dozen at once, and that is not twenty seconds of toasts. */
const QUEUE_MAX = 3

interface DiscoverState {
  earned: Record<string, Earned>
  /** Earned but not yet looked at in the hub: the done-colour outline. */
  fresh: string[]
  /** Moments waiting to play, oldest first: an achievement id, or
   *  `level:<n>` for a level-up. Not persisted: a reload should not replay
   *  an animation. */
  queue: string[]
  /** The level last seen, so a chunk finishing is noticed exactly once. */
  level: number
  touched: Partial<Record<TouchKey, true>>
  /** Trips planned for a later hour that never started. */
  rainChecks: number
  pendingPlan: { ms: number; name: string | null } | null
  /** Season place id → when it was first reached this year. */
  seasonReached: Record<string, number>
  trip: TripCtx | null
  pendingFelt: PendingFelt | null

  earn: (id: string, facts: [string, string][]) => void
  /** A chunk finished: note the level and queue the moment. */
  levelUp: (level: number) => void
  markSeen: () => void
  shiftQueue: () => void
  touch: (k: TouchKey) => void
  setRainChecks: (n: number) => void
  setPendingPlan: (p: { ms: number; name: string | null } | null) => void
  reachSeason: (id: string, at: number) => void
  setTrip: (t: TripCtx | null) => void
  patchTrip: (p: Partial<TripCtx>) => void
  setPendingFelt: (p: PendingFelt | null) => void
}

export const useDiscoverStore = create<DiscoverState>()(
  persist(
    (set) => ({
      earned: {},
      fresh: [],
      queue: [],
      touched: {},
      rainChecks: 0,
      pendingPlan: null,
      seasonReached: {},
      trip: null,
      pendingFelt: null,
      level: 0,

      levelUp: (level) =>
        set((s) => {
          if (level <= s.level) return { level: Math.max(level, s.level) }
          return { level, queue: [...s.queue, `level:${level}`] }
        }),
      earn: (id, facts) =>
        set((s) => {
          if (s.earned[id]) return {}
          return {
            earned: { ...s.earned, [id]: { at: Date.now(), facts } },
            fresh: [...s.fresh, id],
            queue: s.queue.length < QUEUE_MAX ? [...s.queue, id] : s.queue,
            trip: s.trip ? { ...s.trip, earnedIds: [...s.trip.earnedIds, id] } : s.trip,
          }
        }),
      markSeen: () => set((s) => (s.fresh.length ? { fresh: [] } : {})),
      shiftQueue: () => set((s) => ({ queue: s.queue.slice(1) })),
      touch: (k) => set((s) => (s.touched[k] ? {} : { touched: { ...s.touched, [k]: true } })),
      setRainChecks: (rainChecks) => set({ rainChecks }),
      setPendingPlan: (pendingPlan) => set({ pendingPlan }),
      // first reach of the year stands; a new season starts the flag over
      reachSeason: (id, at) =>
        set((s) => {
          const had = s.seasonReached[id]
          if (had != null && new Date(had).getFullYear() === new Date(at).getFullYear()) return {}
          return { seasonReached: { ...s.seasonReached, [id]: at } }
        }),
      setTrip: (trip) => set({ trip }),
      patchTrip: (p) => set((s) => (s.trip ? { trip: { ...s.trip, ...p } } : {})),
      setPendingFelt: (pendingFelt) => set({ pendingFelt }),
    }),
    {
      name: 'sandies-discover',
      version: 1,
      partialize: (s) => ({
        earned: s.earned,
        fresh: s.fresh,
        touched: s.touched,
        rainChecks: s.rainChecks,
        pendingPlan: s.pendingPlan,
        seasonReached: s.seasonReached,
        trip: s.trip,
        pendingFelt: s.pendingFelt,
        level: s.level,
      }),
    },
  ),
)
