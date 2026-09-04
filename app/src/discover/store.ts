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
  | 'unitsSeen'
  | 'scale'
  | 'planTime'
  | 'backBy'
  | 'via'
  | 'helm'
  | 'lowPower'
  | 'rename'
  | 'newRoute'
  | 'placesRoute'
  | 'installed'
  | 'tripStart'
  | 'invited'
  | 'shared'
  | 'planShared'

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

/** A friend, and when: met on the water, or joined you where you were. */
export interface CrewMoment {
  name: string
  at: number
}

/** The crew was already there when you arrived. */
export interface LateFor {
  names: string[]
  where: string
  at: number
}

const MOMENTS_MAX = 30

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** One moment per friend per day, newest last, capped. */
function addMoment(list: CrewMoment[], m: CrewMoment): CrewMoment[] | null {
  if (list.some((x) => x.name === m.name && sameDay(x.at, m.at))) return null
  return [...list, m].slice(-MOMENTS_MAX)
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
  /** Friends met on the water, within arrival range of the boat. */
  meets: CrewMoment[]
  /** Friends who arrived where this boat already was. */
  hosted: CrewMoment[]
  /** The first time two or more of the crew were there ahead of you. */
  lateFor: LateFor | null
  /** Where the sheet should open next time: the welcome card's Get set up
   *  lands on the levels, First voyage unfolded. Consumed on open. Transient. */
  entry: 'setup' | null
  /** Later on the welcome card: a "Set up · N left" chip beside the glyph
   *  until the sheet is opened once. Transient — the glyph's own mark is
   *  what persists, by being computed. */
  nudge: boolean
  /** A row sent you to a control that lives in another sheet: that sheet
   *  lands on the control (`target` names it, for a beat of highlight) and
   *  closing it brings you back here (`returnTo`). Transient. */
  target: 'cruise' | 'units' | null
  returnTo: boolean
  /** The chapter the row was in, so the round trip lands back on it. */
  entryChapter: string | null
  /** When the last level was reached — the glyph glows for a beat after.
   *  Transient: a reload should not replay it. */
  glow: number

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
  addMeet: (name: string, at: number) => void
  addHosted: (name: string, at: number) => void
  setLateFor: (l: LateFor) => void
  setEntry: (e: 'setup' | null) => void
  setNudge: (v: boolean) => void
  setTarget: (t: 'cruise' | 'units' | null) => void
  setReturnTo: (v: boolean) => void
  setEntryChapter: (c: string | null) => void
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
      meets: [],
      hosted: [],
      lateFor: null,
      level: 0,
      entry: null,
      setEntry: (entry) => set({ entry }),
      nudge: false,
      setNudge: (nudge) => set({ nudge }),
      target: null,
      setTarget: (target) => set({ target }),
      returnTo: false,
      setReturnTo: (returnTo) => set({ returnTo }),
      entryChapter: null,
      setEntryChapter: (entryChapter) => set({ entryChapter }),
      glow: 0,

      levelUp: (level) =>
        set((s) => {
          if (level <= s.level) return { level: Math.max(level, s.level) }
          return { level, queue: [...s.queue, `level:${level}`], glow: Date.now() }
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
      addMeet: (name, at) =>
        set((s) => {
          const meets = addMoment(s.meets, { name, at })
          return meets ? { meets } : {}
        }),
      addHosted: (name, at) =>
        set((s) => {
          const hosted = addMoment(s.hosted, { name, at })
          return hosted ? { hosted } : {}
        }),
      // the first time stands
      setLateFor: (lateFor) => set((s) => (s.lateFor ? {} : { lateFor })),
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
        meets: s.meets,
        hosted: s.hosted,
        lateFor: s.lateFor,
        level: s.level,
      }),
    },
  ),
)
